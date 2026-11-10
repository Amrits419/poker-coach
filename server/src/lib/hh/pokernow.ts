// PokerNow's "Download log" CSV (columns entry,at,order; newest first) → PokerStars-format
// hand text, so it goes through the same parser, mapper and grader as every other import.
// The raw log never names "you"; it only says "Your hand is …", so the hero is inferred as
// the player seated in every hand that has a "Your hand is" line.

const SUIT: Record<string, string> = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }
const card = (c: string) => { const m = c.trim().match(/^(10|[2-9JQKA])([♠♥♦♣])$/); return m ? `${m[1] === '10' ? 'T' : m[1]}${SUIT[m[2]]}` : '' }
const cardList = (s: string) => s.split(',').map(card).filter(Boolean)
const money = (n: number) => n.toFixed(2)

export const isPokerNowCsv = (text: string) => /^﻿?entry,at,order\s*$/m.test(text.slice(0, 200))

/** Minimal CSV reader for PokerNow's three-column log (quoted fields, "" escapes). */
function readCsv(text: string): { entry: string; at: string; order: number }[] {
  const rows: string[][] = []
  let field = '', row: string[] = [], q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') q = false
      else field += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.slice(1).map(r => ({ entry: r[0] ?? '', at: r[1] ?? '', order: Number(r[2] ?? 0) }))
    .sort((a, b) => a.order - b.order)
}

interface RawHand { id: string; at: string; dealer: string; lines: string[] }

function splitRawHands(text: string): RawHand[] {
  const hands: RawHand[] = []
  let cur: RawHand | null = null
  for (const r of readCsv(text)) {
    const start = r.entry.match(/^-- starting hand #(\d+) \(id: (\w+)\)/)
    if (start) { cur = { id: `${start[1]}-${start[2]}`, at: r.at, dealer: nameOf(r.entry), lines: [] }; continue }
    if (/^-- ending hand #/.test(r.entry)) { if (cur) hands.push(cur); cur = null; continue }
    cur?.lines.push(r.entry)
  }
  return hands
}

const playerRe = /"(.+?) @ ([^"]+)"/
const nameOf = (s: string) => s.match(playerRe)?.[1] ?? ''

