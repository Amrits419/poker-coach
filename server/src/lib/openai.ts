import OpenAI from 'openai'
import { dealFromDeck } from './cards'
import {
  getVillainActionFromSolver,
  evalHeroDecision,
  solverSpot,
  plainDescription,
  type HeroEval,
  type VillainDecision,
} from './solver'
import {
  isHandInRange, isHandIn3BetRange, willVillainDefend, OPEN_RANGES, isHeroInPosition, POSTFLOP_ORDER,
  heroPreflopFrequencies, villainPreflopAction, villainPreflopFreqs, type VillainPreflopSpot,
} from './ranges'
import { replay, seatOf, optionsFor, legalize, handResult, heroHasInitiative, type HandState } from './engine'
import type { Setup, StartState, HandHistoryEntry, Analysis } from './types'

export type { Setup, StartState, HandHistoryEntry, Analysis }

// Created on first use so importing this module (e.g. from unit tests) doesn't
// need a Groq key in the environment.
let _llm: OpenAI | null = null
const llm = () => (_llm ??= new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
}))

// Groq retired llama-3.3-70b-versatile; override with LLM_MODEL if the default goes away too.
const LLM_MODEL = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b'

// Full preflop order — action goes in this sequence each street
const PREFLOP_SEATS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const

export async function startHand(setup: Setup): Promise<StartState> {
  const numVillains = setup.isMultiway ? 2 : 1
  for (let attempt = 0; attempt < 50; attempt++) {
    const scenario = tryBuildScenario(setup, numVillains)
    if (scenario) return scenario
  }
  // Fallback — should never reach here
  return tryBuildScenario(setup, numVillains) ?? (() => { throw new Error('Could not build scenario') })()
}

function tryBuildScenario(setup: Setup, numVillains: number): StartState | null {
  const heroIdx      = PREFLOP_SEATS.indexOf(setup.position as typeof PREFLOP_SEATS[number])
  if (heroIdx === -1) return null

  const beforeHero   = PREFLOP_SEATS.slice(0, heroIdx)   // act before hero preflop
  const afterHero    = PREFLOP_SEATS.slice(heroIdx + 1)  // act after hero preflop
  const nonHeroSeats = [...beforeHero, ...afterHero]

  // Deal cards to every seat at once
  const deal = dealFromDeck(nonHeroSeats.length)
  const hand: Record<string, string> = { [setup.position]: deal.heroCards }
  nonHeroSeats.forEach((pos, i) => { hand[pos] = deal.villainCards[i] ?? '' })

  // ── Simulate preflop action for seats before hero ─────────────────────────
  // Each seat opens if their hand is in their GTO range,
  // or 3-bets if there is already an open and their hand qualifies.
  let raiseLevel = 0   // 0 = no raise, 1 = open, 2 = 3-bet
  let opener:    { pos: string; hand: string } | null = null
  let threeBettor: { pos: string; hand: string } | null = null

  for (const pos of beforeHero) {
    const h = hand[pos] ?? ''
    if (raiseLevel === 0 && isHandInRange(h, OPEN_RANGES[pos] ?? '')) {
      opener = { pos, hand: h }
      raiseLevel = 1
    } else if (raiseLevel === 1 && isHandIn3BetRange(h)) {
      threeBettor = { pos, hand: h }
      raiseLevel = 2
      break
    }
  }

  const OPEN_SIZE      = 2.5
  const THREE_BET_SIZE = 9.0
  const heroPosted     = setup.position === 'BB' ? 1.0 : setup.position === 'SB' ? 0.5 : 0
  // Chips in front of each seat before hero acts — drawn on the table by the client
  const blinds: Record<string, number> = { SB: 0.5, BB: 1.0 }
  // The pot is everything on the table, hero's own blind included
  const potOf = (bets: Record<string, number>) => Math.round(Object.values(bets).reduce((a, b) => a + b, 0) * 100) / 100

  // ── Case A: no raise before hero → hero opens ─────────────────────────────
  if (raiseLevel === 0) {
    // BB with no action = walk (not a useful training spot)
    if (setup.position === 'BB') return null

    // Collect villain(s) from seats after hero that would defend
    const defenders: string[] = []
    for (const pos of afterHero) {
      if (defenders.length >= numVillains) break
      if (willVillainDefend(pos, hand[pos] ?? '', setup.position)) defenders.push(pos)
    }
    if (defenders.length === 0) return null

    const villainPositions = defenders
    const ctx = defenders.length > 1
      ? `Action folds to you in ${setup.position}. ${defenders[0]} and ${defenders[1]} are still to act.`
      : `Action folds to you in ${setup.position}. ${defenders[0]} is left to act.`

    return {
      holeCards: deal.heroCards, villainHoleCards: defenders.map(p => hand[p] ?? ''),
      villainPositions, board: deal.board,
      heroIsIP: isHeroInPosition(setup.position, villainPositions), heroIsPFR: true,
      preflopContext: ctx,
      pot: 1.5, effectiveStack: parseFloat(setup.stackDepth) - heroPosted,
      preflopRaiseAmount: null,
      preflopBets: { ...blinds },
    }
  }

  // ── Case B: one open before hero → hero faces the open ───────────────────
  if (raiseLevel === 1 && opener) {
    // For multiway: find a second villain from after hero that would also call the open
    let extraVillain: string | null = null
    if (numVillains >= 2) {
      extraVillain = afterHero.find(pos =>
        willVillainDefend(pos, hand[pos] ?? '', opener!.pos)
      ) ?? null
      if (!extraVillain) return null
    }

    const villainPositions = extraVillain ? [opener.pos, extraVillain] : [opener.pos]
    const ctx = extraVillain
      ? `${opener.pos} opens ${OPEN_SIZE}bb. You're in ${setup.position} with ${extraVillain} still to act.`
      : `${opener.pos} opens ${OPEN_SIZE}bb. You're in ${setup.position}.`

    return {
      holeCards: deal.heroCards, villainHoleCards: villainPositions.map(p => hand[p] ?? ''),
      villainPositions, board: deal.board,
      heroIsIP: isHeroInPosition(setup.position, villainPositions), heroIsPFR: false,
      preflopContext: ctx,
      pot: potOf({ ...blinds, [opener.pos]: OPEN_SIZE }),
      effectiveStack: parseFloat(setup.stackDepth) - heroPosted,
      preflopRaiseAmount: OPEN_SIZE,
      preflopBets: { ...blinds, [opener.pos]: OPEN_SIZE },
    }
  }

  // ── Case C: open + 3-bet before hero → hero faces cold 3-bet ─────────────
  if (opener && threeBettor) {
    return {
      holeCards: deal.heroCards,
      villainHoleCards: [threeBettor.hand, opener.hand],
      villainPositions: [threeBettor.pos, opener.pos],
      board: deal.board,
      heroIsIP: isHeroInPosition(setup.position, [threeBettor.pos, opener.pos]), heroIsPFR: false,
      preflopContext: `${opener.pos} opens ${OPEN_SIZE}bb, ${threeBettor.pos} 3-bets to ${THREE_BET_SIZE}bb. You're in ${setup.position} facing a cold 3-bet.`,
      pot: potOf({ ...blinds, [opener.pos]: OPEN_SIZE, [threeBettor.pos]: THREE_BET_SIZE }),
      effectiveStack: parseFloat(setup.stackDepth) - heroPosted,
      preflopRaiseAmount: THREE_BET_SIZE,
      preflopBets: { ...blinds, [opener.pos]: OPEN_SIZE, [threeBettor.pos]: THREE_BET_SIZE },
    }
  }

  return null
}

