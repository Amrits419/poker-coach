import { useState } from 'react'
import type { Setup } from '../api'

const POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const STACK_DEPTHS = ['25bb', '50bb', '100bb', '150bb', '200bb']

interface Props {
  onStart: (setup: Setup) => void
  loading: boolean
}

export default function SetupScreen({ onStart, loading }: Props) {
  const [position, setPosition] = useState('BTN')
  const [isMultiway, setIsMultiway] = useState(false)
  const [stackDepth, setStackDepth] = useState('100bb')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-white font-semibold text-lg mb-1">New Hand</h2>
        <p className="text-slate-400 text-sm">Set up the scenario before we deal.</p>
      </div>

      <div>
        <label className="block text-sm text-slate-400 mb-2">Your Position</label>
        <div className="grid grid-cols-4 gap-2">
          {POSITIONS.map(p => (
            <button
              key={p}
              onClick={() => setPosition(p)}
              className={`py-2 rounded-lg text-sm font-medium transition-colors ${
                position === p
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm text-slate-400 mb-2">Pot Type</label>
        <div className="flex gap-2">
          {[false, true].map(multi => (
            <button
              key={String(multi)}
              onClick={() => setIsMultiway(multi)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isMultiway === multi
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {multi ? 'Multiway' : 'Heads Up'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm text-slate-400 mb-2">Effective Stack</label>
        <div className="flex gap-2 flex-wrap">
          {STACK_DEPTHS.map(d => (
            <button
              key={d}
              onClick={() => setStackDepth(d)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                stackDepth === d
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => onStart({ position, isMultiway, stackDepth })}
        disabled={loading}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-3 rounded-lg transition-colors"
      >
        {loading ? 'Dealing...' : 'Deal Hand ♠'}
      </button>
    </div>
  )
}
