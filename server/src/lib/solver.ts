import OpenAI from 'openai'
import { getRangesForSpot, POSTFLOP_ORDER } from './ranges'
import { solverBetSizes } from './types'
import type { Setup, StartState, HandHistoryEntry, VillainResponse } from './types'

const SOLVER_URL = process.env.SOLVER_URL ?? 'http://127.0.0.1:3002'

// Created on first use so importing this module (e.g. from unit tests) doesn't
// need a Groq key in the environment.
let _openai: OpenAI | null = null
function openaiClient(): OpenAI {
  return (_openai ??= new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  }))
}

// Groq retired llama-3.3-70b-versatile; override with LLM_MODEL if the default goes away too.
const LLM_MODEL = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b'

// ── Types ────────────────────────────────────────────────────────────────────

interface ActionFreq {
  action: string
  amount?: number
  frequency: number
}

export interface SolverResult {
  actionFrequencies: ActionFreq[]
  sampledAction: string
  sampledAmount?: number
  ev: number
  equity: number
  exploitability: number
}

// ── Core solver call ─────────────────────────────────────────────────────────

export async function callSolver(params: {
  board: string[]
  oopRange: string
  ipRange: string
  pot: number
  effectiveStack: number
  street: string
  streetHistory: { action: string; amount?: number }[]
  actingPlayerHand: string
  actingPlayerIsIP: boolean
  iterations?: number
  betSizes?: string
}): Promise<SolverResult> {
  const res = await fetch(`${SOLVER_URL}/solve`, {
    method: 'POST',
    // Flop solves can take ~1 min in a small Docker VM; a timeout drops us to the LLM fallback
    signal: AbortSignal.timeout(Number(process.env.SOLVER_TIMEOUT_MS ?? 120000)),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board:               params.board,
      oop_range:           params.oopRange,
      ip_range:            params.ipRange,
      pot:                 params.pot,
      effective_stack:     params.effectiveStack,
      street:              params.street,
      street_history:      params.streetHistory.map(h => ({ action: h.action, amount: h.amount ?? null })),
      acting_player_hand:  params.actingPlayerHand,
      acting_player_is_ip: params.actingPlayerIsIP,
      iterations:          params.iterations ?? null,
      bet_sizes:           params.betSizes ?? null,
    }),
  })

  if (!res.ok) throw new Error(`Solver error ${res.status}: ${await res.text()}`)

  const data = await res.json() as {
    action_frequencies: { action: string; amount: number | null; frequency: number }[]
    sampled_action: string
    sampled_amount: number | null
    ev: number
    equity: number
    exploitability: number
  }

  return {
    actionFrequencies: data.action_frequencies.map(a => ({
      action:    a.action,
      amount:    a.amount ?? undefined,
      frequency: a.frequency,
    })),
    sampledAction:  data.sampled_action,
    sampledAmount:  data.sampled_amount ?? undefined,
    ev:             data.ev,
    equity:         data.equity,
    exploitability: data.exploitability,
  }
}

// ── LLM explanation of a GTO action ─────────────────────────────────────────

async function explainVillainAction(
  solver: SolverResult,
  villainPosition: string,
  heroPosition: string,
  board: string[],
  street: string,
  pot: number,
  villainIsIP: boolean
): Promise<string> {
  const freqSummary = solver.actionFrequencies
    .filter(a => a.frequency > 0.01)
    .map(a => `${a.action}${a.amount ? ` ${a.amount}bb` : ''} ${(a.frequency * 100).toFixed(0)}%`)
    .join(', ')

  const action = solver.sampledAction
  const amount = solver.sampledAmount

  const prompt = `You are a concise poker coach. Explain villain's GTO action in 1-2 sentences.

Situation:
- ${street}, board: ${board.join(' ')}, pot: ${pot}bb
- Villain (${villainPosition}) is ${villainIsIP ? 'IP' : 'OOP'}
- Villain equity: ${(solver.equity * 100).toFixed(0)}%, EV: ${solver.ev.toFixed(1)}bb

GTO frequencies: ${freqSummary}
Villain chose: ${action}${amount ? ` ${amount}bb` : ''}

Rules:
- Do NOT mention villain's hole cards
- Explain the WHY: board texture, equity, position, or pot odds
- Be specific, not generic (no "to stay balanced" without a reason)`

  const res = await openaiClient().chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 500,
    // gpt-oss is a reasoning model: without this it spends the whole token budget
    // thinking and the visible explanation gets cut off mid-sentence.
    reasoning_effort: 'low',
  })

  return res.choices[0].message.content?.trim() ?? `${villainPosition} ${action}s`
}

