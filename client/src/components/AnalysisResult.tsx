import type { Analysis, StartState } from '../api'
import type { VillainDesc } from './HandTrainer'
import { Card } from './Card'
import { parseCards } from '../lib/cards'

const VERDICT: Record<string, { label: string; cls: string; bar: string }> = {
  yes:   { label: 'Correct', cls: 'border-call/40 bg-call/15 text-call',   bar: 'bg-call' },
  close: { label: 'Close',   cls: 'border-amber-400/40 bg-amber-400/15 text-amber-300', bar: 'bg-amber-400' },
  no:    { label: 'Mistake', cls: 'border-raise/40 bg-raise/15 text-raise', bar: 'bg-raise' },
}

interface Props {
  analysis: Analysis
  startState: StartState
  villainDescriptions: VillainDesc[]
  onNext: () => void
  onMenu: () => void
  nextLoading?: boolean
}

function Panel({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4 ${className}`}>
      {title && <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-white/45">{title}</h3>}
      {children}
    </section>
  )
}

export default function AnalysisResult({ analysis, startState, villainDescriptions, onNext, onMenu, nextLoading }: Props) {
  const heroCards = parseCards(startState.holeCards)
  const board = [...startState.board.flop, startState.board.turn, startState.board.river].filter(Boolean)
  const score = Math.max(0, Math.min(100, analysis.score))
  const scoreTone = score >= 75 ? 'text-call' : score >= 50 ? 'text-amber-300' : 'text-raise'
  const scoreBar = score >= 75 ? 'bg-call' : score >= 50 ? 'bg-amber-400' : 'bg-raise'
  const counts = analysis.streetFeedback.reduce((acc, s) => { acc[s.correct] = (acc[s.correct] ?? 0) + 1; return acc }, {} as Record<string, number>)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* ── Summary strip ─────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Panel>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">Hand score</p>
              <p className={`mt-1 text-5xl font-extrabold leading-none tracking-tight ${scoreTone}`}>{score}<span className="text-lg text-white/30">/100</span></p>
            </div>
            <div className="flex gap-1 text-[11px] font-semibold">
              {(['yes', 'close', 'no'] as const).map(k => counts[k] ? (
                <span key={k} className={`rounded-md border px-1.5 py-0.5 ${VERDICT[k].cls}`}>{counts[k]} {VERDICT[k].label.toLowerCase()}</span>
              ) : null)}
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-600">
            <div className={`h-full rounded-full ${scoreBar}`} style={{ width: `${score}%` }} />
          </div>
          <div className="mt-4 flex items-end justify-between gap-3">
            <div>
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/40">You</p>
              <div className="flex gap-1">{heroCards.map((c, i) => <Card key={i} card={c} size="md" />)}</div>
            </div>
            <div className="space-y-1.5">
              {startState.villainPositions.map((pos, vi) => (
                <div key={pos} className="flex items-center justify-end gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">{pos}</span>
                  <div className="flex gap-1">{parseCards(startState.villainHoleCards[vi] ?? '').map((c, i) => <Card key={i} card={c} size="sm" />)}</div>
                </div>
              ))}
            </div>
          </div>
          {board.length > 0 && (
            <div className="mt-3 border-t border-white/5 pt-3">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/40">Board</p>
              <div className="flex gap-1">{board.map((c, i) => <Card key={i} card={c} size="md" />)}</div>
            </div>
          )}
        </Panel>

        <Panel title="Coach verdict" className="flex flex-col">
          <p className="text-[14px] leading-relaxed text-white/85">{analysis.summary}</p>
          {analysis.leaks.length > 0 && (
            <div className="mt-auto pt-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-white/40">Leaks spotted</p>
              <div className="flex flex-wrap gap-1.5">
                {analysis.leaks.map((leak, i) => (
                  <span key={i} className="rounded-md border border-raise/30 bg-raise/10 px-2 py-1 text-[12px] font-medium text-raise">{leak}</span>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* ── Decision breakdown ────────────────────────────────────────── */}
      <Panel title="Decision by decision">
        <div className="divide-y divide-white/5">
          {analysis.streetFeedback.map((s, i) => {
            const v = VERDICT[s.correct] ?? { label: s.correct, cls: 'border-white/10 text-white/60', bar: 'bg-white/30' }
            return (
              <div key={i} className="grid gap-3 py-3.5 first:pt-0 last:pb-0 sm:grid-cols-[140px_1fr]">
                <div className="flex items-start gap-3 sm:block">
                  <div className={`mb-1.5 h-1 w-10 rounded-full ${v.bar}`} />
                  <p className="text-[13px] font-bold text-white">{s.street}</p>
                  <p className="text-[12px] text-white/50">You: <span className="font-semibold text-white/80">{s.heroAction}</span></p>
                  <span className={`mt-2 inline-block rounded-md border px-2 py-0.5 text-[11px] font-bold ${v.cls}`}>{v.label}</span>
                </div>
                <div>
                  <p className="text-[13px] leading-relaxed text-white/80">{s.explanation}</p>
                  {s.correct !== 'yes' && s.betterPlay && (
                    <div className="mt-2.5 rounded-xl border border-call/25 bg-call/10 px-3.5 py-2.5">
                      <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-call">Better play</p>
                      <p className="text-[13px] leading-relaxed text-white/85">{s.betterPlay}</p>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {villainDescriptions.length > 0 && (
          <Panel title="What the villain was doing">
            <div className="space-y-2.5">
              {villainDescriptions.map((v, i) => (
                <div key={i} className="flex gap-3">
                  <span className="w-14 shrink-0 pt-0.5 text-[10px] font-bold uppercase tracking-wider text-white/40">{v.street}</span>
                  <p className="text-[13px] leading-relaxed text-white/70">{v.description}</p>
                </div>
              ))}
            </div>
          </Panel>
        )}
        <Panel title="Drill next">
          <ol className="space-y-2.5">
            {analysis.studyPlan.map((item, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/20 text-[11px] font-bold text-accent">{i + 1}</span>
                <p className="text-[13px] leading-relaxed text-white/80">{item}</p>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <div className="flex justify-end gap-2 pb-4">
        <button onClick={onMenu} className="rounded-xl border border-ink-500 bg-ink-800 px-5 py-3 text-sm font-semibold text-white/70 transition-colors hover:text-white">
          Change setup
        </button>
        <button onClick={onNext} disabled={nextLoading}
          className="rounded-xl bg-accent px-6 py-3 text-sm font-bold text-white shadow-[0_8px_30px_rgba(139,124,255,0.3)] transition-colors hover:bg-accent-dim disabled:bg-ink-600 disabled:text-white/40 disabled:shadow-none">
          {nextLoading ? 'Dealing…' : 'Next hand →'}
        </button>
      </div>
    </div>
  )
}
