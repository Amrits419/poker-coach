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
  amount?: number
}

export interface StartState {
  holeCards: string
  villainHoleCards: string[]
  villainPositions: string[]
  board: { flop: string[]; turn: string; river: string }
  heroIsIP: boolean
  heroIsPFR: boolean           // true = hero made the last preflop raise; false = hero called
  preflopContext: string
  pot: number
  effectiveStack: number
  preflopRaiseAmount: number | null  // villain's open size when heroIsPFR=false, else null
  preflopBets: Record<string, number> // chips each position has in front of them when hero first acts (blinds, open, 3-bet)
}

export interface VillainResponse {
  action: string
  amount?: number
  description: string
  potOdds: string | null
  newPot: number
  newStack: number
  isHandOver: boolean
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
}
