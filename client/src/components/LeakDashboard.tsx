import { useEffect, useState } from 'react'
import type { LeakEntry, TrainerHand } from '../api'
import { getLeaks, getHistory } from '../api'
import { Card } from './Card'
import { parseCards } from '../lib/cards'

interface Props { userId: string }

function Stat({ label, value, tone = 'text-white' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
      <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{label}</p>
      <p className={`mt-1 text-3xl font-extrabold tracking-tight ${tone}`}>{value}</p>
    </div>
  )
}

const tone = (s: number | null) => s == null ? 'text-white/40' : s >= 75 ? 'text-call' : s >= 50 ? 'text-amber-300' : 'text-raise'

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
    <div className="flex items-center justify-center py-24 text-[13px] text-white/40">
      <span className="mr-2 h-2 w-2 animate-pulse rounded-full bg-accent" />Loading your history…
    </div>
  )

  const avgScore = hands.length ? Math.round(hands.reduce((sum, h) => sum + h.analysis.score, 0) / hands.length) : null
  const last10 = hands.slice(0, 10)
  const recentAvg = last10.length ? Math.round(last10.reduce((s, h) => s + h.analysis.score, 0) / last10.length) : null
  const maxCount = leaks[0]?.count || 1

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Hands played" value={hands.length} />
        <Stat label="Average score" value={avgScore ?? '—'} tone={tone(avgScore)} />
        <Stat label="Last 10" value={recentAvg ?? '—'} tone={tone(recentAvg)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-white/45">Most frequent leaks</h3>
          {leaks.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-white/40">Play a few hands and your leaks will show up here.</p>
          ) : (
            <div className="space-y-3">
              {leaks.slice(0, 8).map(({ leak, count }) => (
                <div key={leak}>
                  <div className="mb-1 flex items-start justify-between gap-3">
                    <span className="text-[13px] leading-snug text-white/80">{leak}</span>
                    <span className="shrink-0 text-[12px] font-bold text-white/50">{count}×</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-600">
                    <div className="h-full rounded-full bg-raise" style={{ width: `${(count / maxCount) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-white/45">Recent hands</h3>
          {hands.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-white/40">No hands yet.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {hands.slice(0, 8).map(hand => (
                <div key={hand.id} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <div className="flex gap-0.5">{parseCards(hand.scenario.holeCards).map((c, i) => <Card key={i} card={c} size="sm" />)}</div>
                    <div className="text-[12px] text-white/50">
                      <span className="font-semibold text-white/80">{hand.setup.position}</span> · {hand.setup.stackDepth}{hand.setup.isMultiway ? ' · multiway' : ''}
                      <div className="text-[11px] text-white/35">{new Date(hand.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                    </div>
                  </div>
                  <span className={`text-lg font-extrabold ${tone(hand.analysis.score)}`}>{hand.analysis.score}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
