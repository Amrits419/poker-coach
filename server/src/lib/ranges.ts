// Approximate GTO preflop ranges in postflop-solver range string format.
// These are used to seed the solver with realistic starting ranges.
// Frequencies after ":" are between 0 and 1 (omitting = 1.0 = always in range).

const RANK_ORDER = '23456789TJQKA'

function normalizeHand(hand: string): string {
  const r1 = hand[0], s1 = hand[1], r2 = hand[2], s2 = hand[3]
  if (!r1 || !r2) return ''
  const i1 = RANK_ORDER.indexOf(r1), i2 = RANK_ORDER.indexOf(r2)
  const [hi, lo, sh, sl] = i1 >= i2 ? [r1, r2, s1, s2] : [r2, r1, s2, s1]
  return hi === lo ? `${hi}${hi}` : `${hi}${lo}${sh === sl ? 's' : 'o'}`
}

export function freqInRange(hand: string, rangeStr: string): number {
  if (!rangeStr) return 0
  const norm = normalizeHand(hand)
  for (const part of rangeStr.split(',')) {
    const trimmed = part.trim()
    const colon = trimmed.indexOf(':')
    const h = colon >= 0 ? trimmed.slice(0, colon) : trimmed
    const f = colon >= 0 ? parseFloat(trimmed.slice(colon + 1)) : 1.0
    if (h === norm) return f
  }
  return 0
}

export function isHandInRange(hand: string, rangeStr: string): boolean {
  return freqInRange(hand, rangeStr) > 0
}

/** "8cJd" → "Jd8c": a single specific combo in postflop-solver syntax (higher rank first). */
export function specificCombo(hand: string): string {
  const r1 = hand[0], s1 = hand[1], r2 = hand[2], s2 = hand[3]
  if (!r1 || !s1 || !r2 || !s2) return ''
  return RANK_ORDER.indexOf(r1) >= RANK_ORDER.indexOf(r2) ? `${r1}${s1}${r2}${s2}` : `${r2}${s2}${r1}${s1}`
}

/** Hero can be dealt (and play) hands outside the modeled preflop range. The solver
 *  can only grade a hand it knows about, so add that exact combo to hero's range. */
export function withHandInRange(rangeStr: string, hand: string): string {
  if (!hand || freqInRange(hand, rangeStr) > 0) return rangeStr
  const combo = specificCombo(hand)
  return combo ? `${rangeStr}, ${combo}` : rangeStr
}

export function isHandIn3BetRange(hand: string): boolean {
  return freqInRange(hand, THREE_BET_IP) > 0 || freqInRange(hand, THREE_BET_OOP) > 0
}

export function isHandInCall3BetRange(hand: string, heroIsIP: boolean): boolean {
  return freqInRange(hand, heroIsIP ? CALL_3BET_IP : CALL_3BET_OOP) > 0
}

/** Hero's GTO aggression/call frequencies for a preflop decision: facing a single
 *  open (3-bet vs call) or facing a 3-bet (4-bet vs call). Drives the coach's
 *  preflop verdict so premium pairs are never graded as "set-mining calls". */
export function heroPreflopFrequencies(
  hand: string,
  heroIsIP: boolean,
  facing: 'open' | '3bet',
): { aggrFreq: number; callFreq: number; aggrRangeDesc: string; callRangeDesc: string } {
  if (facing === '3bet') {
    const callRng = heroIsIP ? CALL_3BET_IP : CALL_3BET_OOP
    return {
      aggrFreq: freqInRange(hand, FOUR_BET_RANGE),
      callFreq: freqInRange(hand, callRng),
      aggrRangeDesc: rangeDesc(FOUR_BET_RANGE),
      callRangeDesc: call3BetRangeDesc(heroIsIP),
    }
  }
  const aggrRng = heroIsIP ? THREE_BET_IP : THREE_BET_OOP
  return { aggrFreq: freqInRange(hand, aggrRng), callFreq: 0, aggrRangeDesc: rangeDesc(aggrRng), callRangeDesc: '' }
}

/** "AA,KK,QQ:0.4" → "AA, KK, QQ (40%)" */
function rangeDesc(rangeStr: string): string {
  return rangeStr.split(',').map(p => {
    const [h, f] = p.trim().split(':')
    return f ? `${h} (${Math.round(parseFloat(f) * 100)}%)` : h
  }).join(', ')
}

