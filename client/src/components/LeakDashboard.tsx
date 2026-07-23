import { useEffect, useState } from 'react'
import type { LeakEntry, TrainerHand } from '../api'
import { getLeaks, getHistory } from '../api'

interface Props {
  userId: string
}

export default function LeakDashboard({ userId }: Props) {
  const [leaks, setLeaks] = useState<LeakEntry[]>([])
  const [hands, setHands] = useState<TrainerHand[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getLeaks(userId), getHistory(userId)])
      .then(([l, h]) => { setLeaks(l); setHands(h) })
      .finally(() => setLoading(false))
  }, [userId])

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <span className="animate-spin text-2xl text-slate-600">♠</span>
    </div>
  )

  const avgScore = hands.length > 0
    ? Math.round(hands.reduce((sum, h) => sum + h.analysis.score, 0) / hands.length)
    : null

  const maxCount = leaks[0]?.count || 1

  const scoreColor =
    avgScore == null ? '#64748b' :
    avgScore >= 75 ? '#10b981' :
    avgScore >= 50 ? '#f59e0b' : '#ef4444'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-white font-bold text-xl tracking-tight">Your Stats</h2>
        <p className="text-slate-500 text-sm mt-0.5">{hands.length} hand{hands.length !== 1 ? 's' : ''} played</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/60 border border-slate-700/40 rounded-2xl p-4">
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wide">Hands Played</p>
          <p className="text-3xl font-black text-white mt-1">{hands.length}</p>
        </div>
        <div className="bg-slate-800/60 border border-slate-700/40 rounded-2xl p-4">
          <p className="text-slate-500 text-xs font-medium uppercase tracking-wide">Avg Score</p>
          <p className="text-3xl font-black mt-1" style={{ color: scoreColor }}>
            {avgScore ?? '—'}
          </p>
        </div>
      </div>

      {/* Leaks */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Top Leaks</p>
        {leaks.length === 0 ? (
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-6 text-center">
            <p className="text-slate-500 text-sm">Play some hands to see your leaks.</p>
          </div>
        ) : (
          <div className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-4 space-y-4">
            {leaks.slice(0, 8).map(({ leak, count }) => (
              <div key={leak}>
                <div className="flex justify-between items-start gap-3 mb-1.5">
                  <span className="text-slate-300 text-sm leading-snug">{leak}</span>
                  <span className="text-slate-500 text-xs font-bold shrink-0 mt-0.5">{count}×</span>
                </div>
                <div className="h-1.5 bg-slate-700/60 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all"
                    style={{ width: `${(count / maxCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent hands */}
      {hands.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Hands</p>
          <div className="space-y-2">
            {hands.slice(0, 6).map(hand => {
              const sc = hand.analysis.score
              const c = sc >= 75 ? 'text-emerald-400' : sc >= 50 ? 'text-yellow-400' : 'text-red-400'
              return (
                <div key={hand.id} className="bg-slate-800/40 border border-slate-700/30 rounded-xl px-4 py-3 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <span className="text-white font-bold text-sm font-mono tracking-widest">{hand.scenario.holeCards}</span>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 text-xs">{hand.setup.position}</span>
                      <span className="text-slate-600 text-xs">·</span>
                      <span className="text-slate-500 text-xs">{hand.setup.stackDepth}</span>
                      {hand.setup.isMultiway && <span className="text-slate-600 text-xs">· MW</span>}
                    </div>
                  </div>
                  <span className={`text-base font-black ${c}`}>{sc}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
