import { useEffect, useMemo, useState } from 'react'
import { getSession, deleteSession, type Session, type SessionSummary, type SessionHandRow } from '../../api'
import { Card } from '../Card'
import { parseCards } from '../../lib/cards'
import { Panel, Stat, ModeBadge } from './ui'
import { scoreTone, netTone, fmtBb } from '../../lib/format'

type Filter = 'played' | 'flop' | 'mistakes' | 'all'

export default function SessionView({ sessionId, onBack, onOpenHand }: {
  sessionId: string; onBack: () => void; onOpenHand: (id: string, ids: string[]) => void
}) {
  const [data, setData] = useState<{ session: Session; summary: SessionSummary; hands: SessionHandRow[] } | null>(null)
  const [filter, setFilter] = useState<Filter>('played')

  useEffect(() => {
    let alive = true, timer: number | undefined
    const tick = async () => {
      const d = await getSession(sessionId).catch(() => null)
      if (!alive || !d) return
      setData(d)
      if (d.session.status === 'grading') timer = window.setTimeout(tick, 3000)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [sessionId])

  const shown = useMemo(() => {
    const hs = data?.hands ?? []
    return hs.filter(h => filter === 'all' ? true : filter === 'played' ? h.gradeMode !== 'skipped'
      : filter === 'flop' ? h.sawFlop : h.mistakes > 0)
  }, [data, filter])

  if (!data) return <div className="py-24 text-center text-[13px] text-white/40">Loading session…</div>
  const { session, summary, hands } = data
  if (session.status === 'needs_calibration') {
    const info = session.captureInfo
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <div>
          <button onClick={onBack} className="mb-1 text-[12px] font-medium text-white/40 hover:text-white">← All sessions</button>
          <h1 className="text-xl font-bold tracking-tight text-white">{session.name}</h1>
          <p className="text-[13px] text-white/45">Table log from Poker Recorder (text only, no screenshots)</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Table changes logged" value={info?.frames ?? 0} />
          <Stat label="Length" value={`${info?.durationMin ?? 0} min`} />
          <Stat label="Amounts read" value={info?.amountsSeen ?? 0} sub="stacks, bets, pot" />
        </div>
        <Panel title="Hand rebuilding isn't calibrated for this table yet">
          <p className="text-[13px] leading-relaxed text-white/65">{info?.message}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/65">
            The table log is kept on this Mac, so once the reader is calibrated this session can be graded without replaying anything.
          </p>
        </Panel>
      </div>
    )
  }
  const byId = new Map(hands.map(h => [h.id, h]))
  const grading = session.status === 'grading'
  const progress = summary.handsTotal ? Math.round(summary.handsGraded / summary.handsTotal * 100) : 0
  const maxLeak = summary.leakCategories[0]?.count || 1
  const decisions = summary.verdicts.yes + summary.verdicts.close + summary.verdicts.no
  const open = (id: string) => onOpenHand(id, shown.map(h => h.id))

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <button onClick={onBack} className="mb-1 text-[12px] font-medium text-white/40 hover:text-white">← All sessions</button>
          <h1 className="text-xl font-bold tracking-tight text-white">{session.name}</h1>
          <p className="text-[13px] text-white/45">{session.site} · {session.stakes} · hero <span className="text-white/70">{session.heroName}</span></p>
        </div>
        <button onClick={async () => { if (window.confirm('Delete this session and its graded hands?')) { await deleteSession(session.id); onBack() } }}
          className="text-[12px] font-medium text-white/30 hover:text-raise">Delete session</button>
      </div>

      {grading && (
        <Panel>
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-white/70"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              Grading hands… solver spots and coach write-ups take a few seconds each</span>
            <span className="font-semibold text-white">{summary.handsGraded} / {summary.handsTotal}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-600"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} /></div>
        </Panel>
      )}
      {session.status === 'failed' && <Panel><p className="text-[13px] text-raise">Grading stopped: {session.error}</p></Panel>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Hands played" value={summary.handsDealt} sub={`${summary.handsTotal} in file`} />
        <Stat label="VPIP / PFR" value={`${summary.vpip} / ${summary.pfr}`} sub="% of hands dealt" />
        <Stat label="Result" value={fmtBb(summary.netBb)} sub={`${summary.bbPer100 > 0 ? '+' : ''}${summary.bbPer100} bb/100`} tone={netTone(summary.netBb)} />
        <Stat label="Avg score" value={summary.avgScore ?? '—'} tone={scoreTone(summary.avgScore)} sub="hands you played" />
        <Stat label="Mistakes" value={summary.verdicts.no} sub={`of ${decisions} decisions`} tone={summary.verdicts.no ? 'text-raise' : 'text-call'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Biggest mistakes">
          {summary.biggestMistakes.length === 0 ? <p className="text-[13px] text-white/40">{grading ? 'Still grading…' : 'No mistakes found.'}</p> : (
            <div className="divide-y divide-white/5">
              {summary.biggestMistakes.map(id => byId.get(id)).filter(Boolean).map(h => (
                <button key={h!.id} onClick={() => open(h!.id)} className="flex w-full items-center gap-3 py-2.5 text-left first:pt-0 last:pb-0 hover:opacity-90">
                  <div className="flex shrink-0 gap-0.5">{parseCards(h!.heroCards ?? '').map((c, i) => <Card key={i} card={c} size="sm" />)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-bold text-white">{h!.heroPosition}</span>
                      <ModeBadge mode={h!.gradeMode} />
                      <span className={`font-semibold ${netTone(h!.netBb)}`}>{fmtBb(h!.netBb)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-white/60">{h!.summary}</p>
                  </div>
                  <span className={`text-lg font-extrabold ${scoreTone(h!.score)}`}>{h!.score}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Leaks by spot">
            {summary.leakCategories.length === 0 ? <p className="text-[13px] text-white/40">None yet.</p> : (
              <div className="space-y-2">
                {summary.leakCategories.slice(0, 8).map(l => (
                  <div key={l.category}>
                    <div className="flex justify-between text-[12px]"><span className="text-white/75">{l.category}</span><span className="font-semibold text-white">{l.count}</span></div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-600"><div className="h-full rounded-full bg-raise/80" style={{ width: `${l.count / maxLeak * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="By position">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-white/40"><th className="pb-1.5 font-semibold">Pos</th><th className="pb-1.5 text-right font-semibold">Hands</th><th className="pb-1.5 text-right font-semibold">Result</th><th className="pb-1.5 text-right font-semibold">Mistakes</th></tr></thead>
              <tbody>
                {summary.byPosition.map(p => (
                  <tr key={p.position} className="border-t border-white/5">
                    <td className="py-1.5 font-semibold text-white">{p.position}</td>
                    <td className="py-1.5 text-right text-white/70">{p.hands}</td>
                    <td className={`py-1.5 text-right font-semibold ${netTone(p.netBb)}`}>{fmtBb(p.netBb)}</td>
                    <td className="py-1.5 text-right text-white/70">{p.mistakes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>

      <Panel title="Hands" right={
        <div className="flex gap-1 rounded-lg bg-ink-900 p-0.5">
          {([['played', 'Played'], ['flop', 'Saw flop'], ['mistakes', 'Mistakes'], ['all', 'All']] as [Filter, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${filter === k ? 'bg-ink-600 text-white' : 'text-white/45 hover:text-white'}`}>{l}</button>
          ))}
        </div>
      }>
        <div className="divide-y divide-white/5">
          {shown.map(h => (
            <button key={h.id} onClick={() => h.gradeMode !== 'skipped' && open(h.id)} disabled={h.gradeMode === 'skipped'}
              className="grid w-full grid-cols-[34px_70px_minmax(0,1fr)_auto] items-center gap-3 py-2 text-left disabled:cursor-default sm:grid-cols-[34px_70px_160px_minmax(0,1fr)_auto]">
              <span className="text-[11px] text-white/30">#{h.seq + 1}</span>
              <div className="flex gap-0.5">{parseCards(h.heroCards ?? '').map((c, i) => <Card key={i} card={c} size="sm" />)}</div>
              <div className="hidden items-center gap-0.5 sm:flex">{h.board.map((c, i) => <span key={i} className="scale-90"><Card card={c} size="sm" /></span>)}</div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-bold text-white">{h.heroPosition ?? '—'}</span>
                  <ModeBadge mode={h.gradeMode} />
                  {h.playersDealt > 0 && <span className="text-white/35">{h.playersDealt}-handed</span>}
                </div>
                <p className="truncate text-[12px] text-white/50">{h.error ? `Grading error: ${h.error}` : h.graded ? (h.summary ?? '') : h.gradeMode === 'skipped' ? '' : 'Waiting to be graded…'}</p>
              </div>
              <div className="flex items-center gap-3 text-right">
                <span className={`text-[12px] font-semibold ${netTone(h.netBb)}`}>{h.gradeMode !== 'skipped' ? fmtBb(h.netBb) : ''}</span>
                <span className={`w-8 text-[15px] font-extrabold ${scoreTone(h.score)}`}>{h.score ?? ''}</span>
              </div>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  )
}
