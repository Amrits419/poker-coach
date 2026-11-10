import type { ParsedHand } from './model'
import {
  OPEN_RANGES, BB_CALL, BB_CALL_DEFAULT, SB_CALL_BTN, FOUR_BET_RANGE,
  CALL_3BET_IP, CALL_3BET_OOP, THREE_BET_IP, THREE_BET_OOP,
  freqInRange, heroPreflopFrequencies, POSTFLOP_ORDER,
} from '../ranges'

// Approximate tables for lines the trainer never deals. They are labelled as
// approximations wherever they are used.
export const COLD_CALL = 'TT,99,88,77,66,55,44,33,22,AQs,AJs,ATs,KQs,KJs,QJs,JTs,T9s,98s,87s,76s,AQo'
export const FOUR_BET_CALL = 'QQ,JJ:0.5,AKs,AKo:0.5'
const ISO_RAISE = 'AA,KK,QQ,JJ,TT,99,88,77,AKs,AQs,AJs,ATs,KQs,KJs,AKo,AQo,AJo,KQo'
const VS_FOUR_BET_RAISE = 'AA,KK,AKs:0.5'
const VS_FOUR_BET_CALL = 'QQ,JJ:0.5,AKs,AKo'

export type Situation = 'unopened' | 'limped' | 'facing_open' | 'facing_3bet' | 'facing_4bet'

export interface PreflopDecision {
  index: number               // index into hand.actions
  situation: Situation
  action: 'fold' | 'check' | 'call' | 'raise'
  amount?: number             // raise: to-amount in bb; call: chips added
  opener?: string             // position of the first raiser
  lastRaiser?: string         // position of the raiser hero is facing
  freqs: { raise: number; call: number; fold: number }
  verdict: 'yes' | 'close' | 'no'
  approximate: boolean
  explanation: string
  betterPlay: string
}

export interface PreflopLine {
  raisers: string[]           // names, in order of their preflop raises
  limpers: string[]
  callers: Record<string, 'open' | '3bet' | '4bet+' | 'limp'>  // what each non-raiser last called
  folded: Set<string>
  straddle: boolean
  heroDecisions: PreflopDecision[]
}

const SITUATION_LABEL: Record<Situation, string> = {
  unopened: 'unopened pot', limped: 'pot with limpers', facing_open: 'facing an open',
  facing_3bet: 'facing a 3-bet', facing_4bet: 'facing a 4-bet',
}
export const situationLabel = (s: Situation) => SITUATION_LABEL[s]

const isIP = (a: string, b: string) => POSTFLOP_ORDER.indexOf(a) > POSTFLOP_ORDER.indexOf(b)
const pct = (f: number) => `${Math.round(f * 100)}%`

/** Walk the preflop action, recording each hero decision with a range-table verdict. */
export function analyzePreflop(hand: ParsedHand, pos: Record<string, string>): PreflopLine {
  const hero = hand.heroName
  const line: PreflopLine = {
    raisers: [], limpers: [], callers: {}, folded: new Set(),
    straddle: hand.posts.some(p => p.kind === 'straddle'), heroDecisions: [],
  }
  const holeCards = hand.heroCards ?? ''

  hand.actions.forEach((a, index) => {
    if (a.street !== 'Preflop') return
    const r = line.raisers.length
    if (a.name === hero && holeCards) {
      const heroPos = pos[hero] ?? 'BB'
      const situation: Situation = r === 0 ? (line.limpers.length ? 'limped' : 'unopened')
        : r === 1 ? 'facing_open' : r === 2 ? 'facing_3bet' : 'facing_4bet'
      const opener = line.raisers[0] ? pos[line.raisers[0]] : undefined
      const lastRaiser = line.raisers[r - 1] ? pos[line.raisers[r - 1]] : undefined
      const heroOpened = line.raisers[0] === hero
      // Players who called the current raise before hero acts (overcall / squeeze spots)
      const lastRaiseName = line.raisers[r - 1]
      const lastRaiseIdx = lastRaiseName ? hand.actions.findIndex((x, j) => j < index && x.street === 'Preflop' && x.name === lastRaiseName && x.action === 'raise') : -1
      const callersBefore = r > 0 ? hand.actions.filter((x, j) => j > lastRaiseIdx && j < index && x.street === 'Preflop' && x.action === 'call').length : 0
      line.heroDecisions.push(grade(index, a.action as PreflopDecision['action'], a.amount, holeCards, heroPos, situation, opener, lastRaiser, heroOpened, line.straddle, callersBefore))
    }
    if (a.action === 'raise') { line.raisers.push(a.name); delete line.callers[a.name] }
    else if (a.action === 'call') {
      if (r === 0) { line.limpers.push(a.name); line.callers[a.name] = 'limp' }
      else line.callers[a.name] = r === 1 ? 'open' : r === 2 ? '3bet' : '4bet+'
    } else if (a.action === 'fold') line.folded.add(a.name)
  })
  return line
}

