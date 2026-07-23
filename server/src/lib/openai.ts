import OpenAI from 'openai'
import { dealFromDeck } from './cards'
import {
  getVillainActionFromSolver,
  evalHeroDecision,
  type HeroEval,
} from './solver'
import { getVillainPreflopDecision, isHandInRange, isHandIn3BetRange, willVillainDefend, OPEN_RANGES, isHandInCall3BetRange, call3BetRangeDesc } from './ranges'
import type { Setup, StartState, HandHistoryEntry, VillainResponse, Analysis } from './types'

export type { Setup, StartState, HandHistoryEntry, VillainResponse, Analysis }

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
})

const IP_POSITIONS = new Set(['CO', 'BTN', 'HJ'])
const PREFLOP_ORDER_ALL = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']

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
  const preHeroOpener:    { pos: string; hand: string } | null = (() => null)()
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
  const deadBlinds     = setup.position === 'BB' ? 0.5   // SB is dead
                       : setup.position === 'SB' ? 1.0   // BB is dead
                       : 1.5                             // both blinds dead

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
      heroIsIP: IP_POSITIONS.has(setup.position), heroIsPFR: true,
      preflopContext: ctx,
      pot: 1.5, effectiveStack: parseFloat(setup.stackDepth) - heroPosted,
      preflopRaiseAmount: null,
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
      heroIsIP: IP_POSITIONS.has(setup.position), heroIsPFR: false,
      preflopContext: ctx,
      pot: Math.round((OPEN_SIZE + deadBlinds) * 10) / 10,
      effectiveStack: parseFloat(setup.stackDepth) - heroPosted,
      preflopRaiseAmount: OPEN_SIZE,
    }
  }

  // ── Case C: open + 3-bet before hero → hero faces cold 3-bet ─────────────
  if (opener && threeBettor) {
    return {
      holeCards: deal.heroCards,
      // 3-bettor at index 0 — getRangesForSpot uses villainPositions[0] for range dynamics
      villainHoleCards: [threeBettor.hand, opener.hand],
      villainPositions: [threeBettor.pos, opener.pos],
      board: deal.board,
      heroIsIP: IP_POSITIONS.has(setup.position), heroIsPFR: false,
      preflopContext: `${opener.pos} opens ${OPEN_SIZE}bb, ${threeBettor.pos} 3-bets to ${THREE_BET_SIZE}bb. You're in ${setup.position} facing a cold 3-bet.`,
      pot: Math.round((OPEN_SIZE + THREE_BET_SIZE + deadBlinds) * 10) / 10,
      effectiveStack: parseFloat(setup.stackDepth) - heroPosted,
      preflopRaiseAmount: THREE_BET_SIZE,
    }
  }

  return null
}

export async function getVillainAction(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  currentBoard: string[],
  pot: number,
  effectiveStack: number,
  villainIndex: number = 0
): Promise<VillainResponse> {
  // Preflop: use GTO range tables for deterministic fold/call/3-bet decisions
  if (currentStreet === 'Preflop') {
    const actingPosition = startState.villainPositions[villainIndex] ?? startState.villainPositions[0]
    const actingHand     = startState.villainHoleCards[villainIndex] ?? startState.villainHoleCards[0]
    // Hero's last preflop action (open size or 3-bet size)
    const lastHeroAct  = [...history].reverse().find(h => h.actor === 'hero' && h.street === 'Preflop')
    const heroActSize  = lastHeroAct?.amount ?? 2.5
    return getVillainPreflopDecision(
      actingPosition, actingHand, setup.position, startState.heroIsPFR,
      heroActSize, pot, effectiveStack,
    )
  }

  // Postflop: solver computes GTO frequencies, LLM explains the chosen action
  try {
    return await getVillainActionFromSolver(setup, startState, history, currentStreet, pot, effectiveStack, villainIndex)
  } catch (err) {
    // Solver unavailable — fall back to LLM so the game still works
    console.warn('Solver unavailable, falling back to LLM:', err)
    return getVillainActionLLM(setup, startState, history, currentStreet, currentBoard, pot, effectiveStack, villainIndex)
  }
}

