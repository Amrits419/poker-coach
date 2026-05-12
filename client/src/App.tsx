import { useState } from 'react'
import type { Setup, StartState, Analysis } from './api'
import { createUser, startHand } from './api'
import SetupScreen from './components/Setup'
import HandTrainer from './components/HandTrainer'
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

  const handleAnalysisDone = (analysis: Analysis) => {
    setCurrentAnalysis(analysis)
    setScreen('analysis')
  }

  const handleNextHand = () => {
    setCurrentStartState(null)
    setCurrentAnalysis(null)
    setScreen('setup')
  }

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">♠</div>
            <h1 className="text-2xl font-bold text-white">Poker Trainer</h1>
            <p className="text-slate-400 text-sm mt-1">AI-powered hand training. Learn your leaks.</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-3">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username"
              required
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-3 rounded-lg transition-colors"
            >
              {loginLoading ? 'Setting up...' : 'Start Training'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen max-w-xl mx-auto p-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <span className="text-2xl">♠</span>
          <h1 className="text-lg font-bold text-white">Poker Trainer</h1>
        </div>
        <div className="flex gap-2 items-center">
          {screen !== 'dashboard' && (
            <button
              onClick={() => setScreen('dashboard')}
              className="text-xs text-slate-400 hover:text-white border border-slate-700 px-3 py-1.5 rounded-lg"
            >
              Stats
            </button>
          )}
          {screen === 'dashboard' && (
            <button
              onClick={() => setScreen('setup')}
              className="text-xs text-slate-400 hover:text-white border border-slate-700 px-3 py-1.5 rounded-lg"
            >
              Play
            </button>
          )}
          <button
            onClick={() => { localStorage.removeItem('pokerCoachUserId'); setUserId(null) }}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Sign out
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
          onNext={handleNextHand}
          onMenu={() => setScreen('setup')}
        />
      )}

      {screen === 'dashboard' && <LeakDashboard userId={userId} />}
    </div>
  )
}
