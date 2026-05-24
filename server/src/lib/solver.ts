import OpenAI from 'openai'
import { getRangesForSpot } from './ranges'
import type { Setup, StartState, HandHistoryEntry, VillainResponse } from './types'

const SOLVER_URL = process.env.SOLVER_URL ?? 'http://127.0.0.1:3002'

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
})

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
}): Promise<SolverResult> {
  const res = await fetch(`${SOLVER_URL}/solve`, {
    method: 'POST',
    signal: AbortSignal.timeout(25000),
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
    }),
  })

  if (!res.ok) throw new Error(`Solver error: ${res.status}`)

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
  heroIsIP: boolean
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
- Villain (${villainPosition}) is ${heroIsIP ? 'OOP' : 'IP'}
- Villain equity: ${(solver.equity * 100).toFixed(0)}%, EV: ${solver.ev.toFixed(1)}bb

GTO frequencies: ${freqSummary}
Villain chose: ${action}${amount ? ` ${amount}bb` : ''}

Rules:
- Do NOT mention villain's hole cards
- Explain the WHY: board texture, equity, position, or pot odds
- Be specific, not generic (no "to stay balanced" without a reason)`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 120,
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

// ── Public: get villain postflop action ───────────────────────────────────────

export async function getVillainActionFromSolver(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  pot: number,
  effectiveStack: number
): Promise<VillainResponse> {
  const { oopRange, ipRange } = getRangesForSpot(
    setup.position,
    startState.villainPositions,
    startState.heroIsIP,
    startState.preflopContext
  )

  const board = boardForStreet(currentStreet, startState.board)

  // All actions this street up to now (hero just acted — that's the last entry)
  const streetHist = history
    .filter(h => h.street === currentStreet)
    .map(h => ({ action: h.action, amount: h.amount }))

  const villainHand = startState.villainHoleCards[0]
  const villainIsIP = !startState.heroIsIP

  const solver = await callSolver({
    board,
    oopRange,
    ipRange,
    pot,
    effectiveStack,
    street: currentStreet,
    streetHistory: streetHist,
    actingPlayerHand: villainHand,
    actingPlayerIsIP: villainIsIP,
  })

  const explanation = await explainVillainAction(
    solver,
    startState.villainPositions[0],
    setup.position,
    board,
    currentStreet,
    pot,
    startState.heroIsIP
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
  pot: number,
  effectiveStack: number
): Promise<HeroEval> {
  const { oopRange, ipRange } = getRangesForSpot(
    setup.position,
    startState.villainPositions,
    startState.heroIsIP,
    startState.preflopContext
  )

  const board = boardForStreet(decision.street, startState.board)
  const streetHist = streetHistoryBefore(fullHistory, decision.street, decisionIndex)

  const solver = await callSolver({
    board,
    oopRange,
    ipRange,
    pot,
    effectiveStack,
    street: decision.street,
    streetHistory: streetHist,
    actingPlayerHand: startState.holeCards,
    actingPlayerIsIP: startState.heroIsIP,
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

function calcNewPot(
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