function grade(
  index: number, action: PreflopDecision['action'], amount: number | undefined, hand: string,
  heroPos: string, situation: Situation, opener: string | undefined, lastRaiser: string | undefined,
  heroOpened: boolean, straddle: boolean, callersBefore = 0,
): PreflopDecision {
  let raise = 0, call = 0, approximate = straddle
  let ranges = ''
  const inBlindOption = heroPos === 'BB' && (situation === 'unopened' || situation === 'limped')

  if (situation === 'unopened') {
    if (heroPos === 'BB') { raise = 0; call = 1 }  // walk / option: checking is the baseline
    else if (heroPos === 'SB') {
      // Modern SB strategies mix raises and limps; approximate the limp range as BTN-wide minus raises.
      approximate = true
      raise = freqInRange(hand, OPEN_RANGES.SB)
      call = Math.min(1 - raise, freqInRange(hand, OPEN_RANGES.BTN))
      ranges = 'SB raise range, BTN-wide limp range (approximate)'
    } else {
      raise = freqInRange(hand, OPEN_RANGES[heroPos] ?? OPEN_RANGES.CO)
      ranges = `${heroPos} opening range`
    }
  } else if (situation === 'limped') {
    approximate = true
    // Strong hands isolate; the rest of the opening range mixes raising and over-limping.
    const inOpen = freqInRange(hand, OPEN_RANGES[heroPos] ?? OPEN_RANGES.BTN)
    raise = Math.max(freqInRange(hand, ISO_RAISE), inOpen * 0.5)
    call = Math.min(1 - raise, inOpen)
    if (heroPos === 'BB') call = 1 - raise
    ranges = 'isolation-raise range vs limpers (approximate)'
  } else if (situation === 'facing_open') {
    const ip = isIP(heroPos, opener ?? 'BTN')
    raise = heroPreflopFrequencies(hand, ip, 'open').aggrFreq
    // With callers already in, the price is better and implied odds grow: widen to the
    // late-position defend range (approximate).
    const callRange = heroPos === 'BB' ? (callersBefore > 0 ? BB_CALL.BTN : (BB_CALL[opener ?? ''] ?? BB_CALL_DEFAULT))
                    : heroPos === 'SB' ? SB_CALL_BTN : COLD_CALL
    if (heroPos !== 'BB' && heroPos !== 'SB' || callersBefore > 0) approximate = true
    call = Math.min(1 - raise, freqInRange(hand, callRange))
    ranges = `${ip ? 'IP' : 'OOP'} 3-bet range and ${heroPos === 'BB' ? `BB defend vs ${opener}` : heroPos === 'SB' ? 'SB flat range' : 'cold-call range (approximate)'}`
  } else if (situation === 'facing_3bet') {
    const ip = isIP(heroPos, lastRaiser ?? 'BB')
    if (heroOpened) {
      const f = heroPreflopFrequencies(hand, ip, '3bet')
      raise = f.aggrFreq
      call = Math.min(1 - raise, f.callFreq)
    } else {
      approximate = true   // cold, facing a 3-bet without having opened
      raise = freqInRange(hand, FOUR_BET_RANGE)
      call = Math.min(1 - raise, freqInRange(hand, 'QQ,JJ:0.5,AKs'))
    }
    ranges = `4-bet range and ${ip ? 'IP' : 'OOP'} call-3-bet range (${ip ? CALL_3BET_IP : CALL_3BET_OOP})`
  } else {
    approximate = true
    raise = freqInRange(hand, VS_FOUR_BET_RAISE)
    call = Math.min(1 - raise, freqInRange(hand, VS_FOUR_BET_CALL))
    ranges = 'continue range vs a 4-bet (approximate)'
  }
  const fold = Math.max(0, 1 - raise - call)
  const freqs = { raise, call, fold }

  const taken = action === 'raise' ? raise : action === 'fold' ? fold : call   // check = call slot (BB option)
  const verdict: PreflopDecision['verdict'] = taken >= 0.25 ? 'yes' : taken > 0 ? 'close' : 'no'
  const best = (['raise', 'call', 'fold'] as const).reduce((b, k) => freqs[k] > freqs[b] ? k : b, 'fold' as 'raise' | 'call' | 'fold')
  const bestWord = best === 'call' ? (inBlindOption ? 'check' : situation === 'facing_open' ? 'call' : 'call') : best === 'raise'
    ? (situation === 'unopened' ? 'open-raise' : situation === 'limped' ? 'raise' : situation === 'facing_open' ? '3-bet' : situation === 'facing_3bet' ? '4-bet' : 'jam')
    : 'fold'
  const mix = `raise ${pct(raise)} / ${inBlindOption ? 'check' : 'call'} ${pct(call)} / fold ${pct(fold)}`
  const actWord = action === 'raise' && amount ? `raise to ${amount}bb` : action
  const explanation = `${heroPos}, ${SITUATION_LABEL[situation]}${opener && situation !== 'unopened' ? ` (opener ${opener})` : ''}. Range tables (${ranges || 'baseline'}): ${mix}. You chose ${actWord}${verdict === 'yes' ? ', which the ranges support.' : verdict === 'close' ? ', a low-frequency play in these ranges.' : ', which these ranges never do.'}${approximate ? ' This spot uses approximate ranges.' : ''}`
  const betterPlay = verdict === 'yes' ? '' : `${bestWord[0].toUpperCase()}${bestWord.slice(1)} (${pct(freqs[best])} in the ranges).`
  return { index, situation, action, amount, opener, lastRaiser, freqs, verdict, approximate, explanation, betterPlay }
}

export { THREE_BET_IP, THREE_BET_OOP, CALL_3BET_IP, CALL_3BET_OOP, FOUR_BET_RANGE, OPEN_RANGES, BB_CALL, BB_CALL_DEFAULT, SB_CALL_BTN }
