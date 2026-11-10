import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replay, tableView, handResult, optionsFor, legalize, heroHasInitiative } from './engine'
import { solverSpot } from './solver'
import { evaluateHand, compareHands } from './handEval'
import { villainPreflopAction, THREE_BET_OOP, CALL_3BET_IP, type VillainPreflopSpot } from './ranges'
import { trainerPreflopFacts, normalizeAnalysis, villainPreflopSpot } from './openai'
import type { Setup, StartState, HandHistoryEntry } from './types'

const board = { flop: ['Kh', '7d', '2c'], turn: '9s', river: '3h' }
const setup = (position: string, stackDepth = '100bb'): Setup => ({ position, isMultiway: false, stackDepth, betSize: '75' })

// Hero on the button, folded to; BB defends.
const btnOpens: StartState = {
  holeCards: 'AsKs', villainHoleCards: ['QdJd'], villainPositions: ['BB'], board,
  heroIsIP: true, heroIsPFR: true, preflopContext: 'Action folds to you in BTN. BB is left to act.',
  pot: 1.5, effectiveStack: 100, preflopRaiseAmount: null, preflopBets: { SB: 0.5, BB: 1 },
}
// CO opens 2.5, hero in the big blind.
const bbFacesOpen: StartState = {
  holeCards: 'Td9d', villainHoleCards: ['AcQc'], villainPositions: ['CO'], board,
  heroIsIP: false, heroIsPFR: false, preflopContext: "CO opens 2.5bb. You're in BB.",
  pot: 4, effectiveStack: 99, preflopRaiseAmount: 2.5, preflopBets: { SB: 0.5, BB: 1, CO: 2.5 },
}

const hero = (street: string, action: string, amount?: number): HandHistoryEntry => ({ street, actor: 'hero', action, amount })
const vill = (street: string, action: string, amount?: number, villainIdx = 0): HandHistoryEntry => ({ street, actor: 'villain', action, amount, villainIdx })

test('hero opens the button, BB calls: flop is 5.5 with 97.5 behind and BB acts first', () => {
  const s = replay(setup('BTN'), btnOpens, [hero('Preflop', 'raise', 2.5), vill('Preflop', 'call', 2.5)])
  assert.equal(s.street, 'Flop')
  assert.deepEqual(s.streetStart.Flop, { pot: 5.5, stack: 97.5, villains: [0] })
  assert.equal(s.toAct, 0)
})

test('BB calls an open: the call costs 1.5 and the flop is 5.5 / 97.5', () => {
  const t0 = tableView(replay(setup('BB'), bbFacesOpen, []), bbFacesOpen)
  assert.equal(t0.pot, 4)
  assert.equal(t0.toCall, 2.5)
  assert.equal(t0.callCost, 1.5)
  assert.equal(t0.minRaise, 4)        // open was a raise of 1.5 over the big blind
  assert.equal(t0.maxRaise, 100)
  assert.equal(t0.potOdds, '2.7:1')
  const s = replay(setup('BB'), bbFacesOpen, [hero('Preflop', 'call', 2.5)])
  assert.deepEqual(s.streetStart.Flop, { pot: 5.5, stack: 97.5, villains: [0] })
  assert.equal(s.toAct, 'hero')       // BB is out of position against CO
})

test('small blind open counts the blind already posted', () => {
  const sbOpens: StartState = { ...btnOpens, effectiveStack: 99.5 }
  const s = replay(setup('SB'), sbOpens, [hero('Preflop', 'raise', 3)])
  assert.equal(s.pot, 4)              // 1 (BB) + 3
  assert.equal(s.seats[0].stack, 97)
})

test('calling a 3-bet closes preflop: the villain does not act again', () => {
  const h = [hero('Preflop', 'raise', 2.5), vill('Preflop', 'raise', 9), hero('Preflop', 'call', 9)]
  const mid = replay(setup('BTN'), btnOpens, h.slice(0, 2))
  assert.equal(mid.toAct, 'hero')
  assert.equal(mid.pot, 12)           // 0.5 dead + 2.5 + 9
  assert.equal(optionsFor(mid, 'hero').callCost, 6.5)
  const s = replay(setup('BTN'), btnOpens, h)
  assert.equal(s.street, 'Flop')
  assert.deepEqual(s.streetStart.Flop, { pot: 18.5, stack: 91, villains: [0] })
  assert.deepEqual(s.raisers, ['hero', 0])
})

