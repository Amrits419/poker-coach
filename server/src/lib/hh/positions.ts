import type { ParsedHand } from './model'

// Seats between the big blind and the button (inclusive of the button), by how many
// there are, mapped onto the labels ranges.ts knows. Short-handed "UTG" plays like a
// full-ring MP by range width, so 6-max starts at MP.
const LATE_LABELS: Record<number, string[]> = {
  1: ['BTN'],
  2: ['CO', 'BTN'],
  3: ['HJ', 'CO', 'BTN'],
  4: ['MP', 'HJ', 'CO', 'BTN'],
  5: ['UTG', 'MP', 'HJ', 'CO', 'BTN'],
  6: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN'],
  7: ['UTG', 'UTG+1', 'MP', 'MP', 'HJ', 'CO', 'BTN'],
  8: ['UTG', 'UTG', 'UTG+1', 'MP', 'MP', 'HJ', 'CO', 'BTN'],
}

/** Position label for every player dealt in, keyed by name. */
export function assignPositions(hand: Pick<ParsedHand, 'seats' | 'buttonSeat' | 'posts'>): Record<string, string> {
  const seats = [...hand.seats].sort((a, b) => a.seat - b.seat)
  const n = seats.length
  // Rotate so the list starts with the first seat after the button. A dead button
  // (button seat empty) still works: the first seat numerically after it is the SB.
  let start = seats.findIndex(s => s.seat > hand.buttonSeat)
  if (start === -1) start = 0
  const order = [...seats.slice(start), ...seats.slice(0, start)]   // SB, BB, ..., BTN

  const out: Record<string, string> = {}
  if (n === 2) {
    // Heads-up: the button posts the small blind and acts last postflop.
    const btn = order[1]
    out[btn.name] = 'BTN'
    out[order[0].name] = 'BB'
    return out
  }
  out[order[0].name] = 'SB'
  out[order[1].name] = 'BB'
  const late = order.slice(2)
  const labels = LATE_LABELS[late.length] ?? LATE_LABELS[8]
  // More than 10-handed: extra early seats are all UTG.
  const pad = late.length - labels.length
  late.forEach((s, i) => { out[s.name] = i < pad ? 'UTG' : labels[i - Math.max(0, pad)] })
  return out
}
