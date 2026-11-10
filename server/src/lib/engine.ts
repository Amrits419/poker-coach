// The trainer's hand engine: one pure replay of (deal, action history) that says
// what the pot and stacks are, whose turn it is, when a street closes and when the
// hand is over. The routes, the solver glue and the client all read this instead
// of keeping their own copy of the arithmetic.
//
// Amount conventions (same as the hand history everywhere else in the app):
//   bet / raise  → the total the player has in front of them on that street ("raise to")
//   call         → the total called to
// All amounts are big blinds, kept to 0.01bb (the solver's chip precision).

import { evaluateHand, compareHands } from './handEval'
import { POSTFLOP_ORDER } from './ranges'
import type { Setup, StartState, HandHistoryEntry, TableState, HandResult } from './types'

export const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const
export type Street = typeof STREETS[number]

export const PREFLOP_ORDER  = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']

/** 'hero', or the index of a villain in startState.villainPositions. */
export type Actor = 'hero' | number

const r2 = (n: number) => Math.round(n * 100) / 100

export interface Seat {
  actor: Actor
  pos: string
  stack: number     // chips behind
  in: number        // chips in front on the current street
  total: number     // chips put in over the whole hand, blinds included
  folded: boolean
  acted: boolean    // has acted since the last bet or raise on this street
}

export interface StreetStart {
  pot: number
  stack: number        // effective stack between the players who can still bet
  villains: number[]   // villains still in the hand when the street began
}

export interface HandState {
  street: Street
  pot: number
  seats: Seat[]                 // hero first, then villains in startState order
  currentBet: number            // the amount to match on this street
  lastRaiseSize: number         // size of the last raise, for the min-raise rule
  toAct: Actor | null
  over: null | 'hero_folded' | 'villains_folded' | 'showdown'
  allInRunout: boolean          // betting ended early because players are all-in
  streetStart: Partial<Record<Street, StreetStart>>
  raisers: Actor[]              // preflop raises in order: [opener, 3-bettor, 4-bettor, ...]
}

const blindOf = (pos: string) => (pos === 'BB' ? 1 : pos === 'SB' ? 0.5 : 0)

export const seatOf = (s: HandState, actor: Actor): Seat | undefined =>
  actor === 'hero' ? s.seats[0] : s.seats[1 + actor]

export const liveVillains = (s: HandState): number[] =>
  s.seats.slice(1).filter(v => !v.folded).map(v => v.actor as number)

function initialState(setup: Setup, start: StartState): HandState {
  const depth = parseFloat(setup.stackDepth) || 100
  const posted = (pos: string) => start.preflopBets?.[pos] ?? blindOf(pos)
  const heroIdx = PREFLOP_ORDER.indexOf(setup.position)

  const heroIn = posted(setup.position)
  const seats: Seat[] = [{
    actor: 'hero', pos: setup.position, stack: r2(start.effectiveStack), in: heroIn, total: heroIn, folded: false, acted: false,
  }]
  start.villainPositions.forEach((pos, i) => {
    const put = posted(pos)
    // A villain seated before hero is in the hand because they already raised.
    const raised = PREFLOP_ORDER.indexOf(pos) < heroIdx && put > blindOf(pos)
    seats.push({ actor: i, pos, stack: r2(depth - put), in: put, total: put, folded: false, acted: raised })
  })

  const raisedSeats = seats.filter(s => s.acted).sort((a, b) => a.in - b.in)
  const levels = [1, ...raisedSeats.map(s => s.in)]
  const currentBet = Math.max(...levels)
  return {
    street: 'Preflop',
    pot: r2(start.pot),
    seats,
    currentBet,
    lastRaiseSize: levels.length > 1 ? Math.max(1, r2(currentBet - levels[levels.length - 2])) : 1,
    toAct: 'hero',   // every dealt scenario starts on hero's first decision
    over: null,
    allInRunout: false,
    streetStart: {},
    raisers: raisedSeats.map(s => s.actor),
  }
}

/** Next seat that still owes an action, scanning the street's order from `from`. */
function scan(s: HandState, from: number): Actor | null {
  const order = s.street === 'Preflop' ? PREFLOP_ORDER : POSTFLOP_ORDER
  for (let k = 0; k < order.length; k++) {
    const pos = order[(from + k) % order.length]
    const seat = s.seats.find(x => x.pos === pos)
    if (!seat || seat.folded || seat.stack <= 0) continue
    if (!seat.acted || seat.in < s.currentBet) return seat.actor
  }
  return null
}