// ── Villain play ─────────────────────────────────────────────────────────────

/** The preflop spot a villain is in, read off the engine state. */
export function villainPreflopSpot(startState: StartState, state: HandState, villainIdx: number): VillainPreflopSpot {
  const seat = seatOf(state, villainIdx)!
  const lastRaiser = state.raisers[state.raisers.length - 1]
  return {
    pos: seat.pos,
    hand: startState.villainHoleCards[villainIdx] ?? '',
    raises: state.raisers.length,
    aggressorPos: lastRaiser === undefined ? null : seatOf(state, lastRaiser)!.pos,
    raisedBefore: state.raisers.includes(villainIdx),
    currentBet: state.currentBet,
    myIn: seat.in,
    stackTotal: seat.in + seat.stack,
  }
}

/** Would this villain certainly flat (never raise, never fold) in its current preflop spot? */
export function villainCertainlyCalls(startState: StartState, state: HandState, villainIdx: number): boolean {
  const f = villainPreflopFreqs(villainPreflopSpot(startState, state, villainIdx))
  return f.aggrFreq === 0 && f.callFreq > 0
}

/**
 * The action of the villain whose turn it is. Preflop comes from the range tables;
 * postflop from the solver when the street is heads-up, otherwise (or if the solver
 * is unavailable) from the LLM with its answer clamped to a legal action.
 */
export async function getVillainAction(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  state: HandState,
  villainIdx: number,
): Promise<VillainDecision> {
  if (state.street === 'Preflop') {
    const d = villainPreflopAction(villainPreflopSpot(startState, state, villainIdx))
    return { ...legalize(state, villainIdx, d.action, d.amount), description: d.description }
  }

  if (solverSpot(setup, startState, state, state.street)) {
    try {
      return await getVillainActionFromSolver(setup, startState, history, state, villainIdx)
    } catch (err) {
      console.warn('Solver unavailable, falling back to LLM:', (err as Error)?.message ?? err)
    }
  }
  return getVillainActionLLM(setup, startState, history, state, villainIdx)
}

