// Canonical representation of a real (imported or reconstructed) hand.
// All amounts are in big blinds. Both the file importers and, later, the
// ClubGG screen reconstructor produce this shape.

export type Street = 'Preflop' | 'Flop' | 'Turn' | 'River'
export const STREETS: Street[] = ['Preflop', 'Flop', 'Turn', 'River']

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise'

export interface ParsedSeat {
  seat: number
  name: string
  stack: number        // bb at hand start
}

export interface ParsedPost {
  name: string
  kind: 'sb' | 'bb' | 'straddle' | 'ante' | 'dead'
  amount: number       // bb
}

export interface ParsedAction {
  street: Street
  name: string
  action: ActionKind
  /** bet: amount bet. raise: total the player has in on this street after raising ("to").
   *  call: chips added by the call. fold/check: undefined. All in bb. */
  amount?: number
  allIn: boolean
}

export interface ParsedHand {
  id: string                  // site hand id
  site: string
  startedAt?: string
  smallBlind: number          // currency units, as in the header
  bigBlind: number            // currency units; every other amount is divided by this
  currency: string
  maxSeats: number
  buttonSeat: number
  seats: ParsedSeat[]         // players dealt in, in seat order
  posts: ParsedPost[]
  heroName?: string
  heroCards?: string          // "AhKd"
  actions: ParsedAction[]
  board: string[]             // first board only (run-it-twice keeps the first)
  runTwice: boolean
  shown: Record<string, string[]>
  collected: Record<string, number>   // bb won, summed over pots / boards
  uncalled: { name: string; amount: number }[]
  raw: string
}
