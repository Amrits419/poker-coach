import OpenAI from 'openai'
import { getRangesForSpot, isHeroInPosition, type PotType } from './ranges'
import { legalize, optionsFor, heroHasInitiative, type HandState } from './engine'
import { solverBetSizes } from './types'
import type { Setup, StartState, HandHistoryEntry } from './types'

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

export interface ActionFreq {
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

/** Everything the explanation needs. Sent to the client with the villain's action
 *  so the (slow) LLM call can run in the background instead of delaying the hand. */
export interface ExplainContext {
  villainPosition: string
  villainIsIP: boolean
  board: string[]
  street: string
  pot: number
  action: string
  amount?: number
  frequencies: ActionFreq[]
  equity: number
  ev: number
}

export async function explainVillainAction(c: ExplainContext): Promise<string> {
  const freqSummary = c.frequencies
    .filter(a => a.frequency > 0.01)
    .map(a => `${a.action}${a.amount ? ` ${a.amount}bb` : ''} ${(a.frequency * 100).toFixed(0)}%`)
    .join(', ')

  const prompt = `You are a concise poker coach. Explain villain's GTO action in 1-2 sentences.

Situation:
- ${c.street}, board: ${c.board.join(' ')}, pot: ${c.pot}bb
- Villain (${c.villainPosition}) is ${c.villainIsIP ? 'IP' : 'OOP'}
- Villain equity: ${(c.equity * 100).toFixed(0)}%, EV: ${c.ev.toFixed(1)}bb

GTO frequencies: ${freqSummary}
Villain chose: ${c.action}${c.amount ? ` ${c.amount}bb` : ''}

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

  return res.choices[0].message.content?.trim() || plainDescription(c.villainPosition, c.action, c.amount)
}

export function plainDescription(pos: string, action: string, amount?: number): string {
  if (action === 'bet') return `${pos} bets ${amount}bb`
  if (action === 'raise') return `${pos} raises to ${amount}bb`
  if (action === 'call') return `${pos} calls`
  return `${pos} ${action}s`
}

// ── The solver spot for a street ─────────────────────────────────────────────
// The solver's tree is rooted at the start of a street and replays that street's
// actions itself, so it is always given the pot and stack as they were when the
// street began. Every caller — villain action, pre-solve, post-hand grading —
// builds its request here from the engine's replay, so they all produce the same
// cache key for a spot and the flop is only ever solved once.

export interface SolverSpot {
  board: string[]
  oopRange: string
  ipRange: string
  pot: number
  effectiveStack: number
  street: string
  betSizes?: string
  heroIsIP: boolean
  villainIdx: number
}

export function boardForStreet(street: string, board: StartState['board']): string[] {
  if (street === 'Flop')  return board.flop
  if (street === 'Turn')  return [...board.flop, board.turn]
  return [...board.flop, board.turn, board.river]
}

/**
 * Null when the street has no solver spot: it was not reached, it was not heads-up
 * (the solver is two-player), or the pot was limped. A limped pot is 40+ stacks
 * deep with two very wide ranges — a tree that takes over a minute to solve — so
 * those hands are played and coached without the solver.
 */
export function solverSpot(setup: Setup, startState: StartState, state: HandState, street: string): SolverSpot | null {
  const start = state.streetStart[street as keyof HandState['streetStart']]
  if (!start || start.villains.length !== 1 || start.stack <= 0) return null
  const villainIdx = start.villains[0]
  const villainPosition = startState.villainPositions[villainIdx]
  const heroIsIP = isHeroInPosition(setup.position, [villainPosition])

  const raises = state.raisers.length
  if (raises === 0) return null
  const potType: PotType = raises === 1 ? 'srp' : raises === 2 ? '3bet' : '4bet'
  const { oopRange, ipRange } = getRangesForSpot({
    heroPosition: setup.position,
    villainPosition,
    heroIsIP,
    heroIsAggressor: state.raisers[raises - 1] === 'hero',
    potType,
    heroHand: startState.holeCards,
    villainHand: startState.villainHoleCards[villainIdx],
  })

  return {
    board: boardForStreet(street, startState.board),
    oopRange, ipRange,
    pot: start.pot,
    effectiveStack: start.stack,
    street,
    betSizes: solverBetSizes(setup),
    heroIsIP,
    villainIdx,
  }
}

const streetActions = (history: HandHistoryEntry[], street: string) =>
  history.filter(h => h.street === street).map(h => ({ action: h.action, amount: h.amount }))

// ── Villain's postflop action ────────────────────────────────────────────────

export interface VillainDecision {
  action: string
  amount?: number
  description: string
  explain?: ExplainContext   // present when the solver chose the action
}

/** Throws when the spot can't be solved (multiway, solver down): the caller falls back to the LLM. */
export async function getVillainActionFromSolver(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  state: HandState,
  villainIdx: number,
): Promise<VillainDecision> {
  const spot = solverSpot(setup, startState, state, state.street)
  if (!spot || spot.villainIdx !== villainIdx) throw new Error('not a heads-up solver spot')

  const villainIsIP = !spot.heroIsIP
  const streetHist = streetActions(history, state.street)
  const raw = await callSolver({
    ...spot,
    streetHistory: streetHist,
    actingPlayerHand: startState.villainHoleCards[villainIdx],
    actingPlayerIsIP: villainIsIP,
  })

  let action = raw.sampledAction
  let amount = raw.sampledAmount
  const o = optionsFor(state, villainIdx)

  // House rule: an out-of-position villain never donk-bets into hero's initiative
  // (hero raised last preflop, or bet the street before). It checks, and can still
  // check-raise. When the villain has the initiative itself it bets as the solver says.
  if (!villainIsIP && o.toCall === 0 && action !== 'check' && heroHasInitiative(state, history)) { action = 'check'; amount = undefined }

  // The tree has one bet size, so hero's real bet can be bigger than the bet the
  // solver thinks it is raising. Keep the raise a real raise over hero's bet.
  if (action === 'raise' && o.toCall > 0 && (amount ?? 0) < o.minRaise) {
    amount = Math.round(o.toCall * 2.5 * 10) / 10
  }
  const legal = legalize(state, villainIdx, action, amount)
  const villainPosition = startState.villainPositions[villainIdx]

  return {
    ...legal,
    description: plainDescription(villainPosition, legal.action, legal.amount),
    explain: {
      villainPosition, villainIsIP,
      board: spot.board, street: state.street, pot: state.pot,
      action: legal.action, amount: legal.amount,
      frequencies: raw.actionFrequencies, equity: raw.equity, ev: raw.ev,
    },
  }
}

// ── Pre-solve: warm the solver's cache for a flop we expect to reach ──────────
// Fire-and-forget. The solver service coalesces identical requests, so if the
// client asks for this exact spot while the pre-solve is running it just waits
// for the same job instead of starting a second one.

export function presolveFlop(setup: Setup, startState: StartState, state: HandState): void {
  const spot = solverSpot(setup, startState, state, 'Flop')
  if (!spot) return
  fetch(`${SOLVER_URL}/presolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      board: spot.board, oop_range: spot.oopRange, ip_range: spot.ipRange,
      pot: spot.pot, effective_stack: spot.effectiveStack, street: 'Flop', bet_sizes: spot.betSizes ?? null,
    }),
  }).catch(err => console.warn('presolve failed (non-fatal):', err?.message ?? err))
}

// ── Solver eval for a single hero decision ───────────────────────────────────

export interface HeroEval {
  street: string
  heroAction: string
  heroAmount?: number
  gtoFrequencies: ActionFreq[]
  heroEquity: number
  heroEv: number
}

/** Null when the decision's street was not a heads-up solver spot. */
export async function evalHeroDecision(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  state: HandState,
  decisionIndex: number,
): Promise<HeroEval | null> {
  const decision = history[decisionIndex]
  const spot = solverSpot(setup, startState, state, decision.street)
  if (!spot) return null

  // In play this spot is already solved and cached (the villain acted on it), so
  // grading it is a millisecond lookup.
  const solver = await callSolver({
    ...spot,
    streetHistory: streetActions(history.slice(0, decisionIndex), decision.street),
    actingPlayerHand: startState.holeCards,
    actingPlayerIsIP: spot.heroIsIP,
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