async function getVillainActionLLM(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  currentBoard: string[],
  pot: number,
  effectiveStack: number,
  villainIndex: number = 0
): Promise<VillainResponse> {
  const historyText = history.length > 0
    ? history.map(h => `${h.street} - ${h.actor === 'hero' ? 'Hero' : 'Villain'}: ${h.action}${h.amount ? ` ${h.amount}bb` : ''}`).join('\n')
    : 'No previous action'

  const actingPosition = startState.villainPositions[villainIndex] ?? startState.villainPositions[0]
  const actingHand = startState.villainHoleCards[villainIndex] ?? startState.villainHoleCards[0]

  const prompt = `You are a GTO NLHE poker AI playing as villain. Determine your optimal action.

Game state:
- Hero position: ${setup.position} — hero is ${startState.heroIsIP ? 'IN POSITION (IP)' : 'OUT OF POSITION (OOP)'} post-flop
- Villain position: ${actingPosition}
- Villain hole cards (fixed — do NOT change): ${actingPosition}: ${actingHand}
- Stack depth: ${setup.stackDepth}
- Current street: ${currentStreet}
- Board: ${currentBoard.length > 0 ? currentBoard.join(' ') : 'none (preflop)'}
- Pot: ${pot}bb
- Effective stack: ${effectiveStack}bb

Hand history:
${historyText}

You have a SPECIFIC hand (listed above). Make every decision based on your actual hole cards and their equity on the current board — not range theory.

PREFLOP — You are ${actingPosition} facing a raise from hero (${setup.position}). GTO action required.
${actingPosition === 'BB' ? `
BB GTO ranges vs ${setup.position} open — you FOLD ~50% of hands, call ~35%, 3-bet ~15%.

3-BET VALUE (always 3-bet): QQ+, AKs, AKo
3-BET BLUFF (3-bet ~50% of the time): JJ, TT, AQs, AJs, A5s, A4s, A3s, A2s, K5s, 76s, 65s

CALL RANGE — call ONLY these hands (nothing else):
  Pairs: 22-99
  Offsuit broadways: AJo, ATo, KQo, KJo, KTo, QJo
  Suited: ATs-A6s, KTs-K8s, QTs-QJs, JTs, J9s, T9s, 98s, 87s, 76s, 65s, 54s

FOLD — fold everything NOT listed above. This includes:
  Weak offsuit: K2o-K9o (unless listed), Q2o-Q9o, J2o-J9o, T2o-T8o, 92o-97o, 82o-87o, 72o-76o, and any lower offsuit hands
  Low suited: 43s, 32s, 42s, 52s, 53s, 62s, 63s, 64s, 72s, 73s, 74s, 75s, 82s, 83s, 84s

CHECK: Does your hand ${actingHand} appear in the 3-BET or CALL lists above? If yes, use that action. If no, FOLD.` : `
${actingPosition} facing a ${setup.position} open:
  3-BET VALUE (always): QQ+, AKs, AKo
  3-BET BLUFF (sometimes): JJ, TT, AQs, A5s-A2s suited
  CALL: 99-22, AJs+, AQo, KQs, KJs, QJs, JTs, T9s, 98s, 87s, 76s
  FOLD: everything else (weak offsuit hands, low kickers, uncoordinated hands)`}
3-bet sizing: 3.5-4x hero's open if OOP, 3x if IP. Example: hero opens 2.5bb → 3-bet to 9-10bb OOP.

Return JSON only:
{
  "action": "check|bet|raise|call|fold",
  "amount": <bb if bet/raise, otherwise null>,
  "description": "e.g. 'BB 3-bets to 9bb' or 'BB calls' — NEVER mention hole cards here",
  "potOdds": "e.g. '3.2:1' if hero faces a bet, null otherwise",
  "newPot": <pot after this action>,
  "newStack": <effective stack after this action>,
  "isHandOver": <true only if villain folds>
}`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  })

  const data = JSON.parse(res.choices[0].message.content ?? '{}')
  return {
    action:      data.action      ?? 'check',
    amount:      data.amount      ?? undefined,
    description: data.description ?? 'Villain checks',
    potOdds:     data.potOdds     ?? null,
    newPot:      data.newPot      ?? pot,
    newStack:    data.newStack    ?? effectiveStack,
    isHandOver:  data.isHandOver  ?? false,
  }
}

export async function analyzeHand(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[]
): Promise<Analysis> {
  // Collect solver evaluations for every postflop hero decision.
  // Run these in parallel to minimise latency.
  const heroPostflopDecisions = history
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => h.actor === 'hero' && h.street !== 'Preflop')

  let solverEvals: HeroEval[] = []
  if (heroPostflopDecisions.length > 0) {
    try {
      // Approximate pot/stack at each decision by replaying history
      solverEvals = await Promise.all(
        heroPostflopDecisions.map(({ h, idx }) => {
          const { pot, stack } = potStackAt(history, idx, startState.pot, startState.effectiveStack)
          return evalHeroDecision(setup, startState, history, h, idx, pot, stack)
        })
      )
    } catch (err) {
      console.warn('Solver unavailable for analysis, proceeding without solver data:', err)
    }
  }

  return analyzeHandWithLLM(setup, startState, history, solverEvals)
}

