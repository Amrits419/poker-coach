import { useState } from 'react'
import type { Setup, StartState, Analysis } from './api'
import { createUser, startHand } from './api'
import SetupScreen from './components/Setup'
import HandTrainer, { type VillainDesc } from './components/HandTrainer'
import AnalysisResult from './components/AnalysisResult'
import LeakDashboard from './components/LeakDashboard'
import './index.css'

type Screen = 'setup' | 'playing' | 'analysis' | 'dashboard'

function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[15px] font-black text-white shadow-[0_0_18px_rgba(139,124,255,0.45)]">♠</span>
      <span className="text-[15px] font-bold tracking-tight text-white">Poker Coach</span>
    </span>
  )
}

export default function App() {
  const [userId, setUserId] = useState<string | null>(localStorage.getItem('pokerCoachUserId'))
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [screen, setScreen] = useState<Screen>('setup')
  const [currentSetup, setCurrentSetup] = useState<Setup | null>(null)
  const [currentStartState, setCurrentStartState] = useState<StartState | null>(null)
  const [currentAnalysis, setCurrentAnalysis] = useState<Analysis | null>(null)
  const [currentVillainDescs, setCurrentVillainDescs] = useState<VillainDesc[]>([])
  const [generating, setGenerating] = useState(false)
  const [handKey, setHandKey] = useState(0)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginLoading(true)
    try {
      const user = await createUser(email, username)
      localStorage.setItem('pokerCoachUserId', user.id)
      setUserId(user.id)
    } finally {
      setLoginLoading(false)
    }
  }

  const handleStart = async (setup: Setup) => {
    setGenerating(true)
    try {
      setCurrentSetup(setup)
      const state = await startHand(userId!, setup)
      setCurrentStartState(state)
      setHandKey(k => k + 1)
      setScreen('playing')
    } finally {
      setGenerating(false)
    }
  }

  const handleAnalysisDone = (analysis: Analysis, villainDescs: VillainDesc[]) => {
    setCurrentAnalysis(analysis)
    setCurrentVillainDescs(villainDescs)
    setScreen('analysis')
  }

  const handleNextHand = () => {
    if (currentSetup) { handleStart(currentSetup); return }
    setScreen('setup')
  }

  if (!userId) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-3xl font-black text-white shadow-[0_0_40px_rgba(139,124,255,0.45)]">♠</div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Poker Coach</h1>
            <p className="mt-1.5 text-sm text-white/50">Play against a GTO solver. Get coached on every decision.</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-3 rounded-2xl border border-ink-600/60 bg-ink-800/70 p-5">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/45">Username</span>
              <input value={username} onChange={e => setUsername(e.target.value)} required
                className="w-full rounded-xl border border-ink-500 bg-ink-900 px-3.5 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-accent" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/45">Email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                className="w-full rounded-xl border border-ink-500 bg-ink-900 px-3.5 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-accent" />
            </label>
            <button type="submit" disabled={loginLoading}
              className="mt-1 w-full rounded-xl bg-accent py-3 text-sm font-bold text-white transition-colors hover:bg-accent-dim disabled:bg-ink-600 disabled:text-white/40">
              {loginLoading ? 'Setting up…' : 'Start training'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  const tabs: { id: Screen; label: string }[] = [{ id: 'setup', label: 'Train' }, { id: 'dashboard', label: 'Stats' }]
  const activeTab: Screen = screen === 'dashboard' ? 'dashboard' : 'setup'

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5">
          <button onClick={() => setScreen('setup')}><Logo /></button>
          <nav className="flex items-center gap-1 rounded-lg bg-ink-800 p-1">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setScreen(t.id)}
                className={`rounded-md px-3 py-1 text-[12px] font-semibold transition-colors ${
                  activeTab === t.id ? 'bg-ink-600 text-white' : 'text-white/50 hover:text-white'
                }`}>{t.label}</button>
            ))}
          </nav>
          <button onClick={() => { localStorage.removeItem('pokerCoachUserId'); setUserId(null) }}
            className="text-[12px] font-medium text-white/40 transition-colors hover:text-white">Sign out</button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5">
        {screen === 'setup' && <SetupScreen onStart={handleStart} loading={generating} />}

        {screen === 'playing' && currentStartState && currentSetup && (
          <HandTrainer key={handKey} userId={userId} setup={currentSetup} startState={currentStartState} onDone={handleAnalysisDone} />
        )}

        {screen === 'analysis' && currentAnalysis && currentStartState && (
          <AnalysisResult analysis={currentAnalysis} startState={currentStartState} villainDescriptions={currentVillainDescs}
            onNext={handleNextHand} onMenu={() => setScreen('setup')} nextLoading={generating} />
        )}

        {screen === 'dashboard' && <LeakDashboard userId={userId} />}
      </main>
    </div>
  )
}