test('bet, raise, call: only the difference goes in on the call', () => {
  const pre = [hero('Preflop', 'raise', 2.5), vill('Preflop', 'call', 2.5)]
  const s = replay(setup('BTN'), btnOpens, [
    ...pre, vill('Flop', 'check'), hero('Flop', 'bet', 4), vill('Flop', 'raise', 12), hero('Flop', 'call', 12),
  ])
  assert.equal(s.street, 'Turn')
  assert.deepEqual(s.streetStart.Turn, { pot: 29.5, stack: 85.5, villains: [0] })
})

test('villain bets, hero raises, villain calls: villain adds the difference', () => {
  const s = replay(setup('BB'), bbFacesOpen, [
    hero('Preflop', 'call', 2.5), hero('Flop', 'check'), vill('Flop', 'bet', 4), hero('Flop', 'raise', 12), vill('Flop', 'call'),
  ])
  assert.deepEqual(s.streetStart.Turn, { pot: 29.5, stack: 85.5, villains: [0] })
})

test('check-check moves to the next street; river check-check is a showdown', () => {
  const h = [hero('Preflop', 'call', 2.5)]
  for (const st of ['Flop', 'Turn', 'River']) h.push(hero(st, 'check'), vill(st, 'check'))
  const s = replay(setup('BB'), bbFacesOpen, h)
  assert.equal(s.over, 'showdown')
  const r = handResult(s, bbFacesOpen)!
  // Td9d on Kh7d2c9s3h is a pair of nines; AcQc is ace high
  assert.equal(r.outcome, 'won')
  assert.equal(r.heroHand, 'a pair of nines')
  assert.equal(r.netBb, 3)            // 5.5 pot minus the 2.5 hero put in
})

test('all-in and a call runs the board out', () => {
  const s = replay(setup('BTN'), btnOpens, [
    hero('Preflop', 'raise', 2.5), vill('Preflop', 'call', 2.5), vill('Flop', 'check'), hero('Flop', 'bet', 500), vill('Flop', 'call'),
  ])
  assert.equal(s.over, 'showdown')
  assert.equal(s.allInRunout, true)
  assert.equal(s.pot, 200.5)
  const t = tableView(s, btnOpens)
  assert.equal(t.handOver, true)
  assert.equal(t.street, 'River')
  assert.equal(handResult(s, btnOpens)!.netBb, 100.5)   // AK on a king-high board beats QJ
})

test('folds end the hand with the right result', () => {
  const lost = replay(setup('BB'), bbFacesOpen, [hero('Preflop', 'fold')])
  assert.equal(handResult(lost, bbFacesOpen)!.netBb, -1)
  const won = replay(setup('BTN'), btnOpens, [hero('Preflop', 'raise', 2.5), vill('Preflop', 'fold')])
  assert.equal(won.over, 'villains_folded')
  assert.equal(handResult(won, btnOpens)!.netBb, 1.5)
})

test('multiway: the cold caller behind hero acts before the flop', () => {
  const threeWay: StartState = { ...bbFacesOpen, holeCards: 'Td9d', villainPositions: ['CO', 'BB'], villainHoleCards: ['AcQc', '8h8s'] }
  const s = replay(setup('BTN'), { ...threeWay, effectiveStack: 100 }, [hero('Preflop', 'call', 2.5)])
  assert.equal(s.toAct, 1)
  const flop = replay(setup('BTN'), { ...threeWay, effectiveStack: 100 }, [hero('Preflop', 'call', 2.5), vill('Preflop', 'call', 2.5, 1)])
  assert.equal(flop.street, 'Flop')
  assert.equal(flop.pot, 8)           // 0.5 dead + 2.5 × 3
  assert.equal(flop.toAct, 1)         // BB first, then CO, then the button
  assert.equal(solverSpot(setup('BTN'), threeWay, flop, 'Flop'), null)   // the solver is heads-up only
})

