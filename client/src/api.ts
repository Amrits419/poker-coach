import axios from 'axios'

const api = axios.create({ baseURL: 'http://localhost:3001/api' })

export interface Action {
  street: 'Preflop' | 'Flop' | 'Turn' | 'River'
  action: string
  amount?: number
}

export interface HandInput {
  userId: string
  position: string
  holeCards: string
  board: string
  actions: Action[]
  potSize: number
  stackSize: number
}

export interface StreetBreakdown {
  street: string
  decision: string
  assessment: string
  evImpact: string
}

export interface Analysis {
  summary: string
  streetBreakdown: StreetBreakdown[]
  leaks: string[]
  score: number
  recommendation: string
}

export interface Hand {
  id: string
  position: string
  holeCards: string
  board: string
  actions: Action[]
  potSize: number
  stackSize: number
  analysis: Analysis
  leaks: string[]
  createdAt: string
}

export interface LeakEntry {
  leak: string
  count: number
}

export const createUser = (email: string, username: string) =>
  api.post('/users', { email, username }).then(r => r.data)

export const submitHand = (hand: HandInput) =>
  api.post('/hands', hand).then(r => r.data as { hand: Hand; analysis: Analysis })

export const getUserHands = (userId: string) =>
  api.get(`/hands/user/${userId}`).then(r => r.data as Hand[])

export const getUserLeaks = (userId: string) =>
  api.get(`/hands/leaks/${userId}`).then(r => r.data as LeakEntry[])
