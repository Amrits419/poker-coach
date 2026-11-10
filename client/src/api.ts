import axios from 'axios'

// Relative path — the nginx container proxies /api to the server container
// in Docker, and the Vite dev-server proxy (vite.config.ts) does the same
// for `npm run dev`, so this works unchanged in both environments.
const api = axios.create({ baseURL: '/api' })

export interface Setup {
  position: string
  isMultiway: boolean
  stackDepth: string
  betSize?: string   // solver bet size, % of pot: '33' | '50' | '75' | '100'
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
  preflopBets?: Record<string, number>  // chips per position before hero's first action
}

export interface HandHistoryEntry {
  street: string
  actor: 'hero' | 'villain'
  action: string
  amount?: number      // bet/raise: total in front on that street; call: total called to
  villainIdx?: number  // which villain acted (index into StartState.villainPositions)
}

/** The server's view of the hand after a given history: everything the table draws. */
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

/** Solver context for a villain action; posted back to /trainer/explain for the coach's wording. */
export type ExplainContext = Record<string, unknown>

export interface VillainActResponse {
  entry: HandHistoryEntry
  history: HandHistoryEntry[]
  description: string
  explain: ExplainContext | null
  table: TableState
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
  result?: HandResult
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
  api.post('/trainer/start', { userId, setup }).then(r => r.data as { startState: StartState; table: TableState })

export const getTable = (setup: Setup, startState: StartState, history: HandHistoryEntry[]) =>
  api.post('/trainer/table', { setup, startState, history }).then(r => (r.data as { table: TableState }).table)

export const villainAct = (setup: Setup, startState: StartState, history: HandHistoryEntry[]) =>
  api.post('/trainer/villain-act', { setup, startState, history }).then(r => r.data as VillainActResponse)

export const explainVillain = (explain: ExplainContext) =>
  api.post('/trainer/explain', { explain }).then(r => (r.data as { description: string }).description)

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

// ── Sessions (imported hand histories) ────────────────────────────────────────

export interface Session {
  id: string
  name: string
  source: string
  site: string | null
  heroName: string
  status: 'grading' | 'done' | 'failed' | 'needs_calibration'
  captureInfo?: { frames: number; durationMin: number; textBoxes: number; amountsSeen: number; message: string } | null
  stakes: string | null
  handsTotal: number
  handsGraded: number
  error: string | null
  startedAt: string | null
  createdAt: string
}

export interface SessionSummary {
  handsTotal: number
  handsDealt: number
  handsGraded: number
  vpip: number
  pfr: number
  netBb: number
  bbPer100: number
  avgScore: number | null
  verdicts: { yes: number; close: number; no: number }
  modes: Record<string, number>
  byPosition: { position: string; hands: number; netBb: number; mistakes: number }[]
  leakCategories: { category: string; count: number }[]
  biggestMistakes: string[]
}

export type GradeMode = 'solver_llm' | 'llm_only' | 'preflop_rule' | 'skipped'

export interface SessionHandRow {
  id: string
  seq: number
  heroPosition: string | null
  heroCards: string | null
  board: string[]
  playersDealt: number
  heroVoluntary: boolean
  sawFlop: boolean
  netBb: number
  gradeMode: GradeMode
  score: number | null
  mistakes: number
  leaks: string[]
  graded: boolean
  error: string | null
  summary: string | null
}

export interface SolverDetail {
  street: string
  heroAction: string
  heroAmount?: number
  heroFreq: number
  mix: { action: string; amount?: number; frequency: number }[]
  equity: number
  tree: string
  sizingNote?: string
}

export interface RecordedHand {
  id: string
  sessionId: string
  seq: number
  hhText: string
  heroPosition: string | null
  heroCards: string | null
  board: string[]
  playersDealt: number
  netBb: number
  gradeMode: GradeMode
  gradeNote: string | null
  startState: StartState | null
  analysis: Analysis | null
  details: { solver?: SolverDetail[]; notes?: string[] } | null
  score: number | null
  error: string | null
  gradedAt: string | null
}

export const previewImport = (text: string) =>
  api.post('/sessions/preview', { text }).then(r => r.data as { format?: string; hands: number; heroCandidates: string[] })

export const importSession = (userId: string, text: string, heroName: string, name: string) =>
  api.post('/sessions/import', { userId, text, heroName, name }).then(r => r.data as { session: Session; parseErrors: number })

export const listSessions = (userId: string) =>
  api.get('/sessions', { params: { userId } }).then(r => r.data as Session[])

export const getSession = (id: string) =>
  api.get(`/sessions/${id}`).then(r => r.data as { session: Session; summary: SessionSummary; hands: SessionHandRow[] })

export const getRecordedHand = (id: string) =>
  api.get(`/sessions/hands/${id}`).then(r => r.data as RecordedHand)

export const deleteSession = (id: string) => api.delete(`/sessions/${id}`)

export const importCapture = (userId: string, dir: string) =>
  api.post('/sessions/capture', { userId, dir }).then(r => r.data as { session: Session })