// ── Board helpers ─────────────────────────────────────────────────────────────

export function boardForStreet(
  street: string,
  board: StartState['board']
): string[] {
  if (street === 'Flop')  return board.flop
  if (street === 'Turn')  return [...board.flop, board.turn]
  return [...board.flop, board.turn, board.river]
}

// Actions on the current street only, before a given index
function streetHistoryBefore(
  fullHistory: HandHistoryEntry[],
  street: string,
  beforeIndex: number
): { action: string; amount?: number }[] {
  return fullHistory
    .slice(0, beforeIndex)
    .filter(h => h.street === street)
    .map(h => ({ action: h.action, amount: h.amount }))
}

// ── Street-start pot and stack ───────────────────────────────────────────────
// The solver's tree is rooted at the start of the street and replays the street's
// actions itself, so it must be given the pot and stack as they were when the
// street began — never the mid-street pot the client is displaying. Replaying the
// hand history here (with the same arithmetic as HandTrainer / routes/trainer.ts
// calcPot) makes every caller — villain action, pre-solve, post-hand grading —
// produce the identical (pot, stack) for a spot, which is what the solver's cache
// is keyed on.

export function streetStartPotStack(
  history: HandHistoryEntry[],
  street: string,
  startState: StartState,
  heroPosition: string,
): { pot: number; stack: number } {
  const r1 = (n: number) => Math.round(n * 10) / 10
  const postedBlind = heroPosition === 'BB' ? 1.0 : heroPosition === 'SB' ? 0.5 : 0
  let pot = startState.pot
  let stack = startState.effectiveStack
  let lastHeroBet = 0           // hero's last bet/raise on the street being replayed
  let villainActed = false      // has a villain acted on the street being replayed
  let curStreet = ''
  for (const h of history) {
    if (h.street === street) break
    if (h.street !== curStreet) { curStreet = h.street; lastHeroBet = 0; villainActed = false }
    const amt = h.amount ?? 0
    if (h.actor === 'hero') {
      if (h.action === 'bet' || h.action === 'raise') { pot = r1(pot + amt); stack = r1(stack - amt); lastHeroBet = amt }
      else if (h.action === 'call') {
        pot = r1(pot + amt)
        stack = r1(stack - (h.street === 'Preflop' ? Math.max(0, amt - postedBlind) : amt))
      }
    } else {
      if (h.action === 'bet' || h.action === 'raise') pot = r1(pot + amt)
      else if (h.action === 'call') {
        const bbAlreadyIn = h.street === 'Preflop' && !villainActed ? 1 : 0
        pot = r1(pot + Math.max(0, lastHeroBet - bbAlreadyIn))
      }
      villainActed = true
    }
  }
  return { pot, stack: Math.max(0, stack) }
}

// ── Public: get villain postflop action ───────────────────────────────────────

export async function getVillainActionFromSolver(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  pot: number,
  effectiveStack: number,
  villainIndex: number = 0
): Promise<VillainResponse> {
  const { oopRange, ipRange } = getRangesForSpot(
    setup.position,
    startState.villainPositions,
    startState.heroIsIP,
    startState.heroIsPFR,
    startState.preflopContext,
    startState.holeCards,
  )

  const board = boardForStreet(currentStreet, startState.board)

  // All actions this street up to now (hero just acted — that's the last entry)
  const streetHist = history
    .filter(h => h.street === currentStreet)
    .map(h => ({ action: h.action, amount: h.amount }))

  const villainHand = startState.villainHoleCards[villainIndex] ?? startState.villainHoleCards[0]

  // Determine villain's IP/OOP status from their actual postflop position,
  // not just as the inverse of heroIsIP (which breaks in multiway).
  const heroPostflopIdx    = POSTFLOP_ORDER.indexOf(setup.position)
  const villainPos         = startState.villainPositions[villainIndex] ?? startState.villainPositions[0]
  const villainPostflopIdx = POSTFLOP_ORDER.indexOf(villainPos)
  const villainIsIP        = villainPostflopIdx > heroPostflopIdx

  const streetStart = streetStartPotStack(history, currentStreet, startState, setup.position)
  const raw = await callSolver({
    board,
    oopRange,
    ipRange,
    pot: streetStart.pot,
    effectiveStack: streetStart.stack,
    street: currentStreet,
    streetHistory: streetHist,
    actingPlayerHand: villainHand,
    actingPlayerIsIP: villainIsIP,
    betSizes: solverBetSizes(setup),
  })

  // House rule: an out-of-position villain never leads (donk-bets). First to act
  // it checks; it can still check-raise once hero bets. In-position villains
  // bet when checked to or raise when they have it, per the solver.
  const facingBet = streetHist.some(h => h.action === 'bet' || h.action === 'raise')
  const solver: SolverResult = (!villainIsIP && !facingBet && raw.sampledAction === 'bet')
    ? { ...raw, sampledAction: 'check', sampledAmount: undefined }
    : raw

  const explanation = await explainVillainAction(
    solver,
    startState.villainPositions[villainIndex] ?? startState.villainPositions[0],
    setup.position,
    board,
    currentStreet,
    pot,
    villainIsIP
  )

  // Recompute pot/stack from the sampled action
  const newPot = calcNewPot(pot, solver.sampledAction, solver.sampledAmount, history, currentStreet)
  const newStack = Math.max(0, Math.round((effectiveStack - (solver.sampledAmount ?? 0)) * 10) / 10)

  const isHandOver = solver.sampledAction === 'fold'

  // pot odds hero will face if villain bet/raised
  let potOdds: string | null = null
  if (solver.sampledAction === 'bet' || solver.sampledAction === 'raise') {
    const villainBet = solver.sampledAmount ?? 0
    const ratio = ((newPot - villainBet) / villainBet).toFixed(1)
    potOdds = `${ratio}:1`
  }

  return {
    action:      solver.sampledAction,
    amount:      solver.sampledAmount,
    description: explanation,
    potOdds,
    newPot,
    newStack,
    isHandOver,
  }
}

