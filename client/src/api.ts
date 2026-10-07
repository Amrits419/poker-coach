import axios from 'axios'

// Relative path — the nginx container proxies /api to the server container
// in Docker, and the Vite dev-server proxy (vite.config.ts) does the same
// for `npm run dev`, so this works unchanged in both environments.
const api = axios.create({ baseURL: '/api' })

export interface Setup {
  position: string
  isMultiway: boolean
  stackDepth: string
}

export interface StartState {
  holeCards: string
  villainHoleCards: string[]
  villainPositions: string[]
  board: { flop: string[]; turn: string; river: string }
  heroIsIP: boolean
  heroIsPFR: boolean
  preflopContext: string
  pot: number
  effectiveStack: number
  preflopRaiseAmount: number | null
}

export interface HandHistoryEntry {
  street: string
  actor: 'hero' | 'villain'
  action: string
  amount?: number
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

export interface LeakEntry {
  leak: string
  count: number
}

export interface TrainerHand {
  id: string
  setup: Setup
  scenario: StartState
  userActions: HandHistoryEntry[]
  analysis: Analysis
  leaks: string[]
  createdAt: string
}

export const createUser = (email: string, username: string) =>
  api.post('/users', { email, username }).then(r => r.data)

export const startHand = (userId: string, setup: Setup) =>
  api.post('/trainer/start', { userId, setup }).then(r => r.data as StartState)

export const villainAct = (
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  currentBoard: string[],
  pot: number,
  effectiveStack: number,
  actingVillainIndex: number = 0
) =>
  api.post('/trainer/villain-act', { setup, startState, history, currentStreet, currentBoard, pot, effectiveStack, actingVillainIndex })
    .then(r => r.data as VillainResponse)

export const analyzeHand = (
  userId: string,
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[]
) =>
  api.post('/trainer/analyze', { userId, setup, startState, history }).then(r => r.data as { analysis: Analysis })

export const getHistory = (userId: string) =>
  api.get(`/trainer/history/${userId}`).then(r => r.data as TrainerHand[])

export const getLeaks = (userId: string) =>
  api.get(`/trainer/leaks/${userId}`).then(r => r.data as LeakEntry[])
