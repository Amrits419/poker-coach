import { useState } from 'react'
import type { Action, HandInput, Analysis } from '../api'
import { submitHand } from '../api'

const POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const

interface Props {
  userId: string
  onResult: (analysis: Analysis) => void
}

export default function HandForm({ userId, onResult }: Props) {
  const [position, setPosition] = useState('BTN')
  const [holeCards, setHoleCards] = useState('')
  const [board, setBoard] = useState('')
  const [potSize, setPotSize] = useState('')
  const [stackSize, setStackSize] = useState('')
  const [actions, setActions] = useState<Action[]>([{ street: 'Preflop', action: '' }])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const addAction = () =>
    setActions(prev => [...prev, { street: 'Preflop', action: '' }])

  const updateAction = (i: number, field: keyof Action, value: string | number) =>
    setActions(prev => prev.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)))

  const removeAction = (i: number) =>
    setActions(prev => prev.filter((_, idx) => idx !== i))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const hand: HandInput = {
        userId,
        position,
        holeCards,
        board,
        actions,
        potSize: parseFloat(potSize),
        stackSize: parseFloat(stackSize),
      }
      const { analysis } = await submitHand(hand)
      onResult(analysis)
    } catch (err) {
      setError('Failed to analyze — make sure the server is running and your API key is set.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Position</label>
          <select
            value={position}
            onChange={e => setPosition(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white"
          >
            {POSITIONS.map(p => <option key={p}>{p}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">Hole Cards</label>
          <input
            value={holeCards}
            onChange={e => setHoleCards(e.target.value)}
            placeholder="e.g. AhKd"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">Board (leave blank if preflop)</label>
          <input
            value={board}
            onChange={e => setBoard(e.target.value)}
            placeholder="e.g. Tc7s2h"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Pot ($)</label>
            <input
              type="number"
              value={potSize}
              onChange={e => setPotSize(e.target.value)}
              placeholder="120"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Stack ($)</label>
            <input
              type="number"
              value={stackSize}
              onChange={e => setStackSize(e.target.value)}
              placeholder="500"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* actions — each row is one decision point */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <label className="text-sm text-slate-400">Actions</label>
          <button
            type="button"
            onClick={addAction}
            className="text-xs text-emerald-400 hover:text-emerald-300"
          >
            + Add action
          </button>
        </div>

        <div className="space-y-2">
          {actions.map((a, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select
                value={a.street}
                onChange={e => updateAction(i, 'street', e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-white text-sm"
              >
                {STREETS.map(s => <option key={s}>{s}</option>)}
              </select>

              <input
                value={a.action}
                onChange={e => updateAction(i, 'action', e.target.value)}
                placeholder="e.g. raise 3x, call, fold"
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500"
              />

              <input
                type="number"
                value={a.amount ?? ''}
                onChange={e => updateAction(i, 'amount', parseFloat(e.target.value))}
                placeholder="$"
                className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-white text-sm placeholder-slate-500"
              />

              {actions.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeAction(i)}
                  className="text-slate-500 hover:text-red-400 text-xl leading-none"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-3 rounded-lg transition-colors"
      >
        {loading ? 'Analyzing...' : 'Analyze Hand'}
      </button>
    </form>
  )
}