/** Players ranked by how likely they are to be the person who downloaded the log. */
export function pokerNowHeroCandidates(text: string): string[] {
  // Signals, strongest first: showing down exactly the "Your hand is" cards; being seated in
  // every hand where we were dealt cards; NOT being seated in hands where we had none.
  const score: Record<string, number> = {}
  const bump = (n: string, v: number) => { score[n] = (score[n] ?? 0) + v }
  for (const h of splitRawHands(text)) {
    const mine = h.lines.find(l => l.startsWith('Your hand is'))
    const seated = [...(h.lines.find(l => l.startsWith('Player stacks:')) ?? '').matchAll(/"(.+?) @ [^"]+"/g)].map(m => m[1])
    for (const n of seated) bump(n, mine ? 1 : -1)
    if (!mine) continue
    const myCards = cardList(mine.replace('Your hand is', '')).sort().join('')
    for (const l of h.lines) {
      const m = l.match(/ shows a (.+?)\.?$/)
      if (m && cardList(m[1]).length === 2 && cardList(m[1]).sort().join('') === myCards) bump(nameOf(l), 1000)
    }
  }
  return Object.entries(score).sort((a, b) => b[1] - a[1]).map(([n]) => n)
}

/** Convert a PokerNow CSV log into PokerStars-format hand texts. */
export function pokerNowToPokerStars(text: string, heroName?: string): { hands: string[]; errors: string[] } {
  const hero = heroName ?? pokerNowHeroCandidates(text)[0]
  const out: string[] = [], errors: string[] = []
  for (const h of splitRawHands(text)) {
    try { out.push(convertHand(h, hero)) }
    catch (e) { errors.push(`Hand ${h.id}: ${(e as Error).message}`) }
  }
  return { hands: out, errors }
}

function convertHand(h: RawHand, hero?: string): string {
  const stacksLine = h.lines.find(l => l.startsWith('Player stacks:'))
  if (!stacksLine) throw new Error('no "Player stacks" line')
  const seats = [...stacksLine.matchAll(/#(\d+) "(.+?) @ [^"]+" \(([\d.]+)\)/g)].map(m => ({ seat: +m[1], name: m[2], stack: +m[3] }))
  const sb = h.lines.map(l => l.match(/posts a small blind of ([\d.]+)/)).find(Boolean)
  const bb = h.lines.map(l => l.match(/posts a big blind of ([\d.]+)/)).find(Boolean)
  const bigBlind = bb ? +bb[1] : 0
  if (!bigBlind) throw new Error('no big blind posted')
  const smallBlind = sb ? +sb[1] : bigBlind / 2

  const L: string[] = []
  const date = new Date(h.at)
  const ts = isNaN(date.getTime()) ? '' : ` - ${date.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/')} UTC`
  L.push(`PokerNow Hand #${h.id}: Hold'em No Limit (${money(smallBlind)}/${money(bigBlind)})${ts}`)
  L.push(`Table 'PokerNow' 10-max Seat #${buttonSeat(h, seats)} is the button`)
  for (const s of seats) L.push(`Seat ${s.seat}: ${s.name} (${money(s.stack)} in chips)`)

  let street = 'Preflop'
  const committed: Record<string, number> = {}
  let currentBet = 0
  const flush = () => { for (const k of Object.keys(committed)) delete committed[k]; currentBet = 0 }
  const add = (n: string, v: number) => { committed[n] = Math.round(((committed[n] ?? 0) + v) * 100) / 100 }
  let holeDone = false
  const holeCards = () => {
    if (holeDone) return
    holeDone = true
    L.push('*** HOLE CARDS ***')
    const mine = h.lines.find(l => l.startsWith('Your hand is'))
    if (mine && hero) L.push(`Dealt to ${hero} [${cardList(mine.replace('Your hand is', '')).join(' ')}]`)
  }

  let secondRun = false
  for (const line of h.lines) {
    let m: RegExpMatchArray | null
    const who = nameOf(line)
    const allIn = /go all in/.test(line) ? ' and is all-in' : ''
    if ((m = line.match(/posts a (small blind|big blind|straddle) of ([\d.]+)/))) {
      const v = +m[2]; add(who, v); currentBet = Math.max(currentBet, v)
      L.push(m[1] === 'straddle' ? `${who}: straddle ${money(v)}` : `${who}: posts ${m[1]} ${money(v)}`)
      continue
    }
    if ((m = line.match(/^(Flop|Turn|River)( \(second run\))?:\s+(.*)$/))) {
      if (m[2]) { secondRun = true; continue }
      holeCards()
      street = m[1]; flush()
      const groups = [...m[3].matchAll(/\[([^\]]+)\]/g)].map(g => cardList(g[1]))
      const before = m[3].replace(/\[[^\]]*\]/g, '').trim()
      if (street === 'Flop') L.push(`*** FLOP *** [${groups[0].join(' ')}]`)
      else L.push(`*** ${street.toUpperCase()} *** [${cardList(before).join(' ')}] [${groups[groups.length - 1].join(' ')}]`)
      continue
    }
    if (!who) continue
    if (/ folds$/.test(line)) { holeCards(); L.push(`${who}: folds`); continue }
    if (/ checks$/.test(line)) { holeCards(); L.push(`${who}: checks`); continue }
    if ((m = line.match(/ calls ([\d.]+)/))) {
      holeCards()
      // PokerNow logs the total called to; PokerStars logs the chips added
      const to = +m[1], added = Math.max(0, Math.round((to - (committed[who] ?? 0)) * 100) / 100)
      add(who, added); L.push(`${who}: calls ${money(added)}${allIn}`); continue
    }
    if ((m = line.match(/ bets ([\d.]+)/))) { holeCards(); add(who, +m[1]); currentBet = +m[1]; L.push(`${who}: bets ${money(+m[1])}${allIn}`); continue }
    if ((m = line.match(/ raises to ([\d.]+)/))) {
      holeCards()
      const to = +m[1], by = Math.round((to - currentBet) * 100) / 100   // PokerStars: "raises <increase over the bet> to <total>"
      committed[who] = to; currentBet = to
      L.push(`${who}: raises ${money(Math.max(0, by))} to ${money(to)}${allIn}`); continue
    }
    if ((m = line.match(/^Uncalled bet of ([\d.]+) returned to/))) { L.push(`Uncalled bet (${money(+m[1])}) returned to ${who}`); continue }
    if ((m = line.match(/ collected ([\d.]+) from pot/))) { L.push(`${who} collected ${money(+m[1])} from pot`); continue }
    if ((m = line.match(/ shows a (.+?)\.?$/))) { L.push(`${who}: shows [${cardList(m[1]).join(' ')}]`); continue }
  }
  holeCards()
  L.push('*** SUMMARY ***')
  if (secondRun) L.push('Hand was run twice')
  return L.join('\n')
}

/** The dealer named in the "-- starting hand" line; if missing, the seat before the small blind. */
function buttonSeat(h: RawHand, seats: { seat: number; name: string }[]): number {
  const dealer = seats.find(s => s.name === h.dealer)
  if (dealer) return dealer.seat
  const sbName = nameOf(h.lines.find(l => l.includes('posts a small blind')) ?? '')
  const sorted = [...seats].sort((a, b) => a.seat - b.seat)
  const i = sorted.findIndex(s => s.name === sbName)
  if (i === -1) return sorted[0]?.seat ?? 1
  if (sorted.length === 2) return sorted[i].seat
  return sorted[(i - 1 + sorted.length) % sorted.length].seat
}