async function getVillainActionLLM(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  state: HandState,
  villainIdx: number,
): Promise<VillainDecision> {
  const pos = startState.villainPositions[villainIdx]
  const hand = startState.villainHoleCards[villainIdx]
  const o = optionsFor(state, villainIdx)
  const board = [...startState.board.flop, startState.board.turn, startState.board.river]
    .slice(0, state.street === 'Flop' ? 3 : state.street === 'Turn' ? 4 : 5)
  const villainIsIP = POSTFLOP_ORDER.indexOf(pos) > POSTFLOP_ORDER.indexOf(setup.position)
  // Same house rule as the solver path: no donk bets into hero's initiative
  const noDonk = !villainIsIP && o.toCall === 0 && heroHasInitiative(state, history)
  const who = (h: HandHistoryEntry) => h.actor === 'hero' ? `Hero (${setup.position})` : startState.villainPositions[h.villainIdx ?? 0]
  const historyText = history.map(h => `${h.street} - ${who(h)}: ${h.action}${h.amount ? ` ${h.amount}bb` : ''}`).join('\n') || 'No previous action'

  const options = o.toCall > 0
    ? `You face a bet of ${o.toCall}bb (${o.callCost}bb more to call). Choose fold, call${o.canRaise ? `, or raise (to between ${o.minRaise}bb and ${o.maxRaise}bb; 2.5x-3x the bet is standard)` : ''}.`
    : noDonk
      ? 'You are first to act against the player with the betting initiative. You CHECK here — never lead into the aggressor. You may check-raise later if hero bets.'
      : `Nobody has bet yet. Choose check or bet (33%-75% of the ${state.pot}bb pot).`

  const prompt = `You are a GTO NLHE poker AI playing as the villain. Choose your action.

Game state:
- You are ${pos}, ${villainIsIP ? 'IN POSITION' : 'OUT OF POSITION'} against hero (${setup.position})
- Your hole cards: ${hand}
- Street: ${state.street}, board: ${board.join(' ')}
- Pot: ${state.pot}bb, your stack: ${seatOf(state, villainIdx)!.stack}bb
- ${liveCount(state)} players left in the hand

Hand history:
${historyText}

${options}
Decide from your actual hole cards and their equity on this board.

Return JSON only:
{
  "action": "check|bet|raise|call|fold",
  "amount": <total bb if bet/raise, otherwise null>,
  "description": "one sentence on why, e.g. '${pos} bets for value on a dry board' — NEVER mention your hole cards"
}`

  const res = await llm().chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    reasoning_effort: 'low',
  })

  // The LLM is not trusted with sizing or legality: clamp its answer.
  let data: { action?: string; amount?: number; description?: string } = {}
  try { data = JSON.parse(res.choices[0].message.content ?? '{}') } catch { /* fall through to a check/call */ }
  let action = String(data.action ?? 'check').toLowerCase()
  let amount = typeof data.amount === 'number' ? data.amount : undefined
  if (noDonk) action = 'check'
  if (action === 'bet' && o.toCall === 0) {
    amount = Math.min(Math.max(amount ?? state.pot * 0.66, state.pot * 0.33), state.pot)
  }
  if (action === 'raise' && o.toCall > 0) {
    amount = Math.min(Math.max(amount ?? o.toCall * 2.5, o.toCall * 2.2), o.toCall * 3)
  }
  const legal = legalize(state, villainIdx, action, amount == null ? undefined : Math.round(amount * 10) / 10)
  return {
    ...legal,
    description: typeof data.description === 'string' && data.description.trim()
      ? data.description.trim()
      : plainDescription(pos, legal.action, legal.amount),
  }
}

const liveCount = (state: HandState) => state.seats.filter(s => !s.folded).length

// ── Hand analysis ────────────────────────────────────────────────────────────

export async function analyzeHand(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[]
): Promise<Analysis> {
  const state = replay(setup, startState, history)

  // Solver evaluations for every postflop hero decision on a heads-up street.
  // One failed solve shouldn't drop the others.
  const decisions = history
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => h.actor === 'hero' && h.street !== 'Preflop')
  const settled = await Promise.allSettled(
    decisions.map(({ idx }) => evalHeroDecision(setup, startState, history, state, idx))
  )
  const solverEvals: HeroEval[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') { if (r.value) solverEvals.push(r.value) }
    else console.warn('Solver eval failed, analyzing that decision without solver data:', r.reason)
  }

  // How preflop actually ended, so the coach talks about the right ranges
  const lastRaiser = state.raisers[state.raisers.length - 1]
  const live = startState.villainPositions.filter((_, i) => !seatOf(state, i)!.folded)
  const villains = live.length ? live : startState.villainPositions
  const potName = ['limped pot', 'single-raised pot', '3-bet pot', '4-bet pot'][Math.min(state.raisers.length, 3)]
  const aggressor = lastRaiser === undefined ? null : seatOf(state, lastRaiser)!.pos
  const multiway = (state.streetStart.Flop?.villains.length ?? 1) > 1

  const analysis = await analyzeHandWithLLM(setup, startState, history, solverEvals, {
    trainer: true,
    preflopFacts: trainerPreflopFacts(setup, startState, history),
    villainDesc: villains.map(pos => `${pos}: ${aggressor === pos ? `the last preflop raiser (${potName})` : aggressor ? `continued against the ${aggressor} raise (${potName})` : 'checked their option in a limped pot'}`).join('; '),
    rangeNote: aggressor
      ? `${potName}: ${aggressor} made the last preflop raise${aggressor === setup.position ? ' (hero is the aggressor)' : ''}.`
      : 'Limped pot: nobody raised preflop, so neither range is capped or uncapped by a raise.',
    notes: multiway ? ['Multiway on the flop: there is no solver data for multiway streets.']
      : !aggressor ? ['Limped pot: there is no solver data for limped pots.']
      : undefined,
  })
  analysis.result = handResult(state, startState) ?? undefined
  return analysis
}

/**
 * One line of range-table facts per hero preflop decision. There is no solver
 * preflop, so this is what keeps the coach from inventing preflop numbers.
 */
