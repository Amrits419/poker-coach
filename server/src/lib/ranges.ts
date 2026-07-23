// Approximate GTO preflop ranges in postflop-solver range string format.
// These are used to seed the solver with realistic starting ranges.
// Frequencies after ":" are between 0 and 1 (omitting = 1.0 = always in range).

import type { VillainResponse } from './types'

const RANK_ORDER = '23456789TJQKA'

function normalizeHand(hand: string): string {
  const r1 = hand[0], s1 = hand[1], r2 = hand[2], s2 = hand[3]
  if (!r1 || !r2) return ''
  const i1 = RANK_ORDER.indexOf(r1), i2 = RANK_ORDER.indexOf(r2)
  const [hi, lo, sh, sl] = i1 >= i2 ? [r1, r2, s1, s2] : [r2, r1, s2, s1]
  return hi === lo ? `${hi}${hi}` : `${hi}${lo}${sh === sl ? 's' : 'o'}`
}

function freqInRange(hand: string, rangeStr: string): number {
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

export function isHandIn3BetRange(hand: string): boolean {
  return freqInRange(hand, THREE_BET_IP) > 0 || freqInRange(hand, THREE_BET_OOP) > 0
}

export function isHandInCall3BetRange(hand: string, heroIsIP: boolean): boolean {
  return freqInRange(hand, heroIsIP ? CALL_3BET_IP : CALL_3BET_OOP) > 0
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
const BB_CALL: Record<string, string> = {
  BTN:    'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,QJs,QTs,Q9s,JTs,J9s,J8s,T9s,T8s,98s,97s,87s,86s,76s,75s,65s,54s,AKo,AQo,AJo,ATo,A9o,KQo,KJo,QJo,JTo',
  CO:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,KQs,KJs,KTs,K9s,QJs,QTs,Q9s,JTs,J9s,T9s,98s,87s,76s,65s,AKo,AQo,AJo,ATo,KQo,KJo,QJo',
  HJ:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A5s,A4s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,AKo,AQo,AJo,ATo,KQo,KJo',
  MP:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,AKs,AQs,AJs,ATs,A9s,A8s,A5s,A4s,KQs,KJs,KTs,QJs,JTs,T9s,98s,87s,AKo,AQo,AJo,KQo',
  'UTG+1':'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A8s,A5s,KQs,KJs,KTs,QJs,JTs,T9s,98s,AKo,AQo,AJo,KQo',
  UTG:    'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A5s,KQs,KJs,KTs,QJs,JTs,T9s,AKo,AQo,AJo,KQo',
}
const BB_CALL_DEFAULT = BB_CALL.CO

// SB calling range vs BTN
const SB_CALL_BTN = 'AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,A9s,A8s,KQs,KJs,KTs,QJs,JTs,T9s,AKo,AQo,AJo,KQo'

// 3-bet ranges (value + bluffs, polarised)
const THREE_BET_IP  = 'AA,KK,QQ,JJ:0.5,AKs,AQs:0.5,A5s,A4s,KQs:0.5,AKo,AQo:0.3'
const THREE_BET_OOP = 'AA,KK,QQ,JJ:0.5,AKs,AKo,A5s:0.5,A4s:0.5'

// Calling a 3-bet
export const CALL_3BET_IP  = 'QQ:0.5,JJ,TT,99,AKs,AQs,AJs,KQs,AKo,AQo'
export const CALL_3BET_OOP = 'JJ,TT,AKs,AKo'

// 4-bet range (villain responds to hero's 3-bet with a 4-bet)
const FOUR_BET_RANGE = 'AA,KK,QQ:0.4,AKs:0.4,AKo:0.3,A5s:0.3,A4s:0.3'

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

/**
 * Derive OOP and IP ranges for the postflop solver.
 * heroIsPFR = true  → hero made the last preflop raise (opened or 3-bet).
 * heroIsPFR = false → hero called a raise (villain was the last aggressor).
 * preflopContext is still used only for 3-bet pot detection (reliable keyword match).
 */
export function getRangesForSpot(
  heroPosition: string,
  villainPositions: string[],
  heroIsIP: boolean,
  heroIsPFR: boolean,
  preflopContext: string
): RangePair {
  const villain = villainPositions[0] ?? 'BB'
  const ctx = preflopContext.toLowerCase()
  const is3bet = ctx.includes('3-bet') || ctx.includes('3bet') || ctx.includes('re-raise')

  let heroRange: string
  let villainRange: string

  if (is3bet && heroIsPFR) {
    // Hero 3-bet; villain called
    heroRange    = heroIsIP ? THREE_BET_IP  : THREE_BET_OOP
    villainRange = heroIsIP ? CALL_3BET_OOP : CALL_3BET_IP
  } else if (is3bet && !heroIsPFR) {
    // Villain 3-bet; hero called
    villainRange = heroIsIP ? THREE_BET_OOP : THREE_BET_IP
    heroRange    = heroIsIP ? CALL_3BET_IP  : CALL_3BET_OOP
  } else if (heroIsPFR) {
    // Single-raised pot; hero opened
    heroRange    = OPEN_RANGES[heroPosition] ?? OPEN_RANGES.CO
    villainRange = villain === 'BB'
      ? (BB_CALL[heroPosition] ?? BB_CALL_DEFAULT)
      : villain === 'SB' ? SB_CALL_BTN : BB_CALL_DEFAULT
  } else {
    // Single-raised pot; villain opened, hero called
    villainRange = OPEN_RANGES[villain] ?? OPEN_RANGES.CO
    heroRange    = heroPosition === 'BB'
      ? (BB_CALL[villain] ?? BB_CALL_DEFAULT)
      : heroPosition === 'SB' ? SB_CALL_BTN : BB_CALL_DEFAULT
  }

  // Assign hero/villain ranges to the OOP and IP solver slots.
  return heroIsIP
    ? { oopRange: villainRange, ipRange: heroRange }
    : { oopRange: heroRange,   ipRange: villainRange }
}

const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN']

/**
 * Determine villain's preflop action using GTO range tables.
 * heroIsPFR=true  → hero opened; villain is defending (call/3-bet/fold).
 * heroIsPFR=false → villain opened; hero 3-bet; villain responds (call/4-bet/fold).
 */
export function getVillainPreflopDecision(
  actingPosition: string,
  hand: string,
  heroPosition: string,
  heroIsPFR: boolean,
  heroActionSize: number,
  pot: number,
  effectiveStack: number,
): VillainResponse {
  const heroPostIdx  = POSTFLOP_ORDER.indexOf(heroPosition)
  const villPostIdx  = POSTFLOP_ORDER.indexOf(actingPosition)
  const villainIsOOP = villPostIdx !== -1 && heroPostIdx !== -1 && villPostIdx < heroPostIdx

  let callRng = ''
  let aggrRng = ''

  if (heroIsPFR) {
    if (actingPosition === 'BB') {
      callRng = BB_CALL[heroPosition] ?? BB_CALL_DEFAULT
      aggrRng = THREE_BET_OOP
    } else if (actingPosition === 'SB') {
      callRng = SB_CALL_BTN
      aggrRng = THREE_BET_OOP
    } else {
      callRng = BB_CALL[heroPosition] ?? BB_CALL_DEFAULT
      aggrRng = villainIsOOP ? THREE_BET_OOP : THREE_BET_IP
    }
  } else {
    // Villain opened, hero 3-bet, villain now responds
    callRng = villainIsOOP ? CALL_3BET_OOP : CALL_3BET_IP
    aggrRng = FOUR_BET_RANGE
  }

  const aggrFreq = freqInRange(hand, aggrRng)
  const callFreq = freqInRange(hand, callRng)
  const postedBlind = actingPosition === 'BB' ? 1.0 : actingPosition === 'SB' ? 0.5 : 0

  if (aggrFreq > 0 && Math.random() < aggrFreq) {
    const mult   = villainIsOOP ? 3.5 : 3.0
    const raiseAmt = Math.round(heroActionSize * mult * 10) / 10
    const addedByVillain = Math.max(0, raiseAmt - postedBlind)
    const newPot = pot + heroActionSize + addedByVillain
    return {
      action: 'raise',
      amount: raiseAmt,
      description: `${actingPosition} ${heroIsPFR ? '3-bets' : '4-bets'} to ${raiseAmt}bb`,
      potOdds: `${Math.round(newPot / raiseAmt * 10) / 10}:1`,
      newPot,
      newStack: Math.max(0, effectiveStack - addedByVillain),
      isHandOver: false,
    }
  }

  if (callFreq > 0) {
    const callAdd = Math.max(0, heroActionSize - postedBlind)
    const newPot  = pot + heroActionSize + callAdd
    return {
      action: 'call',
      amount: heroActionSize,
      description: `${actingPosition} calls ${heroActionSize}bb`,
      potOdds: null,
      newPot,
      newStack: Math.max(0, effectiveStack - callAdd),
      isHandOver: false,
    }
  }

  return {
    action: 'fold',
    description: `${actingPosition} folds`,
    potOdds: null,
    newPot: pot,
    newStack: effectiveStack,
    isHandOver: true,
  }
}