test('cold 3-bet: the opener still has to respond after hero calls', () => {
  const cold: StartState = {
    ...bbFacesOpen, villainPositions: ['CO', 'HJ'], villainHoleCards: ['AhAd', 'KcQc'],
    pot: 13, effectiveStack: 100, preflopRaiseAmount: 9, preflopBets: { SB: 0.5, BB: 1, HJ: 2.5, CO: 9 },
  }
  const s0 = replay(setup('BTN'), cold, [])
  assert.deepEqual(s0.raisers, [1, 0])
  assert.equal(optionsFor(s0, 'hero').minRaise, 15.5)
  const s = replay(setup('BTN'), cold, [hero('Preflop', 'call', 9)])
  assert.equal(s.toAct, 1)
  const spot = villainPreflopSpot(cold, s, 1)
  assert.equal(spot.raisedBefore, true)
  assert.equal(spot.aggressorPos, 'CO')
  const folded = replay(setup('BTN'), cold, [hero('Preflop', 'call', 9), vill('Preflop', 'fold', undefined, 1)])
  assert.equal(folded.street, 'Flop')
  assert.equal(solverSpot(setup('BTN'), cold, folded, 'Flop')!.villainIdx, 0)
})

test('legalize clamps sizes and fixes verbs', () => {
  const facing = replay(setup('BB'), bbFacesOpen, [hero('Preflop', 'call', 2.5), hero('Flop', 'bet', 4)])
  assert.deepEqual(legalize(facing, 0, 'bet', 5), { action: 'raise', amount: 8 })      // below the min-raise
  assert.deepEqual(legalize(facing, 0, 'check'), { action: 'call', amount: 4 })
  assert.deepEqual(legalize(facing, 0, 'raise', 900), { action: 'raise', amount: 97.5 })
  const open = replay(setup('BB'), bbFacesOpen, [hero('Preflop', 'call', 2.5), hero('Flop', 'check')])
  assert.deepEqual(legalize(open, 0, 'fold'), { action: 'check' })
  assert.deepEqual(legalize(open, 0, 'raise', 3), { action: 'bet', amount: 3 })
})

test('solver spot: ranges follow how preflop actually ended, and predictions hit the same key', () => {
  const srp = [hero('Preflop', 'raise', 2.5), vill('Preflop', 'call', 2.5)]
  const a = solverSpot(setup('BTN'), btnOpens, replay(setup('BTN'), btnOpens, srp), 'Flop')!
  // Same spot later in the hand (grading) must be byte-identical to the one solved in play
  const later = [...srp, vill('Flop', 'check'), hero('Flop', 'bet', 4), vill('Flop', 'call')]
  assert.deepEqual(solverSpot(setup('BTN'), btnOpens, replay(setup('BTN'), btnOpens, later), 'Flop'), a)
  assert.equal(a.heroIsIP, true)
  assert.equal(a.betSizes, '75%')

  const threeBet = [hero('Preflop', 'raise', 2.5), vill('Preflop', 'raise', 9), hero('Preflop', 'call', 9)]
  const b = solverSpot(setup('BTN'), btnOpens, replay(setup('BTN'), btnOpens, threeBet), 'Flop')!
  assert.ok(b.oopRange.startsWith(THREE_BET_OOP))    // BB 3-bet, plus its actual hand
  assert.ok(b.ipRange.startsWith(CALL_3BET_IP))
  assert.ok(b.oopRange.includes('QdJd'))             // villain's hand is always in its range
  assert.equal(b.pot, 18.5)
})

test('villain preflop: premiums re-raise, trash folds, the big blind checks its option', () => {
  const base: VillainPreflopSpot = { pos: 'BB', hand: 'AsAh', raises: 1, aggressorPos: 'BTN', raisedBefore: false, currentBet: 2.5, myIn: 1, stackTotal: 100 }
  assert.deepEqual(villainPreflopAction(base, () => 0), { action: 'raise', amount: 9, description: 'BB 3-bets to 9bb' })
  assert.equal(villainPreflopAction({ ...base, hand: '7c2d' }).action, 'fold')
  assert.equal(villainPreflopAction({ ...base, hand: '8c8d' }).action, 'call')
  // Unraised pot, nothing to call
  assert.equal(villainPreflopAction({ ...base, hand: '7c2d', raises: 0, aggressorPos: null, currentBet: 1 }).action, 'check')
  // Facing a shove: only premiums continue
  const shove = { ...base, currentBet: 100 }
  assert.equal(villainPreflopAction({ ...shove, hand: '8c8d' }).action, 'fold')
  assert.equal(villainPreflopAction(shove).action, 'call')
  // Short stack: a 3-bet that commits half the stack is a jam
  assert.equal(villainPreflopAction({ ...base, stackTotal: 15 }, () => 0).amount, 15)
})

