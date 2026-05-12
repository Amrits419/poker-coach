const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']
const SUITS = ['h', 'd', 'c', 's']

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Deal hero cards, villain cards, and board all from one shuffled deck
export function dealFromDeck(numVillains: number): {
  heroCards: string
  villainCards: string[]   // one concatenated string per villain, e.g. "AhKs"
  board: { flop: string[]; turn: string; river: string }
} {
  const deck: string[] = []
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s)
  const d = shuffle(deck)

  let i = 0
  const heroCards = d[i++] + d[i++]
  const villainCards: string[] = []
  for (let v = 0; v < numVillains; v++) {
    villainCards.push(d[i++] + d[i++])
  }
  const board = {
    flop:  [d[i++], d[i++], d[i++]],
    turn:  d[i++],
    river: d[i++],
  }
  return { heroCards, villainCards, board }
}
