import { useEffect, useState } from 'react'
import { getRecordedHand, type RecordedHand, type StartState } from '../../api'
import AnalysisResult from '../AnalysisResult'
import { Panel, ModeBadge } from './ui'
import { netTone, fmtBb } from '../../lib/format'

const pct = (f: number) => `${Math.round(f * 100)}%`

export default function HandView({ handId, onBack, onNext, hasNext }: {
  handId: string; onBack: () => void; onNext: () => void; hasNext: boolean
}) {
  const [loaded, setLoaded] = useState<RecordedHand | null>(null)
  useEffect(() => {
    let alive = true
    getRecordedHand(handId).then(h => { if (alive) setLoaded(h) })
    return () => { alive = false }
  }, [handId])
  const hand = loaded?.id === handId ? loaded : null
  if (!hand) return <div className="py-24 text-center text-[13px] text-white/40">Loading hand…</div>

  // Hands that ended preflop have no pipeline StartState; build a display-only one
  const startState: StartState = hand.startState ?? {
    holeCards: hand.heroCards ?? '', villainHoleCards: [], villainPositions: [],
    board: { flop: hand.board.slice(0, 3), turn: hand.board[3] ?? '', river: hand.board[4] ?? '' },
    heroIsIP: false, heroIsPFR: false, preflopContext: '', pot: 0, effectiveStack: 0, preflopRaiseAmount: null,
  }
  const solver = hand.details?.solver ?? []
  const notes = (hand.details?.notes ?? []).filter(Boolean)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={onBack} className="text-[12px] font-medium text-white/40 hover:text-white">← Back to session</button>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-white/40">Hand #{hand.seq + 1}</span>
          <span className="font-bold text-white">{hand.heroPosition}</span>
          <span className="text-white/40">{hand.playersDealt}-handed</span>
          <ModeBadge mode={hand.gradeMode} />
          <span className={`font-semibold ${netTone(hand.netBb)}`}>{fmtBb(hand.netBb)}</span>
        </div>
      </div>

      {!hand.gradedAt && <Panel><p className="text-[13px] text-white/50">This hand hasn't been graded yet.</p></Panel>}
      {hand.error && <Panel><p className="text-[13px] text-raise">Grading failed: {hand.error}</p></Panel>}

      {hand.analysis && (
        <AnalysisResult analysis={hand.analysis} startState={startState} villainDescriptions={[]}
          onMenu={onBack} onNext={onNext} hideActions />
      )}

      {(solver.length > 0 || notes.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {solver.length > 0 && (
            <Panel title="Solver numbers">
              <div className="space-y-3">
                {solver.map((s, i) => (
                  <div key={i}>
                    <div className="flex items-baseline justify-between text-[12px]">
                      <span className="font-bold text-white">{s.street} <span className="font-normal text-white/50">· you {s.heroAction}{s.heroAmount ? ` ${s.heroAmount}bb` : ''}</span></span>
                      <span className="text-white/40">{s.tree} tree · equity {pct(s.equity)}</span>
                    </div>
                    <div className="mt-1.5 flex h-5 overflow-hidden rounded-md">
                      {s.mix.filter(m => m.frequency > 0.005).map((m, j) => (
                        <div key={j} title={`${m.action}${m.amount ? ` ${m.amount}bb` : ''}: ${pct(m.frequency)}`}
                          className={`flex items-center justify-center text-[10px] font-bold text-white ${m.action === 'fold' ? 'bg-fold' : m.action === 'check' || m.action === 'call' ? 'bg-call' : 'bg-raise'} ${m.action === s.heroAction ? 'ring-2 ring-inset ring-white' : 'opacity-80'}`}
                          style={{ width: `${m.frequency * 100}%` }}>{m.frequency >= 0.12 ? `${m.action} ${pct(m.frequency)}` : ''}</div>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] text-white/45">Solver takes your action {pct(s.heroFreq)} of the time.</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {notes.length > 0 && (
            <Panel title="How this hand was graded">
              <ul className="space-y-1.5 text-[12px] leading-relaxed text-white/60">{notes.map((n, i) => <li key={i}>• {n}</li>)}</ul>
            </Panel>
          )}
        </div>
      )}

      <details className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
        <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-wider text-white/45">Raw hand history</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/60">{hand.hhText}</pre>
      </details>

      <div className="flex justify-end gap-2 pb-4">
        <button onClick={onBack} className="rounded-xl border border-ink-500 bg-ink-800 px-5 py-3 text-sm font-semibold text-white/70 transition-colors hover:text-white">Back to session</button>
        {hasNext && <button onClick={onNext} className="rounded-xl bg-accent px-6 py-3 text-sm font-bold text-white shadow-[0_8px_30px_rgba(139,124,255,0.3)] transition-colors hover:bg-accent-dim">Next hand →</button>}
      </div>
    </div>
  )
}
