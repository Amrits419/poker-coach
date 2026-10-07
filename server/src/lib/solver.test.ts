import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streetStartPotStack } from './solver'
import { withHandInRange, specificCombo } from './ranges'
import type { StartState, HandHistoryEntry } from './types'

// Numbers below are what the client (HandTrainer) displayed during real hands;
// the replay must reproduce them exactly or grading misses the solver cache.
const bbCaller = { pot: 3, effectiveStack: 99 } as StartState   // CO opens 2.5, hero BB posted 1
const btnOpener = { pot: 1.5, effectiveStack: 100 } as StartState

test('BB calls an open: flop starts at 5.5 / 97.5', () => {
  const h: HandHistoryEntry[] = [{ street: 'Preflop', actor: 'hero', action: 'call', amount: 2.5 }]
  assert.deepEqual(streetStartPotStack(h, 'Flop', bbCaller, 'BB'), { pot: 5.5, stack: 97.5 })
})

test('check/check flop, hero bets turn and is called: river starts at 11.1 / 94.7', () => {
  const h: HandHistoryEntry[] = [
    { street: 'Preflop', actor: 'hero', action: 'call', amount: 2.5 },
    { street: 'Flop', actor: 'hero', action: 'check' },
    { street: 'Flop', actor: 'villain', action: 'check' },
    { street: 'Turn', actor: 'hero', action: 'bet', amount: 2.8 },
    { street: 'Turn', actor: 'villain', action: 'call' },
    { street: 'River', actor: 'hero', action: 'bet', amount: 5.6 },
  ]
  assert.deepEqual(streetStartPotStack(h, 'Turn', bbCaller, 'BB'), { pot: 5.5, stack: 97.5 })
  assert.deepEqual(streetStartPotStack(h, 'River', bbCaller, 'BB'), { pot: 11.1, stack: 94.7 })
  // mid-street actions on the requested street are ignored
  assert.deepEqual(streetStartPotStack(h, 'River', bbCaller, 'BB'), streetStartPotStack(h.slice(0, 5), 'River', bbCaller, 'BB'))
})

test('hero opens from BTN, BB calls: flop starts at 5.5 / 97.5', () => {
  const h: HandHistoryEntry[] = [
    { street: 'Preflop', actor: 'hero', action: 'raise', amount: 2.5 },
    { street: 'Preflop', actor: 'villain', action: 'call' },
  ]
  assert.deepEqual(streetStartPotStack(h, 'Flop', btnOpener, 'BTN'), { pot: 5.5, stack: 97.5 })
})

test('hero calls a flop bet: turn pot includes both calls, stack drops by the call', () => {
  const h: HandHistoryEntry[] = [
    { street: 'Preflop', actor: 'hero', action: 'call', amount: 2.5 },
    { street: 'Flop', actor: 'hero', action: 'check' },
    { street: 'Flop', actor: 'villain', action: 'bet', amount: 1.82 },
    { street: 'Flop', actor: 'hero', action: 'call', amount: 1.82 },
  ]
  assert.deepEqual(streetStartPotStack(h, 'Turn', bbCaller, 'BB'), { pot: 9.1, stack: 95.7 })
})

test('specific combo is written higher rank first and only added when missing', () => {
  assert.equal(specificCombo('8cJd'), 'Jd8c')
  assert.equal(specificCombo('AsKs'), 'AsKs')
  assert.equal(withHandInRange('AKs, QQ, J8o', '8cJd'), 'AKs, QQ, J8o')
  assert.equal(withHandInRange('AKs, QQ', '8cJd'), 'AKs, QQ, Jd8c')
})

import { heroPreflopFrequencies } from './ranges'

test('premium pairs are 3-bets facing an open, not set-mining calls', () => {
  assert.equal(heroPreflopFrequencies('KcKs', true, 'open').aggrFreq, 1)
  assert.equal(heroPreflopFrequencies('AhAd', false, 'open').aggrFreq, 1)
  assert.equal(heroPreflopFrequencies('7c7d', true, 'open').aggrFreq, 0)   // falls through to cold-call logic
  assert.equal(heroPreflopFrequencies('JhJs', true, 'open').aggrFreq, 0.5) // mixed
})

test('facing a 3-bet, AA/KK are 4-bets and TT is a call', () => {
  const aa = heroPreflopFrequencies('AcAs', true, '3bet')
  assert.equal(aa.aggrFreq, 1)
  const tt = heroPreflopFrequencies('TcTs', true, '3bet')
  assert.equal(tt.aggrFreq, 0); assert.equal(tt.callFreq, 1)
})
