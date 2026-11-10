import type { ParsedHand, ParsedAction, Street } from './model'
import { STREETS } from './model'
import { assignPositions } from './positions'
import { analyzePreflop, type PreflopLine, COLD_CALL, FOUR_BET_CALL } from './preflop'
import {
  OPEN_RANGES, BB_CALL, BB_CALL_DEFAULT, SB_CALL_BTN, THREE_BET_IP, THREE_BET_OOP,
  CALL_3BET_IP, CALL_3BET_OOP, FOUR_BET_RANGE, POSTFLOP_ORDER, withHandInRange, isHeroInPosition,
} from '../ranges'
import type { Setup, StartState, HandHistoryEntry } from '../types'

export type GradeMode = 'solver_llm' | 'llm_only' | 'preflop_rule' | 'skipped'

/** Everything the grader needs about one imported hand. */
export interface MappedHand {
  gradeMode: GradeMode
  gradeNote: string
  positions: Record<string, string>
  heroPosition?: string
  heroVoluntary: boolean
  heroPfr: boolean
  sawFlop: boolean
  huPostflop: boolean
  playersDealt: number
  netBb: number                       // hero result in bb (won - put in)
  preflop: PreflopLine
  // Postflop pipeline inputs (llm_only and solver_llm)
  setup?: Setup
  startState?: StartState
  history?: HandHistoryEntry[]
  opponentsLine: string[]             // human-readable preflop line for the coach prompt
  spots: SolverSpot[]                 // one per hero postflop decision that the solver can grade
  unsolvedNotes: string[]             // why a postflop decision was not solver-graded
  ranges?: { hero: string; villain: string; heroDesc: string; villainDesc: string }
}

export interface SolverSpot {
  historyIndex: number                // index into MappedHand.history (hero's decision)
  street: Street
  board: string[]
  pot: number                         // street-start pot, bb
  effectiveStack: number              // street-start effective stack, bb
  oopRange: string
  ipRange: string
  heroIsIP: boolean
  streetHistory: { action: string; amount?: number }[]
  betSizes: string                    // e.g. "75%"
  sizingNote?: string
}

const TREE_SIZES = [50, 75, 100]
const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100

/** Chips each player has committed, replayed action by action. */
class Ledger {
  total: Record<string, number> = {}       // whole hand
  street: Record<string, number> = {}      // current street
  dead = 0                                  // antes
  constructor(hand: ParsedHand) {
    for (const p of hand.posts) {
      if (p.kind === 'ante') { this.dead += p.amount; this.add(p.name, p.amount, false) }
      else this.add(p.name, p.amount, true)
    }
  }
  private add(name: string, amt: number, onStreet: boolean) {
    this.total[name] = r2((this.total[name] ?? 0) + amt)
    if (onStreet) this.street[name] = r2((this.street[name] ?? 0) + amt)
  }
  apply(a: ParsedAction) {
    if (a.action === 'call' || a.action === 'bet') this.add(a.name, a.amount ?? 0, true)
    else if (a.action === 'raise') this.add(a.name, Math.max(0, (a.amount ?? 0) - (this.street[a.name] ?? 0)), true)
  }
  newStreet() { this.street = {} }
  pot() { return r2(Object.values(this.total).reduce((s, v) => s + v, 0)) }
}

