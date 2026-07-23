export interface Setup {
  position: string
  isMultiway: boolean
  stackDepth: string
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