test('hand evaluator ranks and names hands', () => {
  const ev = (s: string) => evaluateHand(s.split(' '))
  assert.equal(ev('As Ks Qs Js Ts 2d 3c').name, 'a royal flush')
  assert.equal(ev('Ah 2d 3c 4s 5h Kd Kc').name, 'a straight, five high')
  assert.equal(ev('9h 9d 9c 4s 4h 4d Kc').name, 'a full house, nines full of fours')
  assert.equal(ev('6h 6d Kc 4s 2h 9d Tc').name, 'a pair of sixes')
  assert.ok(compareHands(ev('Ah Kd Qc Js 9h 3d 2c'), ev('Ah Kd Qc Js 8h 3d 2c')) > 0)   // kicker
  assert.ok(compareHands(ev('2h 2d 3c 3s Ah 7d 7c'), ev('Ah Ad 3c 3s 2h 9d Tc')) < 0)   // best two of three pairs
  assert.equal(compareHands(ev('Ah Kd 5c 6s 7h 8d 9c'), ev('2h 3d 5c 6s 7h 8d 9c')), 0) // board plays
  assert.ok(compareHands(ev('Kh Qh 2h 7h 9h Ad Ac'), ev('Ad Ac As 7h 9h 2c Kd')) > 0)   // flush beats trips
})

test('preflop facts cover each hero decision from the range tables', () => {
  const open = trainerPreflopFacts(setup('BTN'), btnOpens, [hero('Preflop', 'raise', 2.5), vill('Preflop', 'raise', 9), hero('Preflop', 'call', 9)])
  assert.match(open, /Decision 1 .*IS in the BTN opening range/)
  assert.match(open, /Decision 2 .*faces a 3-bet/)
  const trash: StartState = { ...btnOpens, holeCards: '7c2d' }
  assert.match(trainerPreflopFacts(setup('BTN'), trash, [hero('Preflop', 'fold')]), /NOT in the BTN opening range — folding is correct/)
  assert.match(trainerPreflopFacts(setup('BB'), bbFacesOpen, [hero('Preflop', 'call', 2.5)]), /facing a single CO open/)
})

test('a malformed coach reply still yields a complete analysis', () => {
  const a = normalizeAnalysis({ summary: 'ok', score: '140', streetFeedback: [{ street: 'Flop', correct: 'YES' }, null], leaks: 'none' })
  assert.equal(a.score, 100)
  assert.deepEqual(a.leaks, [])
  assert.deepEqual(a.studyPlan, [])
  assert.equal(a.streetFeedback.length, 1)
  assert.equal(a.streetFeedback[0].correct, 'yes')
  assert.equal(normalizeAnalysis(null).summary, '')
})

test('initiative: the caller does not donk, the raiser may bet, a checked-through street frees everyone', () => {
  // Hero opened the button: BB would be donking on the flop
  const heroPfr = [hero('Preflop', 'raise', 2.5), vill('Preflop', 'call', 2.5)]
  assert.equal(heroHasInitiative(replay(setup('BTN'), btnOpens, heroPfr), heroPfr), true)
  // CO opened and hero called from the BB: CO has the initiative, not hero
  const villPfr = [hero('Preflop', 'call', 2.5)]
  assert.equal(heroHasInitiative(replay(setup('BB'), bbFacesOpen, villPfr), villPfr), false)
  // Hero c-bet the flop and was called: still hero's initiative on the turn
  const cbet = [...heroPfr, vill('Flop', 'check'), hero('Flop', 'bet', 4), vill('Flop', 'call', 4)]
  assert.equal(heroHasInitiative(replay(setup('BTN'), btnOpens, cbet), cbet), true)
  // Flop checked through: the turn is open to a probe bet
  const checked = [...heroPfr, vill('Flop', 'check'), hero('Flop', 'check')]
  assert.equal(heroHasInitiative(replay(setup('BTN'), btnOpens, checked), checked), false)
})

test('a limped pot has no solver spot', () => {
  const h = [hero('Preflop', 'call', 1), vill('Preflop', 'check')]
  const s = replay(setup('BTN'), btnOpens, h)
  assert.equal(s.street, 'Flop')
  assert.equal(s.pot, 2.5)
  assert.equal(solverSpot(setup('BTN'), btnOpens, s, 'Flop'), null)
})