export function call3BetRangeDesc(heroIsIP: boolean): string {
  return heroIsIP
    ? 'QQ (50%), JJ, TT, 99, AKs, AQs, AJs, KQs, AKo, AQo'
    : 'JJ, TT, AKs, AKo'
}

// PokerCoaching.com GTO charts (100bb, ante in play)
// Combo counts: UTG=134, UTG+1=190, UTG+2=208, LJ=242, HJ=282, CO=358, BTN=678
export const OPEN_RANGES: Record<string, string> = {
  // 10.1% — 134 combos: AA-88(42) + AKs-ATs,KQs-KJs,QJs,JTs(32) + AKo-ATo,KQo(60)
  UTG:    'AA,KK,QQ,JJ,TT,99,88,AKs,AQs,AJs,ATs,KQs,KJs,QJs,JTs,AKo,AQo,AJo,ATo,KQo',

  // 14.3% — 190 combos: UTG + 77,A9s-A2s(all low aces),KTs,QTs,T9s,98s,87s,KJo
  'UTG+1':'AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,AKo,AQo,AJo,ATo,KQo,KJo',

  // 15.7% — 208 combos: UTG+1 + 66,J9s,T8s,76s,65s
  MP:     'AA,KK,QQ,JJ,TT,99,88,77,66,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,QJs,QTs,JTs,J9s,T9s,T8s,98s,87s,76s,65s,AKo,AQo,AJo,ATo,KQo,KJo',

  // 18.3% — 242 combos: MP + 55,K9s,Q9s,86s,75s,54s,QJo
  HJ:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,QJs,QTs,Q9s,JTs,J9s,T9s,T8s,98s,87s,86s,76s,75s,65s,54s,AKo,AQo,AJo,ATo,KQo,KJo,QJo',

  // 27.0% — 358 combos: HJ + 44,33,22 + more suited + ATo,A9o,A8o,KTo,QTo,JTo
  CO:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,QJs,QTs,Q9s,Q8s,JTs,J9s,J8s,T9s,T8s,98s,97s,87s,86s,76s,75s,65s,64s,54s,AKo,AQo,AJo,ATo,A9o,A8o,KQo,KJo,KTo,QJo,QTo,JTo',

  // 51.1% — 678 combos: essentially all playable hands
  BTN:    'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,K7s,K6s,K5s,K4s,K3s,K2s,QJs,QTs,Q9s,Q8s,Q7s,JTs,J9s,J8s,J7s,T9s,T8s,T7s,98s,97s,96s,87s,86s,85s,76s,75s,74s,65s,64s,63s,54s,53s,43s,AKo,AQo,AJo,ATo,A9o,A8o,A7o,A6o,A5o,KQo,KJo,KTo,K9o,K8o,QJo,QTo,Q9o,JTo,J9o,T9o',

  // SB: raise for value, raise/limp as bluff — use CO-width for RFI purposes
  SB:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,QJs,QTs,Q9s,JTs,J9s,T9s,T8s,98s,87s,76s,65s,54s,AKo,AQo,AJo,ATo,A9o,KQo,KJo,KTo,QJo',
}

// BB calling ranges vs different open positions
export const BB_CALL: Record<string, string> = {
  BTN:    'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,QJs,QTs,Q9s,JTs,J9s,J8s,T9s,T8s,98s,97s,87s,86s,76s,75s,65s,54s,AKo,AQo,AJo,ATo,A9o,KQo,KJo,QJo,JTo',
  CO:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,KQs,KJs,KTs,K9s,QJs,QTs,Q9s,JTs,J9s,T9s,98s,87s,76s,65s,AKo,AQo,AJo,ATo,KQo,KJo,QJo',
  HJ:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A5s,A4s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,AKo,AQo,AJo,ATo,KQo,KJo',
  MP:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,AKs,AQs,AJs,ATs,A9s,A8s,A5s,A4s,KQs,KJs,KTs,QJs,JTs,T9s,98s,87s,AKo,AQo,AJo,KQo',
  'UTG+1':'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A8s,A5s,KQs,KJs,KTs,QJs,JTs,T9s,98s,AKo,AQo,AJo,KQo',
  UTG:    'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A5s,KQs,KJs,KTs,QJs,JTs,T9s,AKo,AQo,AJo,KQo',
}
export const BB_CALL_DEFAULT = BB_CALL.CO

// SB calling range vs BTN
export const SB_CALL_BTN = 'AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,A9s,A8s,KQs,KJs,KTs,QJs,JTs,T9s,AKo,AQo,AJo,KQo'