export function trainerPreflopFacts(setup: Setup, startState: StartState, history: HandHistoryEntry[]): string {
  const lines: string[] = []
  history.forEach((h, idx) => {
    if (h.actor !== 'hero' || h.street !== 'Preflop') return
    const before = replay(setup, startState, history.slice(0, idx))
    const raises = before.raisers.length
    const did = `${h.action}${h.amount ? ` ${h.amount}bb` : ''}`
    const lastRaiser = before.raisers[raises - 1]
    const raiserPos = lastRaiser === undefined || lastRaiser === 'hero' ? null : seatOf(before, lastRaiser)!.pos
    const heroIsIP = raiserPos ? isHeroInPosition(setup.position, [raiserPos]) : startState.heroIsIP
    const posLabel = heroIsIP ? 'IP' : 'OOP'

    if (raises === 0) {
      const inRange = isHandInRange(startState.holeCards, OPEN_RANGES[setup.position] ?? OPEN_RANGES.CO)
      lines.push(`- Decision ${lines.length + 1} (hero ${did}): folded to hero in ${setup.position}. Hero's hand ${inRange
        ? `IS in the ${setup.position} opening range — an open-raise to 2-3bb is correct; folding or limping is a MISTAKE.`
        : `is NOT in the ${setup.position} opening range — folding is correct; opening or limping is a MISTAKE.`}`)
    } else if (raises === 1 && raiserPos) {
      const openerIsTight = ['UTG', 'UTG+1', 'MP'].includes(raiserPos)
      const inHeroRange = isHandInRange(startState.holeCards, OPEN_RANGES[setup.position] ?? '')
      const f = heroPreflopFrequencies(startState.holeCards, heroIsIP, 'open')
      const verdict = f.aggrFreq > 0
        ? preflopVerdict(f.aggrFreq, 0, '3-bet', 'call', '')
        : evalColdCallVsOpen(startState.holeCards, setup.position, inHeroRange, raiserPos, openerIsTight, heroIsIP)
      lines.push(`- Decision ${lines.length + 1} (hero ${did}): facing a single ${raiserPos} open (${openerIsTight ? 'tight EP range ~10-15%' : 'wider range ~18-50%'}). Hero's GTO 3-bet range (${posLabel}): ${f.aggrRangeDesc}. Verdict for hero's hand: ${verdict}`)
    } else if (raises === 2) {
      const f = heroPreflopFrequencies(startState.holeCards, heroIsIP, '3bet')
      lines.push(`- Decision ${lines.length + 1} (hero ${did}): hero faces a 3-bet (${posLabel}). GTO 4-bet range: ${f.aggrRangeDesc}. GTO call range: ${f.callRangeDesc}. Hero's hand: ${preflopVerdict(f.aggrFreq, f.callFreq, '4-bet', 'call', 'fold — the hand is in neither range. Do NOT recommend calling.')}`)
    } else {
      lines.push(`- Decision ${lines.length + 1} (hero ${did}): hero faces a 4-bet or bigger. Only AA and KK continue by moving all-in; QQ, JJ, AKs and AKo can call a non-all-in 4-bet; every other hand folds.`)
    }
  })
  return lines.join('\n')
}

function computeHeroMadeHand(holeCards: string, boardCards: string[]): string {
  const RANK_ORDER = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']
  const parseCard = (c: string) => ({ rank: c[0].toUpperCase(), suit: c[1].toLowerCase() })

  const h1 = parseCard(holeCards.slice(0, 2))
  const h2 = parseCard(holeCards.slice(2, 4))
  const bp  = boardCards.map(parseCard)
  const all = [h1, h2, ...bp]

  const rc: Record<string, number> = {}
  for (const c of all) rc[c.rank] = (rc[c.rank] || 0) + 1

  const sc: Record<string, number> = {}
  for (const c of all) sc[c.suit] = (sc[c.suit] || 0) + 1

  const cv = Object.values(rc).sort((a, b) => b - a)

  const heroSuit = h1.suit === h2.suit ? h1.suit : null
  const hasFlush = heroSuit !== null && (sc[heroSuit] ?? 0) >= 5

  const idxs = [...new Set(all.map(c => RANK_ORDER.indexOf(c.rank)))].sort((a, b) => a - b)
  const idxsL = idxs.includes(0) ? [...idxs, 13] : idxs
  let hasStraight = false
  for (let i = 0; i <= idxsL.length - 5; i++) {
    if (idxsL[i + 4] - idxsL[i] === 4 && new Set(idxsL.slice(i, i + 5)).size === 5) {
      hasStraight = true; break
    }
  }

  if (cv[0] >= 4) return 'four of a kind'
  if (cv[0] === 3 && cv[1] >= 2) return 'full house'
  if (hasFlush && hasStraight) return 'straight flush'
  if (hasFlush) return 'flush'
  if (hasStraight) return 'straight'
  if (cv[0] === 3) {
    const tr = Object.keys(rc).find(r => rc[r] >= 3)!
    return [h1.rank, h2.rank].includes(tr)
      ? `three of a kind (${tr}s)`
      : `three of a kind — board trips (hero plays the board)`
  }

  const pairs = Object.keys(rc).filter(r => rc[r] === 2)
    .sort((a, b) => RANK_ORDER.indexOf(a) - RANK_ORDER.indexOf(b))

  if (cv[0] === 2 && cv[1] === 2) {
    const heroPaired = pairs.filter(r =>
      (h1.rank === r && h2.rank === r) ||
      ([h1.rank, h2.rank].includes(r) && bp.some(b => b.rank === r))
    )
    if (heroPaired.length === 0) {
      return `NO MADE HAND — two board pairs (${pairs.join(' and ')}); hero plays the board with kickers only`
    }
    // Determine strength: if hero only contributed the lowest-ranked pair, it is bottom two pair
    const boardRanksByStrength = bp.map(b => b.rank).sort((a, b) => RANK_ORDER.indexOf(a) - RANK_ORDER.indexOf(b))
    const bottomBoardRank = boardRanksByStrength[boardRanksByStrength.length - 1]
    const heroOnlyPairedBottom = heroPaired.length === 1 && heroPaired[0] === bottomBoardRank
    // Check if the other pair is entirely from the board (a shared "community pair" like AA on board)
    const otherPair = pairs.find(r => !heroPaired.includes(r))
    const otherPairIsFullyOnBoard = otherPair
      ? bp.filter(b => b.rank === otherPair).length >= 2
      : false
    if (heroOnlyPairedBottom && otherPairIsFullyOnBoard) {
      return `WEAK two pair (${pairs.join(' and ')}) — hero paired the LOWEST board card; the top pair (${otherPair}) is shared by all players. This is closer to "bottom pair with a community pair overhead" than a real two pair. Do NOT treat this as a strong hand.`
    }
    return `two pair (${pairs.join(' and ')})`
  }

  if (cv[0] === 2) {
    const pr = pairs[0]
    const isPocket    = h1.rank === pr && h2.rank === pr
    const pairsBoard  = [h1.rank, h2.rank].includes(pr) && bp.some(b => b.rank === pr)

    if (!isPocket && !pairsBoard) {
      return `NO MADE HAND — board pair only (${pr}s on board; hero's hole cards do not connect with any board card)`
    }
    if (isPocket) {
      const minBoardIdx = Math.min(...bp.map(b => RANK_ORDER.indexOf(b.rank)))
      return RANK_ORDER.indexOf(h1.rank) < minBoardIdx
        ? `one pair — overpair (pocket ${h1.rank}s above all board cards)`
        : `one pair — pocket pair (${h1.rank}s, NOT an overpair)`
    }
    const bIdxs = bp.map(b => RANK_ORDER.indexOf(b.rank))
    const prIdx = RANK_ORDER.indexOf(pr)
    if (prIdx === Math.min(...bIdxs)) return `one pair — top pair (${pr}s)`
    if (prIdx === Math.max(...bIdxs)) return `one pair — bottom pair (${pr}s)`
    return `one pair — middle pair (${pr}s)`
  }

  return `NO MADE HAND — complete miss (neither hole card pairs with any board card)`
}

