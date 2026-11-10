import type { ParsedHand, ParsedAction, Street } from './model'

// Parser for PokerStars-format hand histories (PokerStars, GG/Natural8 exports,
// PokerNow logs run through a PokerStars converter). Amounts are converted to bb.

const AMOUNT = String.raw`[^\d\s]?([\d,]+(?:\.\d+)?)`   // optional currency symbol
const num = (s: string) => parseFloat(s.replace(/,/g, ''))
const cards = (s: string) => s.trim().split(/\s+/).filter(Boolean)

/** Split a file containing many hands into one text block per hand. */
export function splitHands(text: string): string[] {
  const norm = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  const starts: number[] = []
  const re = /^(PokerStars|GGPoker|Poker Hand|PokerNow)[^\n]*Hand #/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(norm))) starts.push(m.index)
  return starts.map((s, i) => norm.slice(s, starts[i + 1] ?? norm.length).trim()).filter(Boolean)
}

export class ParseError extends Error {}

export function parseHand(text: string, heroName?: string): ParsedHand {
  const lines = text.split('\n').map(l => l.trimEnd())
  const header = lines[0] ?? ''

  const idM = header.match(/Hand #([\w-]+)/)
  const blindsM = header.match(new RegExp(String.raw`\(${AMOUNT}\/${AMOUNT}(?:\s+(\w+))?\)`))
  if (!idM || !blindsM) throw new ParseError(`Unrecognized hand header: ${header.slice(0, 80)}`)
  const smallBlind = num(blindsM[1]), bigBlind = num(blindsM[2])
  if (!(bigBlind > 0)) throw new ParseError('Big blind is zero')
  const bb = (s: string) => Math.round((num(s) / bigBlind) * 100) / 100
  const dateM = header.match(/(\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2})/)

  const tableM = (lines[1] ?? '').match(/(\d+)-max\s+Seat #(\d+) is the button/)
  const hand: ParsedHand = {
    id: idM[1],
    // PokerNow logs converted to PokerStars format keep the converter's table name
    site: /PNLogConverter|pokernow/i.test(lines[1] ?? '') ? 'PokerNow' : header.split(' ')[0],
    startedAt: dateM?.[1],
    smallBlind, bigBlind,
    currency: blindsM[3] ?? '',
    maxSeats: tableM ? parseInt(tableM[1]) : 9,
    buttonSeat: tableM ? parseInt(tableM[2]) : 0,
    seats: [], posts: [], actions: [], board: [],
    runTwice: false, shown: {}, collected: {}, uncalled: [],
    heroName, raw: text,
  }

  let street: Street = 'Preflop'
  let section: 'setup' | 'play' | 'showdown' | 'summary' = 'setup'
  let secondBoard = false

  const seatRe     = new RegExp(String.raw`^Seat (\d+): (.+?) \(${AMOUNT} in chips`)
  const postRe     = new RegExp(String.raw`^(.+?): posts (small blind|big blind|the ante|small & big blinds|straddle)? ?${AMOUNT}`)
  const straddleRe = new RegExp(String.raw`^(.+?): straddle ${AMOUNT}`)
  const betRe      = new RegExp(String.raw`^(.+?): bets ${AMOUNT}`)
  const callRe     = new RegExp(String.raw`^(.+?): calls ${AMOUNT}`)
  const raiseRe    = new RegExp(String.raw`^(.+?): raises ${AMOUNT} to ${AMOUNT}`)
  const uncalledRe = new RegExp(String.raw`^Uncalled bet \(${AMOUNT}\) returned to (.+)$`)
  const collectRe  = new RegExp(String.raw`^(.+?) collected ${AMOUNT} from(?: side| main)? pot`)

  for (const line of lines.slice(1)) {
    if (!line) continue
    let m: RegExpMatchArray | null

    // Section / street markers
    if (line.startsWith('*** HOLE CARDS')) { section = 'play'; continue }
    if (line.startsWith('*** SUMMARY')) { section = 'summary'; continue }
    if (/^\*\*\* (FIRST |SECOND )?SHOW ?DOWN/.test(line)) { section = 'showdown'; secondBoard = false; continue }
    if ((m = line.match(/^\*\*\* (FIRST |SECOND )?(FLOP|TURN|RIVER) \*\*\* (.*)$/))) {
      if (m[1] === 'SECOND ') { hand.runTwice = true; secondBoard = true; continue }
      if (m[1] === 'FIRST ') hand.runTwice = true
      street = (m[2][0] + m[2].slice(1).toLowerCase()) as Street
      // "[5d Ks 9s]" or "[5d Ks 9s] [Td]": the last bracket holds the new cards
      const groups = [...m[3].matchAll(/\[([^\]]+)\]/g)].map(g => cards(g[1]))
      if (street === 'Flop') hand.board = groups[0] ?? []
      else if (groups.length) hand.board.push(...groups[groups.length - 1])
      if (!m[1]) section = 'play'
      continue
    }
    if (section === 'summary') {
      if (/^Hand was run twice/.test(line)) hand.runTwice = true
      continue
    }
    if (secondBoard) continue

    if (section === 'setup' && (m = line.match(seatRe))) {
      hand.seats.push({ seat: parseInt(m[1]), name: m[2], stack: bb(m[3]) })
      continue
    }
    if ((m = line.match(straddleRe))) { hand.posts.push({ name: m[1], kind: 'straddle', amount: bb(m[2]) }); continue }
    if ((m = line.match(postRe))) {
      const kind = m[2] === 'small blind' ? 'sb' : m[2] === 'big blind' ? 'bb' : m[2] === 'the ante' ? 'ante'
                 : m[2] === 'straddle' ? 'straddle' : 'dead'
      hand.posts.push({ name: m[1], kind, amount: bb(m[3]) })
      continue
    }
    if ((m = line.match(/^Dealt to (.+?) \[([^\]]+)\]/))) {
      if (!hand.heroName || hand.heroName === m[1]) {
        hand.heroName = m[1]
        hand.heroCards = cards(m[2]).join('')
      }
      continue
    }
    if ((m = line.match(uncalledRe))) { hand.uncalled.push({ name: m[2], amount: bb(m[1]) }); continue }
    if ((m = line.match(collectRe))) {
      hand.collected[m[1]] = Math.round(((hand.collected[m[1]] ?? 0) + bb(m[2])) * 100) / 100
      continue
    }
    if ((m = line.match(/^(.+?): shows \[([^\]]+)\]/))) {
      hand.shown[m[1]] = [...(hand.shown[m[1]] ?? []), ...cards(m[2])]
      continue
    }
    if (section !== 'play') continue

    const allIn = /all-in/i.test(line)
    const push = (a: Omit<ParsedAction, 'street' | 'allIn'>) => hand.actions.push({ street, allIn, ...a })
    if ((m = line.match(/^(.+?): folds/)))  { push({ name: m[1], action: 'fold' }); continue }
    if ((m = line.match(/^(.+?): checks/))) { push({ name: m[1], action: 'check' }); continue }
    if ((m = line.match(raiseRe))) { push({ name: m[1], action: 'raise', amount: bb(m[3]) }); continue }
    if ((m = line.match(betRe)))   { push({ name: m[1], action: 'bet', amount: bb(m[2]) }); continue }
    if ((m = line.match(callRe)))  { push({ name: m[1], action: 'call', amount: bb(m[2]) }); continue }
  }

  if (hand.seats.length < 2) throw new ParseError(`Hand ${hand.id}: fewer than two seats`)
  return hand
}

/** Parse a whole file. Hands that fail to parse are reported, not thrown. */
export function parseFile(text: string, heroName?: string): { hands: ParsedHand[]; errors: string[] } {
  const hands: ParsedHand[] = [], errors: string[] = []
  for (const block of splitHands(text)) {
    try { hands.push(parseHand(block, heroName)) }
    catch (e) { errors.push((e as Error).message) }
  }
  return { hands, errors }
}