// 3-bet ranges (value + bluffs, polarised)
export const THREE_BET_IP  = 'AA,KK,QQ,JJ:0.5,AKs,AQs:0.5,A5s,A4s,KQs:0.5,AKo,AQo:0.3'
export const THREE_BET_OOP = 'AA,KK,QQ,JJ:0.5,AKs,AKo,A5s:0.5,A4s:0.5'

// Calling a 3-bet
export const CALL_3BET_IP  = 'QQ:0.5,JJ,TT,99,AKs,AQs,AJs,KQs,AKo,AQo'
export const CALL_3BET_OOP = 'JJ,TT,AKs,AKo'

// 4-bet range (villain responds to hero's 3-bet with a 4-bet)
export const FOUR_BET_RANGE = 'AA,KK,QQ:0.4,AKs:0.4,AKo:0.3,A5s:0.3,A4s:0.3'

// ── Public interface ─────────────────────────────────────────────────────────

/** Returns true if villainPos would call or 3-bet heroPos's open with this hand. */
export function willVillainDefend(villainPos: string, hand: string, heroPos: string): boolean {
  const callRng = villainPos === 'BB'
    ? (BB_CALL[heroPos] ?? BB_CALL_DEFAULT)
    : villainPos === 'SB'
    ? SB_CALL_BTN
    : (BB_CALL[heroPos] ?? BB_CALL_DEFAULT)
  return freqInRange(hand, callRng) > 0 || freqInRange(hand, THREE_BET_OOP) > 0 || freqInRange(hand, THREE_BET_IP) > 0
}

export interface RangePair {
  oopRange: string
  ipRange:  string
}

export const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN']

// Position is relative: a seat is IP only if it acts after every opponent postflop.
export function isHeroInPosition(heroPosition: string, villainPositions: string[]): boolean {
  const heroIdx = POSTFLOP_ORDER.indexOf(heroPosition)
  return villainPositions.every(v => POSTFLOP_ORDER.indexOf(v) < heroIdx)
}

const actsAfter = (a: string, b: string) => POSTFLOP_ORDER.indexOf(a) > POSTFLOP_ORDER.indexOf(b)

/** Flatting range against a single open. */
function callRangeVsOpen(callerPos: string, openerPos: string): string {
  return callerPos === 'SB' ? SB_CALL_BTN : (BB_CALL[openerPos] ?? BB_CALL_DEFAULT)
}

// Calling a 4-bet / continuing against a jam
export const CALL_4BET = 'QQ,JJ,AKs,AKo'
const CALL_JAM_WIDE  = 'AA,KK,QQ,JJ,TT,AKs,AKo,AQs'
const CALL_JAM_TIGHT = 'AA,KK,QQ,AKs,AKo'

/** How preflop ended: single-raised, 3-bet or 4-bet(+) pot. */
export type PotType = 'srp' | '3bet' | '4bet'

/**
 * OOP and IP ranges for a heads-up postflop spot, from how preflop ended.
 * Both players' actual hands are added to their range when the tables don't
 * contain them, so the solver can always answer for the hand that was played.
 */
export function getRangesForSpot(o: {
  heroPosition: string
  villainPosition: string
  heroIsIP: boolean
  heroIsAggressor: boolean   // hero made the last preflop raise
  potType: PotType
  heroHand?: string
  villainHand?: string
}): RangePair {
  const aggrPos   = o.heroIsAggressor ? o.heroPosition : o.villainPosition
  const callerPos = o.heroIsAggressor ? o.villainPosition : o.heroPosition
  const aggrIsIP  = o.heroIsAggressor ? o.heroIsIP : !o.heroIsIP

  let aggrRange: string
  let callRange: string
  if (o.potType === '4bet') {
    aggrRange = FOUR_BET_RANGE
    callRange = CALL_4BET
  } else if (o.potType === '3bet') {
    aggrRange = aggrIsIP ? THREE_BET_IP : THREE_BET_OOP
    callRange = aggrIsIP ? CALL_3BET_OOP : CALL_3BET_IP
  } else {
    aggrRange = OPEN_RANGES[aggrPos] ?? OPEN_RANGES.CO
    callRange = callRangeVsOpen(callerPos, aggrPos)
  }

  let heroRange    = o.heroIsAggressor ? aggrRange : callRange
  let villainRange = o.heroIsAggressor ? callRange : aggrRange
  if (o.heroHand)    heroRange    = withHandInRange(heroRange, o.heroHand)
  if (o.villainHand) villainRange = withHandInRange(villainRange, o.villainHand)

  return o.heroIsIP
    ? { oopRange: villainRange, ipRange: heroRange }
    : { oopRange: heroRange,   ipRange: villainRange }
}

