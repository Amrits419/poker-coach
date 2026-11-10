import prisma from '../prisma'
import { parseHand } from '../hh/pokerstars'
import { mapHand, type MappedHand } from '../hh/mapper'
import { situationLabel, type PreflopDecision } from '../hh/preflop'
import { callSolver, type HeroEval } from '../solver'
import { analyzeHandWithLLM } from '../openai'
import type { Analysis } from '../types'

// Grades every hand of a session in the background, one at a time: preflop-only
// hands from the range tables (no LLM call), heads-up postflop hands with the solver
// plus one LLM call, multiway hands with the LLM alone. Progress is persisted per
// hand (gradedAt), so a server restart resumes where it stopped.

const running = new Set<string>()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function startGrading(sessionId: string) {
  if (running.has(sessionId)) return
  running.add(sessionId)
  gradeSession(sessionId)
    .catch(async err => {
      console.error(`Session ${sessionId} grading failed:`, err)
      await prisma.session.update({ where: { id: sessionId }, data: { status: 'failed', error: String(err?.message ?? err) } }).catch(() => {})
    })
    .finally(() => running.delete(sessionId))
}

export async function resumeGrading() {
  const pending = await prisma.session.findMany({ where: { status: 'grading' }, select: { id: true } })
  for (const s of pending) startGrading(s.id)
}

const MODE_ORDER: Record<string, number> = { skipped: 0, preflop_rule: 1, solver_llm: 2, llm_only: 3 }

async function gradeSession(sessionId: string) {
  const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })
  const hands = await prisma.recordedHand.findMany({ where: { sessionId, gradedAt: null }, orderBy: { seq: 'asc' } })
  // Cheap hands first so the summary fills in immediately; solver hands before LLM-only ones.
  hands.sort((a, b) => (MODE_ORDER[a.gradeMode] - MODE_ORDER[b.gradeMode]) || a.seq - b.seq)
  for (const h of hands) {
    let update: Record<string, unknown>
    try {
      update = await gradeOne(h.hhText, session.heroName)
    } catch (err) {
      console.warn(`Hand ${h.id} failed to grade:`, err)
      update = { error: String((err as Error)?.message ?? err) }
    }
    await prisma.recordedHand.update({ where: { id: h.id }, data: { ...update, gradedAt: new Date() } })
    await prisma.session.update({ where: { id: sessionId }, data: { handsGraded: { increment: 1 } } })
  }
  await prisma.session.update({ where: { id: sessionId }, data: { status: 'done' } })
}

/** Grade one hand from its hand-history text. Returns the RecordedHand fields to store. */
export async function gradeOne(hhText: string, heroName: string) {
  const parsed = parseHand(hhText, heroName)
  const m = mapHand(parsed)
  if (m.gradeMode === 'skipped') return { analysis: undefined, score: null, mistakes: 0, leaks: [] }

  const preflopDetails = m.preflop.heroDecisions.map(d => ({
    situation: d.situation, label: situationLabel(d.situation), action: d.action, amount: d.amount,
    freqs: d.freqs, verdict: d.verdict, approximate: d.approximate,
  }))

  if (m.gradeMode === 'preflop_rule') {
    const analysis = preflopRuleAnalysis(m, parsed.heroCards!)
    return {
      analysis: analysis as object, score: analysis.score, mistakes: countMistakes(analysis), leaks: analysis.leaks,
      details: { preflop: preflopDetails, solver: [], notes: [m.gradeNote] },
    }
  }

  // Postflop: solver evaluations for each gradable decision (heads-up only)
  const evals: HeroEval[] = []
  const solverDetails: object[] = []
  const notes = [...m.unsolvedNotes]
  for (const spot of m.spots) {
    const decision = m.history![spot.historyIndex]
    try {
      const r = await callSolver({
        board: spot.board, oopRange: spot.oopRange, ipRange: spot.ipRange,
        pot: spot.pot, effectiveStack: spot.effectiveStack, street: spot.street,
        streetHistory: spot.streetHistory, actingPlayerHand: parsed.heroCards!,
        actingPlayerIsIP: spot.heroIsIP, betSizes: spot.betSizes,
      })
      evals.push({ street: spot.street, heroAction: decision.action, heroAmount: decision.amount, gtoFrequencies: r.actionFrequencies, heroEquity: r.equity, heroEv: r.ev })
      const heroFreq = r.actionFrequencies.filter(f => f.action === decision.action).reduce((s, f) => s + f.frequency, 0)
      solverDetails.push({ street: spot.street, heroAction: decision.action, heroAmount: decision.amount, heroFreq, mix: r.actionFrequencies, equity: r.equity, ev: r.ev, tree: spot.betSizes, sizingNote: spot.sizingNote })
      if (spot.sizingNote && !notes.includes(spot.sizingNote)) notes.push(spot.sizingNote)
    } catch (err) {
      notes.push(`${spot.street}: solver unavailable for this decision (${String((err as Error).message).slice(0, 80)}).`)
    }
  }

  if (m.ranges) notes.push(`Assumed preflop ranges: hero = ${m.ranges.heroDesc}; villain = ${m.ranges.villainDesc}.`)
  if (m.gradeMode === 'llm_only') notes.push(`No solver data: ${m.gradeNote}`)
  if (m.gradeNote && m.gradeMode === 'solver_llm') notes.push(m.gradeNote)
  notes.push(`Full preflop line: ${m.opponentsLine.join(' ')}`)
  notes.push('All amounts are in big blinds.')

  const analysis = await withRetry(() => analyzeHandWithLLM(m.setup!, m.startState!, m.history!, evals, {
    preflopFacts: preflopFacts(m), notes,
  }))
  return {
    analysis: analysis as object, score: clampScore(analysis.score), mistakes: countMistakes(analysis), leaks: analysis.leaks ?? [],
    startState: m.startState as object,
    details: { preflop: preflopDetails, solver: solverDetails, notes },
  }
}

