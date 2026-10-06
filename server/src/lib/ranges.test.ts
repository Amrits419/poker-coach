import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHeroInPosition } from './ranges'

test('early-position opener is IP against the blinds', () => {
  assert.equal(isHeroInPosition('UTG', ['BB']), true)
  assert.equal(isHeroInPosition('UTG+1', ['SB']), true)
})

test('late-position opener is OOP against a later seat', () => {
  assert.equal(isHeroInPosition('CO', ['BTN']), false)
  assert.equal(isHeroInPosition('HJ', ['CO']), false)
})

test('button is IP against everyone', () => {
  assert.equal(isHeroInPosition('BTN', ['CO']), true)
  assert.equal(isHeroInPosition('BTN', ['SB', 'BB']), true)
})

test('multiway: IP only if hero acts after every villain', () => {
  assert.equal(isHeroInPosition('CO', ['UTG', 'BB']), true)
  assert.equal(isHeroInPosition('CO', ['UTG', 'BTN']), false)
})