export function mapHand(hand: ParsedHand): MappedHand {
  const positions = assignPositions(hand)
  const hero = hand.heroName ?? ''
  const preflop = analyzePreflop(hand, positions)
  const heroSeat = hand.seats.find(s => s.name === hero)
  const base: MappedHand = {
    gradeMode: 'skipped', gradeNote: '', positions, heroPosition: positions[hero],
    heroVoluntary: false, heroPfr: false, sawFlop: false, huPostflop: false,
    playersDealt: hand.seats.length, netBb: 0, preflop, opponentsLine: [], spots: [], unsolvedNotes: [],
  }
  if (!heroSeat || !hand.heroCards) return { ...base, gradeNote: 'Hero was not dealt in (or hole cards unknown).' }

  // Hero result: collected minus everything put in, net of uncalled bets returned
  const ledger = new Ledger(hand)
  for (const a of hand.actions) ledger.apply(a)
  const returned = hand.uncalled.filter(u => u.name === hero).reduce((s, u) => s + u.amount, 0)
  base.netBb = r2((hand.collected[hero] ?? 0) - (ledger.total[hero] ?? 0) + returned)

  const heroPre = hand.actions.filter(a => a.street === 'Preflop' && a.name === hero)
  base.heroVoluntary = heroPre.some(a => a.action === 'call' || a.action === 'raise')
  base.heroPfr = heroPre.some(a => a.action === 'raise')
  const heroFoldedPre = heroPre.some(a => a.action === 'fold')
  const inAtFlop = hand.seats.map(s => s.name).filter(n => !preflop.folded.has(n))
  base.sawFlop = !heroFoldedPre && hand.board.length >= 3
  base.huPostflop = base.sawFlop && inAtFlop.length === 2
  base.opponentsLine = describeLine(hand, positions)

  const heroPostflop = hand.actions.filter(a => a.street !== 'Preflop' && a.name === hero)
  if (!base.sawFlop || heroPostflop.length === 0) {
    return { ...base, gradeMode: 'preflop_rule', gradeNote: base.sawFlop ? 'All-in before the flop; only preflop decisions to grade.' : 'Hand ended for hero preflop.' }
  }

  // ── Postflop: pipeline inputs ─────────────────────────────────────────────
  const villains = inAtFlop.filter(n => n !== hero)
  const villainPositions = villains.map(n => positions[n])
  const heroPos = positions[hero]
  const heroIsIP = isHeroInPosition(heroPos, villainPositions)
  const raises = preflop.raisers.length
  const heroIsPFR = preflop.raisers[raises - 1] === hero

  // Pot / stacks at the start of every street
  const streetStart: Partial<Record<Street, { pot: number; stacks: Record<string, number> }>> = {}
  const replay = new Ledger(hand)
  let cur: Street = 'Preflop'
  const snapshot = (st: Street) => {
    const stacks: Record<string, number> = {}
    for (const s of hand.seats) stacks[s.name] = r2(s.stack - (replay.total[s.name] ?? 0))
    streetStart[st] = { pot: replay.pot(), stacks }
  }
  snapshot('Preflop')
  for (const a of hand.actions) {
    if (a.street !== cur) { replay.newStreet(); cur = a.street; snapshot(cur) }
    replay.apply(a)
  }
  for (const st of STREETS.slice(1)) if (!streetStart[st] && hand.board.length >= (st === 'Flop' ? 3 : st === 'Turn' ? 4 : 5)) { replay.newStreet(); snapshot(st) }

  const flopStart = streetStart.Flop!
  const effAtFlop = Math.min(flopStart.stacks[hero], ...villains.map(v => flopStart.stacks[v]))

  // History in the trainer's shape: hero vs "villain" actions, preflop folds omitted
  // Calls are reported as the total called to on that street (how the trainer logs them),
  // not the chips added: a BB calling a 3bb open "calls 3bb".
  const history: HandHistoryEntry[] = []
  const historyIndexOf = new Map<number, number>()
  const calls = new Ledger(hand)
  let callStreet: Street = 'Preflop'
  hand.actions.forEach((a, i) => {
    if (a.street !== callStreet) { calls.newStreet(); callStreet = a.street }
    calls.apply(a)
    if (a.name !== hero && a.action === 'fold' && a.street === 'Preflop') return
    if (a.name !== hero && !inAtFlop.includes(a.name) && a.street !== 'Preflop') return
    historyIndexOf.set(i, history.length)
    const amount = a.action === 'call' ? calls.street[a.name] : a.amount
    history.push({ street: a.street, actor: a.name === hero ? 'hero' : 'villain', action: a.action, amount: amount != null ? r1(amount) : undefined })
  })

  const potType = raises >= 3 ? '4-bet' : raises === 2 ? '3-bet' : raises === 1 ? 'single-raised' : 'limped'
  const effStart = Math.min(heroSeat.stack, ...villains.map(v => hand.seats.find(s => s.name === v)!.stack))
  const setup: Setup = { position: heroPos, isMultiway: villains.length > 1, stackDepth: `${Math.round(effStart)}bb` }
  const startState: StartState = {
    holeCards: hand.heroCards,
    villainHoleCards: villains.map(v => (hand.shown[v]?.length === 2 ? hand.shown[v].join('') : '')),
    villainPositions,
    board: { flop: hand.board.slice(0, 3), turn: hand.board[3] ?? '', river: hand.board[4] ?? '' },
    heroIsIP, heroIsPFR,
    preflopContext: `${potType} pot. ${base.opponentsLine.join(' ')}`,
    pot: r1(flopStart.pot), effectiveStack: r1(effAtFlop),
    preflopRaiseAmount: null, preflopBets: {},
  }
  const out: MappedHand = { ...base, setup, startState, history }

  // ── Solver eligibility ────────────────────────────────────────────────────
  if (villains.length !== 1) {
    return { ...out, gradeMode: 'llm_only', gradeNote: `${villains.length + 1}-way pot after the flop; the solver only models heads-up pots.` }
  }
  const villain = villains[0]
  const rng = rangesFromLine(hand, preflop, positions, hero, villain)
  if (!rng) {
    return { ...out, gradeMode: 'llm_only', gradeNote: `No modelled ranges for this preflop line (${potType} pot${preflop.straddle ? ', straddle' : ''}).` }
  }
  const heroRange = withHandInRange(rng.hero, hand.heroCards)
  out.ranges = { hero: heroRange, villain: rng.villain, heroDesc: rng.heroDesc, villainDesc: rng.villainDesc }
  const oopRange = heroIsIP ? rng.villain : heroRange
  const ipRange = heroIsIP ? heroRange : rng.villain

  for (const st of ['Flop', 'Turn', 'River'] as Street[]) {
    const start = streetStart[st]
    if (!start) continue
    const acts = hand.actions.map((a, i) => ({ a, i })).filter(x => x.a.street === st)
    const eff = Math.min(start.stacks[hero], start.stacks[villain])
    if (eff <= 0) continue
    const firstBet = acts.find(x => x.a.action === 'bet')
    const betPct = firstBet ? (firstBet.a.amount! / start.pot) * 100 : 75
    const tree = TREE_SIZES.reduce((b, s) => Math.abs(s - betPct) < Math.abs(b - betPct) ? s : b, 75)
    const snapErr = firstBet ? Math.abs(betPct - tree) : 0
    const sizingNote = firstBet ? `${firstBet.a.name === hero ? 'You' : 'Villain'} bet ${Math.round(betPct)}% pot on the ${st.toLowerCase()}; graded with a ${tree}% tree.` : undefined
    let tooFar = false
    acts.forEach(({ a, i }, k) => {
      if (a.action === 'bet' && a === firstBet?.a && snapErr > 35) tooFar = true
      if (a.name !== hero) return
      const hIdx = historyIndexOf.get(i)
      if (hIdx == null) return
      if (tooFar) { out.unsolvedNotes.push(`${st}: the ${Math.round(betPct)}% pot bet is too far from any solver size (50/75/100%).`); return }
      out.spots.push({
        historyIndex: hIdx, street: st, board: hand.board.slice(0, st === 'Flop' ? 3 : st === 'Turn' ? 4 : 5),
        pot: r2(start.pot), effectiveStack: r2(eff), oopRange, ipRange, heroIsIP,
        streetHistory: acts.slice(0, k).map(x => ({ action: x.a.action, amount: x.a.action === 'bet' || x.a.action === 'raise' ? x.a.amount : undefined })),
        betSizes: `${tree}%`, sizingNote,
      })
    })
  }
  out.setup!.betSize = out.spots[0]?.betSizes.replace('%', '')
  if (out.spots.length === 0) return { ...out, gradeMode: 'llm_only', gradeNote: out.unsolvedNotes[0] ?? 'No solver-gradable postflop decisions.' }
  return { ...out, gradeMode: 'solver_llm', gradeNote: preflop.straddle ? 'Straddle pot: ranges are approximate.' : '' }
}