function put(s: HandState, seat: Seat, chips: number) {
  const add = r2(Math.max(0, Math.min(chips, seat.stack)))
  seat.stack = r2(seat.stack - add)
  seat.in = r2(seat.in + add)
  seat.total = r2(seat.total + add)
  s.pot = r2(s.pot + add)
}

function apply(s: HandState, e: HandHistoryEntry) {
  const actor: Actor = e.actor === 'hero' ? 'hero' : (e.villainIdx ?? 0)
  const seat = seatOf(s, actor)
  if (!seat || seat.folded || s.over) return

  let action = e.action
  if (action === 'bet' || action === 'raise') {
    const to = Math.min(e.amount ?? 0, r2(seat.in + seat.stack))
    if (to > s.currentBet) {
      const raiseSize = r2(to - s.currentBet)
      put(s, seat, to - seat.in)
      // An all-in for less than a full raise does not reopen the min-raise size.
      if (raiseSize >= s.lastRaiseSize) s.lastRaiseSize = raiseSize
      s.currentBet = to
      for (const other of s.seats) other.acted = false
      seat.acted = true
      if (s.street === 'Preflop') s.raisers.push(actor)
    } else {
      action = s.currentBet > seat.in ? 'call' : 'check'   // not actually a raise
    }
  }
  if (action === 'call') { put(s, seat, s.currentBet - seat.in); seat.acted = true }
  else if (action === 'check') seat.acted = true
  else if (action === 'fold') seat.folded = true

  settle(s, seat)
}

/** After an action: find who is next, or close the street / the hand. */
function settle(s: HandState, last: Seat) {
  s.toAct = null
  if (s.seats[0].folded) { s.over = 'hero_folded'; return }
  if (liveVillains(s).length === 0) { s.over = 'villains_folded'; return }

  const order = s.street === 'Preflop' ? PREFLOP_ORDER : POSTFLOP_ORDER
  const next = scan(s, order.indexOf(last.pos) + 1)
  if (next !== null) { s.toAct = next; return }

  // Betting round is closed.
  if (s.street === 'River') { s.over = 'showdown'; return }
  const canBet = s.seats.filter(x => !x.folded && x.stack > 0)
  if (canBet.length <= 1) { s.over = 'showdown'; s.allInRunout = true; return }

  s.street = STREETS[STREETS.indexOf(s.street) + 1]
  for (const seat of s.seats) { seat.in = 0; seat.acted = false }
  s.currentBet = 0
  s.lastRaiseSize = 0
  s.streetStart[s.street] = {
    pot: s.pot,
    stack: Math.min(...canBet.map(x => x.stack)),
    villains: liveVillains(s),
  }
  s.toAct = scan(s, 0)
}

export function replay(setup: Setup, start: StartState, history: HandHistoryEntry[]): HandState {
  const s = initialState(setup, start)
  for (const e of history) apply(s, e)
  return s
}

/**
 * Does hero hold the betting initiative on the current street? On the flop that is
 * the last preflop raiser; later, whoever made the last bet or raise on the street
 * before (nobody, if it checked through). A villain leading into hero's initiative
 * is a donk bet.
 */
export function heroHasInitiative(s: HandState, history: HandHistoryEntry[]): boolean {
  const idx = STREETS.indexOf(s.street)
  if (idx <= 0) return false
  if (idx === 1) return s.raisers[s.raisers.length - 1] === 'hero'
  const prev = STREETS[idx - 1]
  const lastBet = [...history].reverse().find(h => h.street === prev && (h.action === 'bet' || h.action === 'raise'))
  return lastBet?.actor === 'hero'
}

// ── What a seat may do ───────────────────────────────────────────────────────

export interface Options {
  toCall: number      // total to match; 0 when the seat can check
  callCost: number    // chips a call adds
  canRaise: boolean
  minRaise: number    // smallest legal bet / raise-to
  maxRaise: number    // all-in
}

export function optionsFor(s: HandState, actor: Actor): Options {
  const seat = seatOf(s, actor)!
  const facing = s.currentBet > seat.in
  const maxRaise = r2(seat.in + seat.stack)
  const someoneCanCall = s.seats.some(x => x !== seat && !x.folded && x.stack > 0)
  const min = s.currentBet > 0 ? r2(s.currentBet + Math.max(s.lastRaiseSize, 1)) : 1
  return {
    toCall: facing ? s.currentBet : 0,
    callCost: facing ? r2(Math.min(s.currentBet - seat.in, seat.stack)) : 0,
    canRaise: maxRaise > s.currentBet && someoneCanCall,
    minRaise: Math.min(min, maxRaise),
    maxRaise,
  }
}