// Turn range frequencies into an unambiguous instruction for the coach. The
// aggressive line (3-bet / 4-bet) is checked first: premium pairs are raises,
// never "set-mining calls".
function preflopVerdict(aggrFreq: number, callFreq: number, aggr: string, passive: string, neither: string): string {
  const pct = Math.round(aggrFreq * 100)
  if (aggrFreq >= 0.99) {
    return `pure ${aggr} — GTO ${aggr}s this hand 100%. ${aggr} is correct; a flat ${passive} is a MISTAKE (it is not in the ${passive}ing range). Do NOT recommend ${passive}ing.`
  }
  if (aggrFreq >= 0.35) {
    return `mixed — GTO ${aggr}s ${pct}% and ${passive}s ${100 - pct}%. BOTH ${aggr} and ${passive} are correct; grade either as correct, neither is a mistake.`
  }
  if (aggrFreq > 0) {
    return `mostly ${passive} — GTO ${aggr}s only ${pct}% and ${passive}s the rest. ${passive} is the standard play; a ${aggr} is acceptable at low frequency and is NOT a mistake.`
  }
  if (callFreq > 0) {
    return `${passive} — IN the ${passive} range (${Math.round(callFreq * 100)}%), NOT in the ${aggr} range. ${passive} is correct; ${aggr} is a mistake.`
  }
  return neither
}

function evalColdCallVsOpen(
  holeCards: string,
  heroPos: string,
  inHeroOpenRange: boolean,
  openerPos: string,
  openerIsTight: boolean,
  heroIsIP: boolean
): string {
  const RANK = 'AKQJT98765432' // index 0 = A (highest), 12 = 2 (lowest)
  const r1 = holeCards[0].toUpperCase()
  const r2 = holeCards[2].toUpperCase()
  const suited = holeCards[1].toLowerCase() === holeCards[3].toLowerCase()
  const isPP = r1 === r2

  if (isPP) return `${r1}${r2} is a pocket pair — CALL (set mining, always valid vs any open).`

  const i1 = RANK.indexOf(r1)
  const i2 = RANK.indexOf(r2)
  const hiIdx = Math.min(i1, i2) // smaller index = higher rank
  const loIdx = Math.max(i1, i2)
  const hiRank = RANK[hiIdx]
  const loRank = RANK[loIdx]
  const gap = loIdx - hiIdx - 1 // 0 = connected, 1 = one-gapper
  const handStr = `${hiRank}${loRank}${suited ? 's' : 'o'}`

  // First gate: not even in hero's opening range → always fold
  if (!inHeroOpenRange) {
    return `${handStr} is NOT in hero's ${heroPos} opening range — FOLD. A hand not strong enough to open from ${heroPos} should never cold-call a raise. Do NOT recommend calling.`
  }

  // Suited aces
  if (hiRank === 'A' && suited) {
    if (loIdx >= 8) return `${handStr} suited ace (nut flush + wheel equity) — CALL.`
    if (loIdx <= 4) return `${handStr} strong suited ace (ATs+) — CALL.`  // ATs, AJs, AQs, AKs
    return openerIsTight
      ? `${handStr} weak suited ace — FOLD vs ${openerPos} tight range (dominated kicker).`
      : `${handStr} weak suited ace — CALL vs wider opens.`
  }

  // Strong offsuit broadways: AJo+, KQo
  if (!suited && hiIdx <= 1 && loIdx <= 3) return `${handStr} strong broadway — CALL.`
  if (!suited && hiRank === 'A' && loIdx <= 4) return `${handStr} AJo+ — CALL.`

  // Suited connectors and one-gappers
  if (suited && gap <= 1) {
    if (hiIdx <= 4) return `${handStr} premium suited connector — CALL (strong implied odds).`
    if (hiIdx <= 7 && heroIsIP) return `${handStr} suited connector — CALL from position (positive implied odds).`
    if (hiIdx <= 7 && !heroIsIP) return openerIsTight
      ? `${handStr} suited connector OOP — FOLD vs ${openerPos} tight range (hard to realize equity OOP).`
      : `${handStr} suited connector OOP — marginal; lean fold vs tight opens.`
    return `${handStr} low suited connector — FOLD vs raises.`
  }

  // Suited broadways with gaps
  if (suited && hiIdx <= 3 && loIdx <= 4 && gap <= 2) return `${handStr} suited broadway — CALL.`

  // Anything else in range but disconnected / low kicker
  return openerIsTight
    ? `${handStr} is in hero's ${heroPos} opening range but is disconnected or has a weak kicker — FOLD vs ${openerPos} tight range. Do NOT recommend calling.`
    : `${handStr} — marginal; call only if at the top of hero's range vs this open.`
}