function preflopFacts(m: MappedHand): string {
  return m.preflop.heroDecisions.map(d =>
    `- Hero's ${d.situation === 'facing_3bet' ? 'response to the 3-bet' : 'decision'} (${situationLabel(d.situation)}): ${d.explanation} Verdict: ${d.verdict === 'yes' ? 'CORRECT' : d.verdict === 'close' ? 'CLOSE (low frequency)' : 'MISTAKE'}.${d.betterPlay ? ` Better: ${d.betterPlay}` : ''}`,
  ).join('\n') || '- Hero had no preflop decision.'
}

/** Analysis for hands that ended preflop for hero, from range tables only (no LLM). */
function preflopRuleAnalysis(m: MappedHand, heroCards: string): Analysis {
  const ds = m.preflop.heroDecisions
  const cls = handClass(heroCards)
  const fb = ds.map(d => ({
    street: 'Preflop',
    heroAction: d.action === 'raise' && d.amount ? `raise to ${d.amount}bb` : d.action,
    correct: d.verdict,
    explanation: d.explanation,
    betterPlay: d.betterPlay,
  }))
  const bad = ds.filter(d => d.verdict === 'no')
  const leaks = bad.map(d => `${m.heroPosition} ${situationLabel(d.situation)}: ${verbPast(d)} ${cls} — ranges say ${bestAction(d)}`)
  const score = Math.max(0, 100 - 40 * bad.length - 10 * ds.filter(d => d.verdict === 'close').length)
  const summary = bad.length
    ? `The key mistake was ${verbPast(bad[0])} ${cls} from the ${m.heroPosition} (${situationLabel(bad[0].situation)}); the range tables ${bestAction(bad[0])} here.`
    : ds.length ? `Preflop play with ${cls} from the ${m.heroPosition} matches the range tables.` : 'No hero decision this hand.'
  return { summary, streetFeedback: fb, leaks, score, studyPlan: [] }
}

const verbPast = (d: PreflopDecision) => d.action === 'raise' ? 'raising' : d.action === 'call' ? 'calling' : d.action === 'check' ? 'checking' : 'folding'
function bestAction(d: PreflopDecision) {
  const k = (['raise', 'call', 'fold'] as const).reduce((b, x) => d.freqs[x] > d.freqs[b] ? x : b, 'fold' as 'raise' | 'call' | 'fold')
  return k === 'raise' ? 'raise' : k === 'call' ? 'call' : 'fold'
}

/** "AhKd" → "AKo" */
export function handClass(cards: string): string {
  const order = 'AKQJT98765432'
  const [r1, s1, r2, s2] = [cards[0], cards[1], cards[2], cards[3]]
  const [hi, lo] = order.indexOf(r1) <= order.indexOf(r2) ? [r1, r2] : [r2, r1]
  return hi === lo ? `${hi}${lo}` : `${hi}${lo}${s1 === s2 ? 's' : 'o'}`
}

const countMistakes = (a: Analysis) => (a.streetFeedback ?? []).filter(s => s.correct === 'no').length
const clampScore = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() }
    catch (err) {
      const status = (err as { status?: number }).status
      if (i >= attempts || (status && status !== 429 && status < 500)) throw err
      const wait = status === 429 ? 15000 * i : 3000 * i
      console.warn(`LLM call failed (${status ?? 'network'}), retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
}