/** Make a proposed action legal for the seat to act (clamps sizes, fixes verbs). */
export function legalize(s: HandState, actor: Actor, action: string, amount?: number): { action: string; amount?: number } {
  const o = optionsFor(s, actor)
  let a = action.toLowerCase()
  if (o.toCall > 0) {
    if (a === 'bet') a = 'raise'
    if (a === 'check') a = 'call'
    if (!['fold', 'call', 'raise'].includes(a)) a = 'call'
    if (a === 'raise' && !o.canRaise) a = 'call'
  } else {
    if (a === 'raise') a = 'bet'
    if (a !== 'bet') a = 'check'
    if (a === 'bet' && !o.canRaise) a = 'check'
  }
  if (a === 'bet' || a === 'raise') {
    const to = r2(Math.min(o.maxRaise, Math.max(o.minRaise, amount ?? o.minRaise)))
    return { action: a, amount: to }
  }
  if (a === 'call') return { action: a, amount: r2(Math.min(o.toCall, o.maxRaise)) }
  return { action: a }
}

// ── Views ────────────────────────────────────────────────────────────────────

export function tableView(s: HandState, start: StartState): TableState {
  const hero = s.seats[0]
  const o = optionsFor(s, 'hero')
  const heroToAct = s.toAct === 'hero'

  // Chips in front of each seat: the players' street bets, plus (preflop) the dead
  // blinds of seats that are not in the hand.
  const bets: Record<string, number> = {}
  if (s.street === 'Preflop') {
    for (const [pos, amt] of Object.entries(start.preflopBets ?? {})) {
      if (!s.seats.some(x => x.pos === pos)) bets[pos] = amt
    }
  }
  if (!s.over) for (const seat of s.seats) if (!seat.folded && seat.in > 0) bets[seat.pos] = seat.in

  return {
    street: s.over === 'showdown' ? 'River' : s.street,
    pot: s.pot,
    heroStack: hero.stack,
    heroIn: hero.in,
    bets,
    folded: s.seats.slice(1).filter(v => v.folded).map(v => v.actor as number),
    toAct: s.toAct,
    toCall: heroToAct ? o.toCall : 0,
    callCost: heroToAct ? o.callCost : 0,
    canRaise: heroToAct && o.canRaise,
    minRaise: o.minRaise,
    maxRaise: o.maxRaise,
    potOdds: heroToAct && o.callCost > 0 ? `${(s.pot / o.callCost).toFixed(1)}:1` : null,
    preflopRaises: s.raisers.length,
    handOver: s.over !== null,
    allInRunout: s.allInRunout,
  }
}

/** Who won and what it was worth to hero. Null until the hand is over. */
export function handResult(s: HandState, start: StartState): HandResult | null {
  if (!s.over) return null
  const hero = s.seats[0]
  const base = { pot: s.pot }
  if (s.over === 'hero_folded') return { ...base, outcome: 'lost', how: 'fold', netBb: r2(-hero.total) }
  if (s.over === 'villains_folded') return { ...base, outcome: 'won', how: 'fold', netBb: r2(s.pot - hero.total) }

  const board = [...start.board.flop, start.board.turn, start.board.river]
  const cards = (hole: string) => [hole.slice(0, 2), hole.slice(2, 4), ...board]
  const heroHand = evaluateHand(cards(start.holeCards))
  const villains = liveVillains(s)
    .map(i => ({ pos: start.villainPositions[i], hand: evaluateHand(cards(start.villainHoleCards[i] ?? '')) }))
    .sort((a, b) => compareHands(b.hand, a.hand))
  const best = villains[0]
  const cmp = compareHands(heroHand, best.hand)
  const ties = villains.filter(v => compareHands(v.hand, best.hand) === 0).length
  const share = cmp > 0 ? s.pot : cmp === 0 ? s.pot / (ties + 1) : 0
  return {
    ...base,
    outcome: cmp > 0 ? 'won' : cmp === 0 ? 'split' : 'lost',
    how: 'showdown',
    netBb: r2(share - hero.total),
    heroHand: heroHand.name,
    villainHand: best.hand.name,
    villainPosition: best.pos,
  }
}
