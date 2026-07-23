import { useState } from 'react'
import type { Setup } from '../api'

const POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const STACK_DEPTHS = ['25bb', '50bb', '100bb', '150bb', '200bb']

const POS_DESC: Record<string, string> = {
  UTG: 'Under the Gun', 'UTG+1': 'UTG+1', MP: 'Middle', HJ: 'Hijack',
  CO: 'Cutoff', BTN: 'Button', SB: 'Small Blind', BB: 'Big Blind',
}

interface Props {
  onStart: (setup: Setup) => void
  loading: boolean
}

export default function SetupScreen({ onStart, loading }: Props) {
  const [position, setPosition] = useState('BTN')
  const [isMultiway, setIsMultiway] = useState(false)
  const [stackDepth, setStackDepth] = useState('100bb')

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-white font-bold text-xl tracking-tight">New Hand</h2>
        <p className="text-slate-500 text-sm mt-0.5">Configure your scenario</p>
      </div>

      {/* Position */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-sm font-medium text-slate-300">Position</label>
          <span className="text-xs text-emerald-400 font-medium">{POS_DESC[position]}</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {POSITIONS.map(p => (
            <button
              key={p}
              onClick={() => setPosition(p)}
              className={`py-2.5 rounded-xl text-sm font-semibold transition-all ${
                position === p
                  ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/40'
                  : 'bg-slate-800/80 text-slate-400 hover:text-white hover:bg-slate-700 border border-slate-700/50'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Pot type */}
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-3">Pot Type</label>
        <div className="flex gap-2 p-1 bg-slate-800/60 rounded-xl border border-slate-700/50">
          {[false, true].map(multi => (
            <button
              key={String(multi)}
              onClick={() => setIsMultiway(multi)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                isMultiway === multi
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {multi ? 'Multiway' : 'Heads Up'}
            </button>
          ))}
        </div>
      </div>

      {/* Stack depth */}
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-3">Effective Stack</label>
        <div className="flex gap-2">
          {STACK_DEPTHS.map(d => (
            <button
              key={d}
              onClick={() => setStackDepth(d)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                stackDepth === d
                  ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/40'
                  : 'bg-slate-800/80 text-slate-400 hover:text-white border border-slate-700/50'
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
        className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold py-4 rounded-xl transition-all shadow-lg shadow-emerald-900/30 text-base"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="animate-spin text-lg">♠</span>
            Dealing hand...
          </span>
        ) : 'Deal Hand'}
      </button>
    </div>
  )
}