// Approximate pot and effective stack at position `idx` in history.
function potStackAt(
  history: HandHistoryEntry[],
  idx: number,
  startPot: number,
  startStack: number
): { pot: number; stack: number } {
  let pot = startPot
  let stack = startStack
  for (let i = 0; i < idx; i++) {
    const h = history[i]
    const amt = h.amount ?? 0
    if (h.action === 'bet' || h.action === 'raise') {
      pot += amt; stack = h.actor === 'hero' ? stack - amt : stack
    } else if (h.action === 'call') {
      pot += amt
    }
  }
  return { pot: Math.round(pot * 10) / 10, stack: Math.max(0, Math.round(stack * 10) / 10) }
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

async function analyzeHandWithLLM(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  solverEvals: HeroEval[]
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
  const villainRangeDesc = startState.villainPositions
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
  const ctx = startState.preflopContext.toLowerCase()
  const isFacing3Bet = ctx.includes('3-bet') || ctx.includes('3bet') || ctx.includes('cold 3-bet')

  let preflopRangeBlock = ''
  if (isFacing3Bet) {
    const inRange = isHandInCall3BetRange(startState.holeCards, startState.heroIsIP)
    preflopRangeBlock = `\nPreflop GTO context (NO solver data for preflop — use ONLY this):
- Hero faces a 3-bet. GTO call range (${startState.heroIsIP ? 'IP' : 'OOP'}): ${call3BetRangeDesc(startState.heroIsIP)}
- Hero's hand (${startState.holeCards}): ${inRange ? 'IN the call range — calling is correct' : 'NOT in the call range — folding is correct. Do NOT recommend calling.'}`
  } else if (!startState.heroIsPFR) {
    // Hero faces a single open raise — check if hand qualifies as a cold-call
    const openerPos = startState.villainPositions[0] ?? 'unknown'
    const heroOpenRange = OPEN_RANGES[setup.position] ?? ''
    const inHeroRange = heroOpenRange ? isHandInRange(startState.holeCards, heroOpenRange) : false
    const EP_POSITIONS = ['UTG', 'UTG+1', 'MP']
    const openerIsTight = EP_POSITIONS.includes(openerPos)

    const coldCallVerdict = evalColdCallVsOpen(
      startState.holeCards, setup.position, inHeroRange, openerPos, openerIsTight, startState.heroIsIP
    )

    preflopRangeBlock = `\nPreflop GTO context (NO solver data for preflop — use ONLY this):
- Facing ${openerPos} single open (${openerIsTight ? 'tight EP range ~10-15%' : 'wider range ~18-50%'})
- Cold-call verdict: ${coldCallVerdict}`
  }

  // Range advantage context: tells LLM who has the stronger range on various boards
  const pfrPosition = startState.heroIsPFR ? setup.position : (startState.villainPositions[0] ?? 'villain')
  const callerPosition = startState.heroIsPFR ? (startState.villainPositions[0] ?? 'villain') : setup.position
  const rangeAdvantageNote = `Range dynamics: ${pfrPosition} was the PFR (preflop raiser) with a tighter, stronger range. ${callerPosition} called with a wider, weaker range. On boards with high cards (Q, J, T, K, A) and/or connectivity, the PFR's range has a significant range advantage — the caller has more low pairs, suited connectors, and speculative hands that miss these boards. When ${startState.heroIsPFR ? 'hero' : 'villain'} is the PFR and the board is high/connected, ${startState.heroIsPFR ? 'hero has range advantage — betting is correct' : 'villain has range advantage — hero (caller) should check at a high frequency with weak made hands and unimproved pairs below the board'}.`

  // Format solver evaluations so the LLM can reference exact GTO frequencies
  const solverBlock = solverEvals.length > 0
    ? `\nSOLVER DATA (use as a signal — cross-check with range advantage before concluding hero should bet):\n` +
      solverEvals.map(e => {
        const gto = e.gtoFrequencies
          .filter(a => a.frequency > 0.02)
          .map(a => `${a.action}${a.amount ? ` ${a.amount}bb` : ''} ${(a.frequency * 100).toFixed(0)}%`)
          .join(', ')
        const heroFreq = e.gtoFrequencies.find(a => a.action === e.heroAction)
        const heroGtoFreq = heroFreq ? (heroFreq.frequency * 100).toFixed(0) : '0'
        return `- ${e.street}: Hero ${e.heroAction}${e.heroAmount ? ` ${e.heroAmount}bb` : ''} (GTO frequency: ${heroGtoFreq}%). Full GTO mix: ${gto}. Hero equity: ${(e.heroEquity * 100).toFixed(0)}%.`
      }).join('\n')
    : ''

  const prompt = `You are a brutally precise NLHE poker coach. Your job is to give the hero exact, actionable feedback — no hedging, no vague advice.

Context:
- Hero: ${setup.position}, hole cards: ${startState.holeCards}, stack: ${setup.stackDepth}
- Villain(s): ${villainRangeDesc}
- Board: ${boardStr}
- Hero is ${startState.heroIsIP ? 'IN POSITION (IP)' : 'OUT OF POSITION (OOP)'} post-flop
- ${setup.isMultiway ? 'Multiway pot' : 'Heads-up pot'}
- Preflop: ${startState.preflopContext}
- ${rangeAdvantageNote}${preflopRangeBlock}
- Hero's ACTUAL made hand per street (computed from hole cards + board — AUTHORITATIVE, do NOT override):
${heroHandBlock}

Streets played (ONLY include these in streetFeedback — do NOT generate feedback for any other street): ${streetsPlayed.join(', ')}

Full hand history (each hero action is tagged [FIRST TO ACT] or [RESPONDING to villain bet]):
${fullHistory}
${solverBlock}

RULES — violating any of these makes the analysis useless:
1. SOLVER DATA IS A SIGNAL, NOT GOSPEL. Cite the GTO% and equity from solver data, but always cross-check it against range advantage and board texture before recommending a bet. The solver runs with a simplified bet tree and limited iterations — its frequencies can be wrong on complex boards.
2. RANGE ADVANTAGE CHECK (do this before every postflop street evaluation):
   - Who is the PFR (preflop raiser)? Their range has more strong hands (overpairs, top pair top kicker, sets) than the caller's range.
   - Does the board texture (high cards, connectivity, suits) connect better with the PFR's range or the caller's range?
   - High connected boards (Q-J-9, K-Q-T, J-T-8) almost always favor the PFR's range — the caller's range is full of low pairs and speculative hands that miss.
   - If the board heavily favors villain's range and hero is OOP (out of position), checking at a high frequency is correct EVEN IF the solver shows a moderate betting frequency. Pocket pairs below the board texture, gutshots, and overcardless hands should check on these boards.
   - If hero is IP and the board favors villain's range, hero can still bet but must acknowledge the range disadvantage.
3. BET SIZING MUST MATCH HAND STRENGTH AND GOAL:
   - WEAK two pair (paired the bottom board card with a shared community pair overhead, e.g. 23s on AAQT2) → treat like bottom pair. If the board favors villain's range (villain was the PFR with a tighter, stronger range, and the community pair connects with that range — e.g. AA board when villain opened, Kx board when villain raised from EP), CHECK. Villain's range is full of Ax/Kx hands that have hero crushed; betting for "value" is value-owning yourself. Only consider a tiny bet (20-25% pot) if villain's range is clearly capped and cannot have the community pair.
   - Thin value bets (second pair, weak top pair, marginal made hands) → use SMALL sizing (25-40% pot). Villain's calling range is narrow; a small bet gets called by more hands that beat nothing, maximizes EV against weak holdings, and loses less when villain has a strong hand.
   - Strong value bets (top pair top kicker, two pair, sets, flushes) → use MEDIUM sizing (50-75% pot). Charge draws, get value from villain's strong-but-worse hands.
   - Nut hands or very polarized ranges → LARGE sizing (75-100%+ pot). Max value from top of villain's calling range.
   - NEVER recommend 75%+ pot as a "value bet" for a hand that is medium strength (second pair, weak top pair). A large bet with a marginal hand is either a bluff (if villain folds better) or value-owning yourself (if villain calls with better). Call it out explicitly when the solver's suggested sizing conflicts with the hand's actual strength.
4. NEVER use vague language. Replace: "you might consider betting" → "bet Nbb (X% pot)". Replace: "passivity" → "checked top pair on dry board with 61% equity, giving villain a free card".
5. betterPlay must include sizing tied to a specific reason. Example: "Bet 3bb (33% pot) — thin value against villain's missed draws and weaker pairs; small sizing gets more calls from hands you beat and loses less to strong hands." or "Bet 8bb (75% pot) — strong two pair on a paired board; charge villain's one-pair hands and flushes."
6. explanation must name the specific hand category (top pair, flush draw, gutshot, etc.), identify range advantage, and do the pot-odds math explicitly when hero faced a bet. For POSTFLOP decisions only: cite GTO% and equity from solver data. For PREFLOP decisions: use the "Preflop GTO context" above — do NOT cite solver data, it does not exist for preflop.
7. summary must open with the single costliest decision: "The key mistake was [specific action] on [street] — [equity/frequency reason why]."
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

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  })

  return JSON.parse(res.choices[0].message.content ?? '{}') as Analysis
}
