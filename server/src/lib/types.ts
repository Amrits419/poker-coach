export interface Setup {
  position: string
  isMultiway: boolean
  stackDepth: string
  betSize?: string   // solver's single bet size as % of pot, e.g. '33' | '50' | '75' | '100'
}

const BET_SIZES = new Set(['33', '50', '75', '100'])
/** postflop-solver size string for a setup, or undefined to use the solver default */
export function solverBetSizes(setup: Setup): string | undefined {
  return setup.betSize && BET_SIZES.has(setup.betSize) ? `${setup.betSize}%` : undefined
}

export interface HandHistoryEntry {
  street: string
  actor: 'hero' | 'villain'
  action: string
  amount?: number      // bet/raise: total in front on that street; call: total called to
  villainIdx?: number  // which villain acted (index into StartState.villainPositions)
}

export interface StartState {
  holeCards: string
  villainHoleCards: string[]
  villainPositions: string[]
  board: { flop: string[]; turn: string; river: string }
  heroIsIP: boolean
  heroIsPFR: boolean           // true = hero made the last preflop raise; false = hero called
  preflopContext: string
  pot: number                  // everything on the table when hero first acts, blinds included
  effectiveStack: number       // hero's chips behind at that point
  preflopRaiseAmount: number | null  // villain's open size when heroIsPFR=false, else null
  preflopBets: Record<string, number> // chips each position has in front of them when hero first acts (blinds, open, 3-bet)
}

export interface Analysis {
  summary: string
  streetFeedback: {
    street: string
    heroAction: string
    correct: string
    explanation: string
    betterPlay: string
  }[]
  leaks: string[]
  score: number
  studyPlan: string[]
  result?: HandResult   // trainer hands only: who won and what it was worth
}

/** What the client needs to draw the table and offer hero the legal actions. */
export interface TableState {
  street: string
  pot: number
  heroStack: number
  heroIn: number                 // hero's chips in front on this street
  bets: Record<string, number>   // chips in front of each position on this street
  folded: number[]               // villain indices that have folded
  toAct: 'hero' | number | null  // number = villain index
  toCall: number                 // total hero must match; 0 = hero can check
  callCost: number               // chips a call adds
  canRaise: boolean
  minRaise: number               // smallest legal bet / raise-to
  maxRaise: number               // all-in
  potOdds: string | null
  preflopRaises: number          // 0 unopened, 1 open, 2 three-bet, ...
  handOver: boolean
  allInRunout: boolean
}

export interface HandResult {
  outcome: 'won' | 'lost' | 'split'
  how: 'fold' | 'showdown'
  netBb: number
  pot: number
  heroHand?: string
  villainHand?: string
  villainPosition?: string
}