// ── Villain preflop play ─────────────────────────────────────────────────────

export interface VillainPreflopSpot {
  pos: string
  hand: string
  raises: number                // raises so far: 0 unopened/limped, 1 open, 2 three-bet, ...
  aggressorPos: string | null   // who made the last raise
  raisedBefore: boolean         // this villain made an earlier raise (opener facing a 3-bet, ...)
  currentBet: number            // total to match
  myIn: number                  // chips this villain already has in
  stackTotal: number            // myIn + chips behind
}

/** The raise and continue ranges a villain uses in a preflop spot. */
function villainPreflopRanges(s: VillainPreflopSpot): { aggr: string; call: string } {
  const isOOP = s.aggressorPos ? !actsAfter(s.pos, s.aggressorPos) : true

  // Facing a bet that commits a big part of the stack: continue with premiums only.
  if (s.currentBet >= 0.4 * s.stackTotal) {
    return { aggr: '', call: s.raises <= 2 ? CALL_JAM_WIDE : CALL_JAM_TIGHT }
  }
  if (s.raises === 0) {
    // Limped to this seat: raise the top of the range, otherwise see a cheap flop.
    return { aggr: THREE_BET_OOP, call: BB_CALL.BTN }
  }
  if (s.raises === 1) {
    return { aggr: isOOP ? THREE_BET_OOP : THREE_BET_IP, call: callRangeVsOpen(s.pos, s.aggressorPos ?? 'CO') }
  }
  if (s.raises === 2) {
    return s.raisedBefore
      ? { aggr: FOUR_BET_RANGE, call: isOOP ? CALL_3BET_OOP : CALL_3BET_IP }   // opener facing a 3-bet
      : { aggr: 'AA,KK', call: 'QQ,AKs' }                                      // cold, behind an open and a 3-bet
  }
  if (s.raises === 3) {
    return s.raisedBefore ? { aggr: 'AA,KK', call: CALL_4BET } : { aggr: 'AA,KK', call: '' }
  }
  return { aggr: '', call: CALL_JAM_TIGHT }
}

/** Raise / continue frequencies: lets the server predict the flop (and pre-solve it). */
export function villainPreflopFreqs(s: VillainPreflopSpot): { aggrFreq: number; callFreq: number } {
  const { aggr, call } = villainPreflopRanges(s)
  return { aggrFreq: freqInRange(s.hand, aggr), callFreq: freqInRange(s.hand, call) }
}

const RAISE_NAMES = ['raises', '3-bets', '4-bets', '5-bets']

/** A villain's preflop action from the range tables. `amount` is the total raised or called to. */
export function villainPreflopAction(
  s: VillainPreflopSpot,
  rand: () => number = Math.random,
): { action: 'fold' | 'check' | 'call' | 'raise'; amount?: number; description: string } {
  const { aggrFreq, callFreq } = villainPreflopFreqs(s)
  const half = (n: number) => Math.round(n * 2) / 2

  if (aggrFreq > 0 && rand() < aggrFreq && s.stackTotal > s.currentBet) {
    const isOOP = s.aggressorPos ? !actsAfter(s.pos, s.aggressorPos) : true
    let to = s.raises === 0 ? 4
      : s.raises === 1 ? half(s.currentBet * (isOOP ? 3.5 : 3))
      : s.raises === 2 ? half(s.currentBet * 2.3)
      : s.stackTotal
    if (to >= 0.45 * s.stackTotal) to = s.stackTotal
    const verb = RAISE_NAMES[Math.min(s.raises, RAISE_NAMES.length - 1)]
    return {
      action: 'raise', amount: to,
      description: to >= s.stackTotal ? `${s.pos} moves all-in for ${to}bb` : `${s.pos} ${verb} to ${to}bb`,
    }
  }
  if (s.currentBet <= s.myIn) return { action: 'check', description: `${s.pos} checks` }
  if (callFreq > 0) {
    const to = Math.min(s.currentBet, s.stackTotal)
    return { action: 'call', amount: to, description: `${s.pos} calls ${to}bb` }
  }
  return { action: 'fold', description: `${s.pos} folds` }
}
