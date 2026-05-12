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

  if (loading) return <p className="text-slate-500 text-sm">Loading...</p>

  const avgScore = hands.length > 0
    ? Math.round(hands.reduce((sum, h) => sum + h.analysis.score, 0) / hands.length)
    : null

  const maxCount = leaks[0]?.count || 1

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-800 rounded-lg p-4">
          <p className="text-slate-400 text-xs uppercase tracking-wide">Hands Played</p>
          <p className="text-3xl font-bold text-white mt-1">{hands.length}</p>
        </div>
        <div className="bg-slate-800 rounded-lg p-4">
          <p className="text-slate-400 text-xs uppercase tracking-wide">Avg Score</p>
          <p className={`text-3xl font-bold mt-1 ${
            avgScore == null ? 'text-slate-500' :
            avgScore >= 75 ? 'text-emerald-400' :
            avgScore >= 50 ? 'text-yellow-400' : 'text-red-400'
          }`}>
            {avgScore ?? '—'}
          </p>
        </div>
      </div>

      <div>
        <p className="text-slate-400 text-xs uppercase tracking-wide mb-3">Your Leaks</p>
        {leaks.length === 0 ? (
          <p className="text-slate-500 text-sm">No hands played yet.</p>
        ) : (
          <div className="space-y-3">
            {leaks.slice(0, 8).map(({ leak, count }) => (
              <div key={leak}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-slate-300">{leak}</span>
                  <span className="text-slate-500">{count}x</span>
                </div>
                <div className="h-1.5 bg-slate-700 rounded-full">
                  <div
                    className="h-1.5 bg-red-500 rounded-full"
                    style={{ width: `${(count / maxCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {hands.length > 0 && (
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wide mb-3">Recent Hands</p>
          <div className="space-y-2">
            {hands.slice(0, 5).map(hand => (
              <div key={hand.id} className="bg-slate-800 rounded-lg p-3 flex justify-between items-center">
                <div>
                  <span className="text-white text-sm font-medium">{hand.scenario.holeCards}</span>
                  <span className="text-slate-500 text-xs ml-2">{hand.setup.position}</span>
                  <span className="text-slate-500 text-xs ml-2">{hand.setup.stackDepth}</span>
                </div>
                <span className={`text-sm font-bold ${
                  hand.analysis.score >= 75 ? 'text-emerald-400' :
                  hand.analysis.score >= 50 ? 'text-yellow-400' : 'text-red-400'
                }`}>
                  {hand.analysis.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
