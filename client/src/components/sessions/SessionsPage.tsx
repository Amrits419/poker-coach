import { useEffect, useRef, useState } from 'react'
import { listSessions, importCapture, type Session } from '../../api'
import ImportPanel from './ImportPanel'
import SessionView from './SessionView'
import HandView from './HandView'
import { Panel } from './ui'

export default function SessionsPage({ userId, captureDir }: { userId: string; captureDir?: string | null }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState('')
  const captureStarted = useRef(false)

  // A recording just ended in Poker Recorder: import it and open its report
  useEffect(() => {
    if (!captureDir || captureStarted.current) return
    captureStarted.current = true
    importCapture(userId, captureDir)
      .then(r => { setSessionId(r.session.id); window.history.replaceState(null, '', window.location.pathname) })
      .catch(e => setCaptureError(e?.response?.data?.error ?? 'Could not load that recording.'))
  }, [userId, captureDir])
  const [hand, setHand] = useState<{ id: string; ids: string[] } | null>(null)

  useEffect(() => { listSessions(userId).then(setSessions).catch(() => {}) }, [userId, sessionId])

  if (sessionId && hand) {
    const i = hand.ids.indexOf(hand.id)
    return <HandView handId={hand.id} onBack={() => setHand(null)} hasNext={i >= 0 && i < hand.ids.length - 1}
      onNext={() => setHand({ ...hand, id: hand.ids[i + 1] })} />
  }
  if (sessionId) return <SessionView sessionId={sessionId} onBack={() => setSessionId(null)} onOpenHand={(id, ids) => setHand({ id, ids })} />

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_380px]">
      {captureError && <Panel className="lg:col-span-2"><p className="text-[13px] text-raise">{captureError}</p></Panel>}
      <Panel title="Your sessions">
        {sessions.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-white/45">No sessions yet. Import a hand-history file to get a rundown of every decision you made.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {sessions.map(s => (
              <button key={s.id} onClick={() => setSessionId(s.id)} className="flex w-full items-center justify-between gap-3 py-3 text-left first:pt-0 last:pb-0 hover:opacity-90">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-white">{s.name}</p>
                  <p className="text-[12px] text-white/40">{s.site} · {s.stakes} · {s.handsTotal} hands · {new Date(s.createdAt).toLocaleDateString()}</p>
                </div>
                <span className={`shrink-0 text-[11px] font-semibold ${s.status === 'done' ? 'text-call' : s.status === 'failed' ? 'text-raise' : 'text-accent'}`}>
                  {s.status === 'grading' ? `Grading ${s.handsGraded}/${s.handsTotal}` : s.status === 'done' ? 'Ready' : s.status === 'needs_calibration' ? 'Recorded' : 'Failed'}
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>
      <ImportPanel userId={userId} onImported={s => setSessionId(s.id)} />
    </div>
  )
}
