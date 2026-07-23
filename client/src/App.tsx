import { useState } from 'react'
import type { Setup, StartState, Analysis } from './api'
import { createUser, startHand } from './api'
import SetupScreen from './components/Setup'
import HandTrainer, { type VillainDesc } from './components/HandTrainer'
import AnalysisResult from './components/AnalysisResult'
import LeakDashboard from './components/LeakDashboard'
import './index.css'

type Screen = 'setup' | 'playing' | 'analysis' | 'dashboard'

export default function App() {
  const [userId, setUserId] = useState<string | null>(
    localStorage.getItem('pokerCoachUserId')
  )
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [screen, setScreen] = useState<Screen>('setup')
  const [currentSetup, setCurrentSetup] = useState<Setup | null>(null)
  const [currentStartState, setCurrentStartState] = useState<StartState | null>(null)
  const [currentAnalysis, setCurrentAnalysis] = useState<Analysis | null>(null)
  const [currentVillainDescs, setCurrentVillainDescs] = useState<VillainDesc[]>([])
  const [generating, setGenerating] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginLoading(true)
    const user = await createUser(email, username)
    localStorage.setItem('pokerCoachUserId', user.id)
    setUserId(user.id)
    setLoginLoading(false)
  }

  const handleStart = async (setup: Setup) => {
    setGenerating(true)
    setCurrentSetup(setup)
    const state = await startHand(userId!, setup)
    setCurrentStartState(state)
    setScreen('playing')
    setGenerating(false)
  }

  const handleAnalysisDone = (analysis: Analysis, villainDescs: VillainDesc[]) => {
    setCurrentAnalysis(analysis)
    setCurrentVillainDescs(villainDescs)
    setScreen('analysis')
  }

  const handleNextHand = () => {
    setCurrentStartState(null)
    setCurrentAnalysis(null)
    setScreen('setup')
  }

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-600/20 border border-emerald-500/30 mb-4">
              <span className="text-3xl">♠</span>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Poker Coach</h1>
            <p className="text-slate-400 text-sm mt-1.5">AI-powered GTO training</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-3">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username"
              required
              className="w-full bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 transition-colors"
            />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 transition-colors"
            />
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold py-3 rounded-xl transition-colors mt-1"
            >
              {loginLoading ? 'Setting up...' : 'Start Training'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen max-w-xl mx-auto px-4 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between py-4 mb-2">
        <button
          onClick={() => setScreen('setup')}
          className="flex items-center gap-2 group"
        >
          <div className="w-7 h-7 rounded-lg bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center">
            <span className="text-sm">♠</span>
          </div>
          <span className="text-white font-bold text-sm tracking-tight">Poker Coach</span>
        </button>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setScreen(screen === 'dashboard' ? 'setup' : 'dashboard')}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              screen === 'dashboard'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            {screen === 'dashboard' ? '← Play' : 'Stats'}
          </button>
          <button
            onClick={() => { localStorage.removeItem('pokerCoachUserId'); setUserId(null) }}
            className="text-xs text-slate-600 hover:text-slate-400 px-2 py-1.5 transition-colors"
          >
            Out
          </button>
        </div>
      </div>

      {screen === 'setup' && (
        <SetupScreen onStart={handleStart} loading={generating} />
      )}

      {screen === 'playing' && currentStartState && currentSetup && (
        <HandTrainer
          userId={userId}
          setup={currentSetup}
          startState={currentStartState}
          onDone={handleAnalysisDone}
        />
      )}

      {screen === 'analysis' && currentAnalysis && currentStartState && (
        <AnalysisResult
          analysis={currentAnalysis}
          startState={currentStartState}
          villainDescriptions={currentVillainDescs}
          onNext={handleNextHand}
          onMenu={() => setScreen('setup')}
        />
      )}

      {screen === 'dashboard' && <LeakDashboard userId={userId} />}
    </div>
  )
}
