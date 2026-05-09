import { useState } from 'react'
import { Analysis, createUser } from './api'
import HandForm from './components/HandForm'
import AnalysisResult from './components/AnalysisResult'
import LeakDashboard from './components/LeakDashboard'
import './index.css'

type Tab = 'analyze' | 'dashboard'

export default function App() {
  // grab user from localStorage so they don't have to log in every time
  const [userId, setUserId] = useState<string | null>(
    localStorage.getItem('pokerCoachUserId')
  )
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [tab, setTab] = useState<Tab>('analyze')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginLoading(true)
    const user = await createUser(email, username)
    localStorage.setItem('pokerCoachUserId', user.id)
    setUserId(user.id)
    setLoginLoading(false)
  }

  const handleSignOut = () => {
    localStorage.removeItem('pokerCoachUserId')
    setUserId(null)
  }

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">♠</div>
            <h1 className="text-2xl font-bold text-white">AI Poker Coach</h1>
            <p className="text-slate-400 text-sm mt-1">Log hands. Find leaks. Win more.</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-3">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              required
            />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              required
            />
            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-3 rounded-lg transition-colors"
            >
              {loginLoading ? 'Setting up...' : 'Get Started'}
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
          <h1 className="text-lg font-bold text-white">AI Poker Coach</h1>
        </div>
        <button onClick={handleSignOut} className="text-xs text-slate-500 hover:text-slate-300">
          Sign out
        </button>
      </div>

      {/* tab switcher */}
      <div className="flex gap-1 mb-6 bg-slate-800 rounded-lg p-1">
        {(['analyze', 'dashboard'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); setAnalysis(null) }}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors capitalize ${
              tab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'analyze' && (
        analysis
          ? <AnalysisResult analysis={analysis} onReset={() => setAnalysis(null)} />
          : <HandForm userId={userId} onResult={setAnalysis} />
      )}

      {tab === 'dashboard' && <LeakDashboard userId={userId} />}
    </div>
  )
}
