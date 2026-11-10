import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHandInRange, specificCombo } from './ranges'

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
