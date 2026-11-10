// Best five-card hand out of 5-7 cards. `rank` compares lexicographically:
// [category, tiebreakers...], higher is better.

const RANKS = '23456789TJQKA'
const NAME: Record<number, string> = {
  14: 'ace', 13: 'king', 12: 'queen', 11: 'jack', 10: 'ten', 9: 'nine', 8: 'eight',
  7: 'seven', 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two',
}
const plural = (v: number) => (v === 6 ? 'sixes' : `${NAME[v]}s`)

export interface HandRank { rank: number[]; name: string }

/** Highest card of a straight in a set of ranks (the wheel A-5 counts as 5-high), or 0. */
function straightHigh(vals: Set<number>): number {
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true
    for (let k = 0; k < 5 && ok; k++) {
      const v = hi - k
      ok = vals.has(v === 1 ? 14 : v)
    }
    if (ok) return hi
  }
  return 0
}

export function evaluateHand(cards: string[]): HandRank {
  const vals = cards.map(c => RANKS.indexOf(c[0].toUpperCase()) + 2)
  const suits = cards.map(c => c[1].toLowerCase())

  const bySuit: Record<string, number[]> = {}
  vals.forEach((v, i) => { (bySuit[suits[i]] ??= []).push(v) })
  const flush = Object.values(bySuit).find(vs => vs.length >= 5)?.sort((a, b) => b - a)

  if (flush) {
    const sf = straightHigh(new Set(flush))
    if (sf) return { rank: [8, sf], name: sf === 14 ? 'a royal flush' : `a straight flush, ${NAME[sf]} high` }
  }

  const count = new Map<number, number>()
  for (const v of vals) count.set(v, (count.get(v) ?? 0) + 1)
  // Most copies first, then highest rank
  const groups = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const kickers = (exclude: number[], n: number) =>
    [...count.keys()].filter(v => !exclude.includes(v)).sort((a, b) => b - a).slice(0, n)

  const [g0, g1] = groups
  if (g0[1] === 4) return { rank: [7, g0[0], ...kickers([g0[0]], 1)], name: `four of a kind, ${plural(g0[0])}` }

  if (g0[1] === 3) {
    // The pair half is the best remaining rank with two or more copies
    const pair = groups.slice(1).filter(g => g[1] >= 2).map(g => g[0]).sort((a, b) => b - a)[0]
    if (pair) return { rank: [6, g0[0], pair], name: `a full house, ${plural(g0[0])} full of ${plural(pair)}` }
  }

  if (flush) return { rank: [5, ...flush.slice(0, 5)], name: `a flush, ${NAME[flush[0]]} high` }

  const st = straightHigh(new Set(vals))
  if (st) return { rank: [4, st], name: `a straight, ${NAME[st]} high` }

  if (g0[1] === 3) return { rank: [3, g0[0], ...kickers([g0[0]], 2)], name: `three of a kind, ${plural(g0[0])}` }

  if (g0[1] === 2 && g1?.[1] === 2) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a).slice(0, 2)
    return { rank: [2, ...pairs, ...kickers(pairs, 1)], name: `two pair, ${plural(pairs[0])} and ${plural(pairs[1])}` }
  }

  if (g0[1] === 2) return { rank: [1, g0[0], ...kickers([g0[0]], 3)], name: `a pair of ${plural(g0[0])}` }

  const top = kickers([], 5)
  return { rank: [0, ...top], name: `${NAME[top[0]]} high` }
}

/** > 0 if a beats b, < 0 if b beats a, 0 for a tie. */
export function compareHands(a: HandRank, b: HandRank): number {
  for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
    const d = (a.rank[i] ?? 0) - (b.rank[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