/** Preflop ranges for a heads-up postflop pot, from who raised and who called. */
export function rangesFromLine(
  hand: ParsedHand, line: PreflopLine, pos: Record<string, string>, hero: string, villain: string,
): { hero: string; villain: string; heroDesc: string; villainDesc: string } | null {
  const r = line.raisers
  const ip = (a: string, b: string) => POSTFLOP_ORDER.indexOf(pos[a]) > POSTFLOP_ORDER.indexOf(pos[b])
  const rangeOf = (name: string, other: string): [string, string] | null => {
    const p = pos[name]
    if (r.length === 1) {
      if (r[0] === name) return [OPEN_RANGES[p] ?? OPEN_RANGES.CO, `${p} open`]
      if (line.callers[name] !== 'open') return null
      if (p === 'BB') return [BB_CALL[pos[r[0]]] ?? BB_CALL_DEFAULT, `BB defend vs ${pos[r[0]]}`]
      if (p === 'SB') return [SB_CALL_BTN, 'SB flat']
      return [COLD_CALL, `${p} cold-call (approximate)`]
    }
    if (r.length === 2) {
      if (r[1] === name && r[0] === other) return [ip(name, other) ? THREE_BET_IP : THREE_BET_OOP, `${p} 3-bet`]
      if (r[0] === name && r[1] === other && line.callers[name] === '3bet') return [ip(name, other) ? CALL_3BET_IP : CALL_3BET_OOP, `${p} open, call 3-bet`]
      return null
    }
    if (r.length === 3) {
      if (r[2] === name && r[1] === other) return [FOUR_BET_RANGE, `${p} 4-bet`]
      if (r[1] === name && r[2] === other && line.callers[name] === '4bet+') return [FOUR_BET_CALL, `${p} call 4-bet (approximate)`]
      return null
    }
    return null
  }
  const h = rangeOf(hero, villain), v = rangeOf(villain, hero)
  if (!h || !v) return null
  return { hero: h[0], villain: v[0], heroDesc: h[1], villainDesc: v[1] }
}

/** "CO opens to 2.5bb. BTN calls. Hero (BB) calls." */
function describeLine(hand: ParsedHand, pos: Record<string, string>): string[] {
  const hero = hand.heroName
  const who = (n: string) => n === hero ? `Hero (${pos[n]})` : pos[n]
  const out: string[] = []
  const straddle = hand.posts.find(p => p.kind === 'straddle')
  if (straddle) out.push(`${who(straddle.name)} straddles ${r1(straddle.amount)}bb.`)
  let raises = 0
  for (const a of hand.actions) {
    if (a.street !== 'Preflop' || a.action === 'fold' && a.name !== hero) continue
    if (a.action === 'raise') { raises++; out.push(`${who(a.name)} ${raises === 1 ? 'opens' : `${raises + 1}-bets`} to ${r1(a.amount!)}bb.`) }
    else if (a.action === 'call') out.push(`${who(a.name)} ${raises === 0 ? 'limps' : 'calls'}.`)
    else if (a.action === 'check') out.push(`${who(a.name)} checks.`)
    else if (a.action === 'fold') out.push(`${who(a.name)} folds.`)
  }
  return out
}