// ── Pre-solve: warm the solver's cache for a flop we expect to reach ──────────
// Fire-and-forget. The solver service coalesces identical requests, so if the
// client asks for this exact spot while the pre-solve is running it just waits
// for the same job instead of starting a second one.

export function presolveFlop(setup: Setup, startState: StartState, pot: number, effectiveStack: number): void {
  if (!startState.board?.flop?.length) return
  const { oopRange, ipRange } = getRangesForSpot(
    setup.position, startState.villainPositions, startState.heroIsIP, startState.heroIsPFR, startState.preflopContext, startState.holeCards,
  )
  fetch(`${SOLVER_URL}/presolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      board: startState.board.flop, oop_range: oopRange, ip_range: ipRange,
      pot, effective_stack: effectiveStack, street: 'Flop', bet_sizes: solverBetSizes(setup) ?? null,
    }),
  }).catch(err => console.warn('presolve failed (non-fatal):', err?.message ?? err))
}

// ── Public: solver eval for a single hero decision ────────────────────────────

export interface HeroEval {
  street: string
  heroAction: string
  heroAmount?: number
  gtoFrequencies: ActionFreq[]
  heroEquity: number
  heroEv: number
}

export async function evalHeroDecision(
  setup: Setup,
  startState: StartState,
  fullHistory: HandHistoryEntry[],
  decision: HandHistoryEntry,
  decisionIndex: number,
): Promise<HeroEval> {
  const { oopRange, ipRange } = getRangesForSpot(
    setup.position,
    startState.villainPositions,
    startState.heroIsIP,
    startState.heroIsPFR,
    startState.preflopContext,
    startState.holeCards,
  )

  const board = boardForStreet(decision.street, startState.board)
  const streetHist = streetHistoryBefore(fullHistory, decision.street, decisionIndex)
  const { pot, stack } = streetStartPotStack(fullHistory, decision.street, startState, setup.position)

  const solver = await callSolver({
    board,
    oopRange,
    ipRange,
    pot,
    effectiveStack: stack,
    street: decision.street,
    streetHistory: streetHist,
    actingPlayerHand: startState.holeCards,
    actingPlayerIsIP: startState.heroIsIP,
    betSizes: solverBetSizes(setup),
    // No iteration cap: in play this spot is already solved and cached (the villain
    // acted on it), and a cold 20-iteration solve costs as much as a converged one.
  })

  return {
    street:         decision.street,
    heroAction:     decision.action,
    heroAmount:     decision.amount,
    gtoFrequencies: solver.actionFrequencies,
    heroEquity:     solver.equity,
    heroEv:         solver.ev,
  }
}

// ── Pot math helper (mirrors server/routes/trainer.ts calcPot) ────────────────

export function calcNewPot(
  pot: number,
  action: string,
  amount: number | undefined,
  history: HandHistoryEntry[],
  street: string
): number {
  if (action === 'fold' || action === 'check') return pot
  if (action === 'call') {
    const lastVillainBet = [...history].reverse().find(h => h.actor === 'hero' && h.street === street)
    return Math.round((pot + (lastVillainBet?.amount ?? 0)) * 10) / 10
  }
  return Math.round((pot + (amount ?? 0)) * 10) / 10
}
