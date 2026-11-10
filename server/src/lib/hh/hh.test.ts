import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseHand, parseFile, splitHands } from './pokerstars'
import { assignPositions } from './positions'
import { mapHand } from './mapper'
import { analyzePreflop } from './preflop'

// Fixtures are real hands with every player name, id and date replaced.
const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
const HERO = 'Hero'

test('parses a single-raised heads-up pot in big blinds', () => {
  const h = parseHand(fx('hu_srp.txt'), HERO)
  assert.equal(h.bigBlind, 0.5)
  assert.equal(h.heroCards, '4h7s')
  assert.deepEqual(h.board, ['5s', 'Jd', '9d', '4s', 'Ac'])
  assert.deepEqual(h.seats.find(s => s.name === HERO), { seat: 8, name: HERO, stack: 100 })
  assert.deepEqual(h.actions.find(a => a.name === 'Alice' && a.street === 'Preflop'), { street: 'Preflop', name: 'Alice', action: 'raise', amount: 3, allIn: false })
  assert.equal(h.collected.Alice, 6.5)
})

test('straddle is a post, not an action', () => {
  const h = parseHand(fx('straddle.txt'), HERO)
  assert.ok(h.posts.some(p => p.kind === 'straddle'))
  assert.ok(!h.actions.some(a => a.action === 'bet' && a.street === 'Preflop'))
})

test('run-it-twice keeps the first board and sums both payouts', () => {
  const h = parseHand(fx('run_twice.txt'), HERO)
  assert.equal(h.runTwice, true)
  assert.equal(h.board.length, 5)
  const total = Object.values(h.collected).reduce((s, v) => s + v, 0)
  assert.ok(total > 0)
  assert.ok(!h.actions.some(a => a.street !== 'Preflop' && a.street !== 'Flop' && a.street !== 'Turn' && a.street !== 'River'))
})

test('splitHands finds every hand in a file', () => {
  const file = ['hu_srp.txt', 'hu_3bet.txt', 'straddle.txt', 'run_twice.txt'].map(fx).join('\n\n\n')
  assert.equal(splitHands(file).length, 4)
  assert.equal(parseFile(file, HERO).errors.length, 0)
})

test('positions for every table size', () => {
  const mk = (n: number) => ({
    seats: Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `p${i + 1}`, stack: 100 })),
    buttonSeat: 1, posts: [],
  })
  assert.deepEqual(assignPositions(mk(2)), { p1: 'BTN', p2: 'BB' })
  assert.deepEqual(assignPositions(mk(3)), { p2: 'SB', p3: 'BB', p1: 'BTN' })
  assert.deepEqual(assignPositions(mk(6)), { p2: 'SB', p3: 'BB', p4: 'MP', p5: 'HJ', p6: 'CO', p1: 'BTN' })
  const nine = assignPositions(mk(9))
  assert.equal(nine.p4, 'UTG'); assert.equal(nine.p1, 'BTN'); assert.equal(nine.p9, 'CO')
  for (let n = 2; n <= 10; n++) assert.equal(Object.keys(assignPositions(mk(n))).length, n)
  // dead button: button seat is empty
  assert.equal(assignPositions({ ...mk(4), buttonSeat: 9 }).p1, 'SB')
})

test('BB defends vs a BTN open: flop pot, stacks and ranges', () => {
  const m = mapHand(parseHand(fx('hu_srp.txt'), HERO))
  assert.equal(m.heroPosition, 'BB')
  assert.equal(m.positions.Alice, 'BTN')
  assert.equal(m.gradeMode, 'solver_llm')
  assert.equal(m.startState!.pot, 6.5)            // 3bb open + 3bb call + 0.5bb dead SB
  assert.equal(m.startState!.effectiveStack, 37.2) // villain had 40.24bb
  assert.equal(m.startState!.heroIsIP, false)
  assert.match(m.ranges!.villainDesc, /BTN open/)
  assert.ok(m.ranges!.hero.includes('7s4h'), 'hero combo is added to its range')
  assert.equal(m.spots.length, 3)                  // check on every street
  assert.deepEqual(m.spots[0].streetHistory, [])
  assert.equal(m.netBb, -3)
})

test('heads-up 3-bet pot uses 3-bet and call-3-bet ranges', () => {
  const m = mapHand(parseHand(fx('hu_3bet.txt'), HERO))
  assert.equal(m.gradeMode, 'solver_llm')
  assert.match(m.ranges!.heroDesc, /3-bet/)
  assert.match(m.ranges!.villainDesc, /call 3-bet/)
  assert.match(m.startState!.preflopContext, /3-bet pot/)
})

test('preflop rules: premium pairs raise, trash folds', () => {
  const h = parseHand(fx('hu_srp.txt'), HERO)
  const line = analyzePreflop(h, assignPositions(h))
  const d = line.heroDecisions[0]
  assert.equal(d.situation, 'facing_open')
  assert.equal(d.verdict, 'no')                    // 74o is not a BB defend vs a BTN open
  const kk = analyzePreflop({ ...h, heroCards: 'KcKs' }, assignPositions(h)).heroDecisions[0]
  assert.equal(kk.freqs.raise, 1)
})

test('history reports calls as the total called to', () => {
  const m = mapHand(parseHand(fx('hu_srp.txt'), HERO))
  assert.deepEqual(m.history!.find(h => h.actor === 'hero' && h.street === 'Preflop'), { street: 'Preflop', actor: 'hero', action: 'call', amount: 3 })
})

import { isPokerNowCsv, pokerNowToPokerStars, pokerNowHeroCandidates } from './pokernow'

test('PokerNow CSV log converts to gradable hands', () => {
  const csv = fx('pokernow_log.csv')
  assert.ok(isPokerNowCsv(csv))
  assert.equal(pokerNowHeroCandidates(csv)[0], HERO)
  const { hands, errors } = pokerNowToPokerStars(csv)
  assert.equal(errors.length, 0)
  assert.equal(hands.length, 3)
  for (const t of hands) {
    const h = parseHand(t, HERO)
    assert.equal(h.heroCards?.length, 4)
    assert.ok(h.board.length >= 3)
    // calls are converted from PokerNow's "total called to" into chips added
    const m = mapHand(h)
    assert.notEqual(m.gradeMode, 'skipped')
  }
})