export interface CoachContext {
  /** The "Preflop GTO context" block: range-table facts for each hero preflop decision. */
  preflopFacts?: string
  /** Extra lines for the coach: full preflop line, assumed ranges, sizing snaps, multiway notes. */
  notes?: string[]
  /** True for hands played in the trainer; otherwise the hand is an imported real hand. */
  trainer?: boolean
  /** Who the villains are, by role (never by hole cards). */
  villainDesc?: string
  /** Who made the last preflop raise. */
  rangeNote?: string
}

export async function analyzeHandWithLLM(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  solverEvals: HeroEval[],
  imported?: CoachContext,
): Promise<Analysis> {
  // Streets that actually had action — LLM must not fabricate feedback for others
  const streetsPlayed = [...new Set(history.map(h => h.street))]

  // Annotate each hero action with exactly what situation they were in so the
  // LLM cannot hallucinate "facing a raise" when hero was first to act.
  const fullHistory = history
    .map((h, idx) => {
      const streetActsBefore = history.slice(0, idx).filter(h2 => h2.street === h.street)
      const facingBet = streetActsBefore.some(
        h2 => h2.actor === 'villain' && (h2.action === 'bet' || h2.action === 'raise')
      )
      const actor = h.actor === 'hero' ? 'Hero' : 'Villain'
      const action = `${h.action}${h.amount ? ` ${h.amount}bb` : ''}`
      const ctx = h.actor === 'hero'
        ? (facingBet ? ' [hero was RESPONDING to villain bet/raise]' : ' [hero was FIRST TO ACT — no bet to face]')
        : ''
      return `${h.street} - ${actor}: ${action}${ctx}`
    })
    .join('\n')

  // Describe villain by range/role, NOT specific hole cards.
  // Hero never knew their hand during the hand — analysis must reflect that.
  const villainRangeDesc = imported?.villainDesc ?? startState.villainPositions
    .map(pos => {
      const role = startState.heroIsPFR
        ? `${pos} calling range vs ${setup.position} open`
        : `${pos} opening/3-bet range (villain was aggressor)`
      return `${pos}: ${role}`
    })
    .join('; ')

  const boardStr = `Flop: ${startState.board.flop.join(' ')} | Turn: ${startState.board.turn} | River: ${startState.board.river}`

  // Pre-compute hero's actual made hand per street so the LLM cannot hallucinate hand categories
  const heroHandLines: string[] = []
  if (streetsPlayed.includes('Flop')) {
    heroHandLines.push(`  Flop (${startState.board.flop.join(' ')}): ${computeHeroMadeHand(startState.holeCards, startState.board.flop)}`)
  }
  if (streetsPlayed.includes('Turn')) {
    heroHandLines.push(`  Turn (${[...startState.board.flop, startState.board.turn].join(' ')}): ${computeHeroMadeHand(startState.holeCards, [...startState.board.flop, startState.board.turn])}`)
  }
  if (streetsPlayed.includes('River')) {
    heroHandLines.push(`  River (${[...startState.board.flop, startState.board.turn, startState.board.river].join(' ')}): ${computeHeroMadeHand(startState.holeCards, [...startState.board.flop, startState.board.turn, startState.board.river])}`)
  }
  const heroHandBlock = heroHandLines.join('\n')

  // Preflop GTO context — no solver data exists for preflop; inject range facts to prevent hallucination
  const preflopRangeBlock = imported?.preflopFacts
    ? `\nPreflop GTO context (NO solver data for preflop — use ONLY this):\n${imported.preflopFacts}`
    : ''

  // Range advantage context: tells LLM who has the stronger range on various boards
  const pfrPosition = startState.heroIsPFR ? setup.position : (startState.villainPositions[0] ?? 'villain')
  const callerPosition = startState.heroIsPFR ? (startState.villainPositions[0] ?? 'villain') : setup.position
  const whoRaised = imported?.rangeNote ?? `${pfrPosition} was the PFR (preflop raiser). ${callerPosition} called.`
  const rangeAdvantageNote = `Range dynamics: ${whoRaised} Which range a board favors depends on the specific ranges — e.g. high, dry boards (A-K-x, K-Q-x) usually favor the last preflop raiser, while middling connected boards (J-T-9, 9-8-7) often favor the caller, who has more sets, two pair and straights there. When solver data is available for a street, it already accounts for this.`

  // Format solver evaluations so the LLM can reference exact GTO frequencies
  const solverBlock = solverEvals.length > 0
    ? `\nSOLVER DATA (authoritative for the streets it covers — base your verdict on it):\n` +
      solverEvals.map(e => {
        const gto = e.gtoFrequencies
          .filter(a => a.frequency > 0.02)
          .map(a => `${a.action}${a.amount ? ` ${a.amount}bb` : ''} ${(a.frequency * 100).toFixed(0)}%`)
          .join(', ')
        // The solver names an all-in "raise" even as a first bet, so bet and raise are one class
        const aggressive = (a: string) => a === 'bet' || a === 'raise'
        const heroGtoFreq = (e.gtoFrequencies
          .filter(a => a.action === e.heroAction || (aggressive(a.action) && aggressive(e.heroAction)))
          .reduce((sum, a) => sum + a.frequency, 0) * 100).toFixed(0)
        return `- ${e.street}: Hero ${e.heroAction}${e.heroAmount ? ` ${e.heroAmount}bb` : ''} (GTO frequency: ${heroGtoFreq}%). Full GTO mix: ${gto}. Hero equity: ${(e.heroEquity * 100).toFixed(0)}%.`
      }).join('\n')
    : ''

  const prompt = `You are a brutally precise NLHE poker coach. Your job is to give the hero exact, actionable feedback — no hedging, no vague advice.

Context:
- Hero: ${setup.position}, hole cards: ${startState.holeCards}, stack: ${setup.stackDepth}
- Villain(s): ${villainRangeDesc}
- Board: ${boardStr}
- Hero is ${startState.heroIsIP ? 'IN POSITION (IP)' : 'OUT OF POSITION (OOP)'} post-flop
- ${startState.villainPositions.length > 1 ? 'Multiway pot' : 'Heads-up pot'}
- Preflop: ${startState.preflopContext}
- ${rangeAdvantageNote}${preflopRangeBlock}
- Hero's ACTUAL made hand per street (computed from hole cards + board — AUTHORITATIVE, do NOT override):
${heroHandBlock}${imported?.notes?.length ? `\n- ${imported.trainer ? 'Notes' : 'Real hand imported from a hand history. Notes'}:\n${imported.notes.map(n => `  - ${n}`).join('\n')}` : ''}

Streets played (ONLY include these in streetFeedback — do NOT generate feedback for any other street): ${streetsPlayed.join(', ')}

Full hand history (each hero action is tagged [FIRST TO ACT] or [RESPONDING to villain bet]):
${fullHistory}
${solverBlock}

RULES — violating any of these makes the analysis useless:
1. SOLVER DATA IS THE GROUND TRUTH for the streets it covers. Cite the GTO% and equity it gives and base "correct" on it: an action the solver takes 30%+ of the time is "yes", 5-30% is "close", under 5% is "no". Your job is to EXPLAIN the solver's choice (board texture, range advantage, equity, blockers) — never contradict it. The solver uses a simplified tree with limited bet sizes (75% pot by default, 2.5x raises), so when hero used another size, judge the action (bet/check) by the solver and comment on sizing separately.
2. RANGE ADVANTAGE: use it to explain the solver's numbers, and as your main reasoning only on streets without solver data. Do not assume high or connected boards automatically favor the PFR — middling connected boards (J-T-9, T-9-8) often favor the caller.
3. BET SIZING MUST MATCH HAND STRENGTH AND GOAL:
   - WEAK two pair (paired the bottom board card with a shared community pair overhead, e.g. 23s on AAQT2) → treat like bottom pair. If the board favors villain's range (villain was the PFR with a tighter, stronger range, and the community pair connects with that range — e.g. AA board when villain opened, Kx board when villain raised from EP), CHECK. Villain's range is full of Ax/Kx hands that have hero crushed; betting for "value" is value-owning yourself. Only consider a tiny bet (20-25% pot) if villain's range is clearly capped and cannot have the community pair.
   - Thin value bets (second pair, weak top pair, marginal made hands) → use SMALL sizing (25-40% pot). Villain's calling range is narrow; a small bet gets called by more hands that beat nothing, maximizes EV against weak holdings, and loses less when villain has a strong hand.
   - Strong value bets (top pair top kicker, two pair, sets, flushes) → use MEDIUM sizing (50-75% pot). Charge draws, get value from villain's strong-but-worse hands.
   - Nut hands or very polarized ranges → LARGE sizing (75-100%+ pot). Max value from top of villain's calling range.
   - NEVER recommend 75%+ pot as a "value bet" for a hand that is medium strength (second pair, weak top pair). A large bet with a marginal hand is either a bluff (if villain folds better) or value-owning yourself (if villain calls with better). Call it out explicitly when the solver's suggested sizing conflicts with the hand's actual strength.
4. NEVER use vague language. Replace: "you might consider betting" → "bet Nbb (X% pot)". Replace: "passivity" → "checked top pair on dry board with 61% equity, giving villain a free card".
5. betterPlay must include sizing tied to a specific reason. Example: "Bet 3bb (33% pot) — thin value against villain's missed draws and weaker pairs; small sizing gets more calls from hands you beat and loses less to strong hands." or "Bet 8bb (75% pot) — strong two pair on a paired board; charge villain's one-pair hands and flushes."
6. explanation must name the specific hand category (top pair, flush draw, gutshot, etc.), identify range advantage, and do the pot-odds math explicitly when hero faced a bet. For POSTFLOP decisions only: cite GTO% and equity from solver data. For PREFLOP decisions: use the "Preflop GTO context" above — do NOT cite solver data, it does not exist for preflop.
7. If hero made a mistake, summary must open with the single costliest decision: "The key mistake was [specific action] on [street] — [equity/frequency reason why]." If every decision was correct, do NOT write "the key mistake was none" — open with what hero did well instead.
8. leaks must be hand-specific labels, not generic. Bad: "passivity". Good: "Checked back top pair IP on dry flop (GTO bets 68%)".
9. studyPlan items must be drills, not topics. Bad: "Study c-betting". Good: "Drill c-betting IP on Ax and Kx dry boards — practice sizing at 50-75% pot with your entire opening range until you default to betting, not checking."
10. In explanation/betterPlay, use the hand category from "Hero's ACTUAL made hand" above for that street — do NOT invent a different category. Never name hero's hole cards literally; use the provided category word-for-word.
11. NEVER reference villain's specific hole cards. Hero did not know them during the hand. All reasoning about villain must use RANGE language: "villain's calling range hits this board heavily", "villain's bluff combos are thin here", "villain's range is capped at one pair", etc.
12. CRITICAL — use the [FIRST TO ACT] / [RESPONDING] tags in the hand history. If hero was [FIRST TO ACT], their only options were check or bet — NEVER say they were "facing a raise/bet", NEVER mention "pot odds" for that decision, NEVER say "GTO calls X%". If hero was [RESPONDING], then fold/call/raise framing is correct.
13. State the correct play directly. No "consider", "might", "could". Say "bet", "fold", "call".
14. CRITICAL HAND STRENGTH RULE: If "Hero's ACTUAL made hand" says "NO MADE HAND" for a street, hero has AIR on that street. If it says "WEAK two pair", treat it like bottom pair — NOT a strong hand. When the board favors villain's range AND hero has WEAK two pair, CHECK is the correct play and should be marked "correct" or "close". Only recommend betting if the board is clearly neutral or favors hero's range. Never penalize hero for checking WEAK two pair when the board is dangerous. Do NOT call it top pair, second pair, or any pair. Do NOT recommend a value bet with air — hero can only check/fold or bluff (and name it a bluff). A hand labeled "NO MADE HAND — board pair only" means hero is playing the board; their kickers are their hole cards. This is a weak holding and should almost always check unless a clear bluff spot exists.
15. PREFLOP FABRICATION BAN: The solver only runs postflop. For any preflop decision, you MUST NOT invent equity percentages (e.g. "42% equity") or GTO frequencies (e.g. "GTO calls 55%") — these numbers do not exist. Preflop judgments must come solely from the "Preflop GTO context" block and basic pot-odds reasoning. If hero's hand is listed as NOT in the call range, folding is correct — period.

Return JSON only:
{
  "summary": "2-3 sentences. If hero made at least one mistake, first sentence must name the single biggest one: 'The key mistake was [action] on [street] — [reason].' If hero played correctly throughout, open with what they did well instead (e.g. 'Hero played this hand correctly — folding Q7s to a cold 3-bet is the right play since it is not in the GTO call range.'). Second sentence covers a secondary point.",
  "streetFeedback": [
    // ONLY include streets listed in "Streets played" above. If the hand ended preflop, only Preflop appears here.
    {
      "street": "Preflop|Flop|Turn|River",
      "heroAction": "exactly what hero did with sizing in bb",
      "correct": "yes|close|no",
      "explanation": "cite GTO% and equity from solver data; do pot-odds math; name hand category; be specific about why this exact sizing/action is right or wrong",
      "betterPlay": "one sentence: exact action + sizing + reason. Only include if correct is close or no."
    }
  ],
  "leaks": ["hand-specific leak label — include GTO% or equity to make it concrete"],
  "score": <0-100>,
  "studyPlan": ["drill or exercise description — concrete and actionable, not a topic name"]
}`

  const res = await llm().chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  })

  return normalizeAnalysis(JSON.parse(res.choices[0].message.content ?? '{}'))
}

/** The LLM's JSON is not guaranteed to have every field; the UI reads all of them. */
export function normalizeAnalysis(raw: unknown): Analysis {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
  const verdict = (v: unknown) => {
    const c = str(v).toLowerCase()
    return c === 'yes' || c === 'close' || c === 'no' ? c : 'close'
  }
  const score = Number(r.score)
  return {
    summary: str(r.summary),
    streetFeedback: (Array.isArray(r.streetFeedback) ? r.streetFeedback : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map(s => ({
        street: str(s.street), heroAction: str(s.heroAction), correct: verdict(s.correct),
        explanation: str(s.explanation), betterPlay: str(s.betterPlay),
      })),
    leaks: strs(r.leaks),
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    studyPlan: strs(r.studyPlan),
  }
}
