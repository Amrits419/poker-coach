// Approximate GTO preflop ranges in postflop-solver range string format.
// These are used to seed the solver with realistic starting ranges.
// Frequencies after ":" are between 0 and 1 (omitting = 1.0 = always in range).

export const OPEN_RANGES: Record<string, string> = {
  UTG:    'AA,KK,QQ,JJ,TT,99,AKs,AQs,AJs,ATs,KQs,KJs,AKo,AQo',
  'UTG+1':'AA,KK,QQ,JJ,TT,99,88,AKs,AQs,AJs,ATs,A9s,KQs,KJs,KTs,AKo,AQo,AJo',
  MP:     'AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,A9s,A8s,KQs,KJs,KTs,QJs,AKo,AQo,AJo,KQo',
  HJ:     'AA,KK,QQ,JJ,TT,99,88,77,66,AKs,AQs,AJs,ATs,A9s,A8s,A7s,KQs,KJs,KTs,K9s,QJs,QTs,JTs,AKo,AQo,AJo,ATo,KQo,KJo',
  CO:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,KQs,KJs,KTs,K9s,K8s,QJs,QTs,Q9s,JTs,J9s,T9s,98s,87s,76s,AKo,AQo,AJo,ATo,A9o,KQo,KJo,KTo,QJo',
  BTN:    'AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,K7s,K6s,K5s,QJs,QTs,Q9s,Q8s,JTs,J9s,J8s,T9s,T8s,98s,97s,87s,86s,76s,75s,65s,64s,54s,AKo,AQo,AJo,ATo,A9o,A8o,A7o,KQo,KJo,KTo,K9o,QJo,QTo,JTo',
  SB:     'AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,KQs,KJs,KTs,K9s,K8s,QJs,QTs,Q9s,JTs,J9s,T9s,98s,87s,76s,65s,AKo,AQo,AJo,ATo,A9o,KQo,KJo,QJo',
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
const CALL_3BET_IP  = 'QQ:0.5,JJ,TT,99,AKs,AQs,AJs,KQs,AKo,AQo'
const CALL_3BET_OOP = 'JJ,TT,AKs,AKo'

// ── Public interface ─────────────────────────────────────────────────────────

export interface RangePair {
  oopRange: string
  ipRange:  string
}

/**
 * Derive OOP and IP ranges from the preflop context for use in the postflop solver.
 * Falls back to reasonable defaults when the context is ambiguous.
 */
export function getRangesForSpot(
  heroPosition: string,
  villainPositions: string[],
  heroIsIP: boolean,
  preflopContext: string
): RangePair {
  const ctx = preflopContext.toLowerCase()
  const villain = villainPositions[0] ?? 'BB'
  const is3bet = ctx.includes('3-bet') || ctx.includes('3bet') || ctx.includes('re-raise')

  if (is3bet) {
    // Hero 3-bet IP or OOP
    const heroRange   = heroIsIP ? THREE_BET_IP  : THREE_BET_OOP
    const villainRange = heroIsIP ? CALL_3BET_OOP : CALL_3BET_IP
    return heroIsIP
      ? { oopRange: villainRange, ipRange: heroRange }
      : { oopRange: heroRange,   ipRange: villainRange }
  }

  // Single-raised pot: identify opener and caller
  const heroOpened  = ctx.includes('you open') || ctx.includes(`you're first`)
  const villainIsOP = ctx.includes(`${villain.toLowerCase()} open`) || ctx.includes('opens')

  if (heroOpened || (!villainIsOP && heroIsIP)) {
    // Hero opened, villain called
    const openRange   = OPEN_RANGES[heroPosition] ?? OPEN_RANGES.CO
    const callRange   = villain === 'BB'
      ? (BB_CALL[heroPosition] ?? BB_CALL_DEFAULT)
      : villain === 'SB' ? SB_CALL_BTN : BB_CALL_DEFAULT
    return heroIsIP
      ? { oopRange: callRange,  ipRange: openRange }
      : { oopRange: openRange,  ipRange: callRange  }
  }

  // Villain opened, hero called
  const openRange  = OPEN_RANGES[villain] ?? OPEN_RANGES.CO
  const callRange  = heroPosition === 'BB'
    ? (BB_CALL[villain] ?? BB_CALL_DEFAULT)
    : heroPosition === 'SB' ? SB_CALL_BTN : BB_CALL_DEFAULT
  return heroIsIP
    ? { oopRange: openRange, ipRange: callRange }
    : { oopRange: callRange, ipRange: openRange  }
}
