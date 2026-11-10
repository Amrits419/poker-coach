import { useState } from 'react'
import { previewImport, importSession, type Session } from '../../api'
import { Panel } from './ui'

export default function ImportPanel({ userId, onImported }: { userId: string; onImported: (s: Session) => void }) {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<{ format?: string; hands: number; heroCandidates: string[] } | null>(null)
  const [hero, setHero] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async (t: string, fname = '') => {
    setText(t); setFileName(fname); setError(''); setPreview(null)
    if (!t.trim()) return
    try {
      const p = await previewImport(t)
      setPreview(p)
      setHero(p.heroCandidates[0] ?? '')
      if (!name) setName(fname.replace(/\.(txt|log|csv)$/i, ''))
      if (!p.hands) setError('No hands found. Use a PokerNow .csv log or PokerStars-format hand histories.')
    } catch { setError('Could not read that file.') }
  }

  const submit = async () => {
    setBusy(true); setError('')
    try { onImported((await importSession(userId, text, hero, name)).session) }
    catch (e) { setError((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Import failed.') }
    finally { setBusy(false) }
  }

  return (
    <Panel title="Import a session">
      <p className="mb-3 text-[13px] leading-relaxed text-white/55">
        Upload a PokerNow game log (the .csv from Log → Download) or a hand-history file in PokerStars format (PokerStars, GGPoker exports).
        Every hand you were dealt is graded: preflop from range tables, heads-up postflop spots with the solver.
      </p>
      <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-ink-500 bg-ink-900/60 px-4 py-6 text-[13px] text-white/60 transition-colors hover:border-accent hover:text-white">
        <input type="file" accept=".txt,.log,.csv,text/plain,text/csv" className="hidden"
          onChange={async e => { const f = e.target.files?.[0]; if (f) load(await f.text(), f.name) }} />
        {fileName ? <span className="font-semibold text-white">{fileName}</span> : 'Choose a PokerNow .csv log or a .txt hand history'}
      </label>
      <details className="mt-2">
        <summary className="cursor-pointer text-[12px] text-white/40 hover:text-white/70">…or paste hand histories</summary>
        <textarea value={fileName ? '' : text} onChange={e => load(e.target.value)} rows={5} placeholder="PokerStars Hand #…"
          className="mt-2 w-full rounded-xl border border-ink-500 bg-ink-900 p-3 font-mono text-[11px] text-white/80 outline-none focus:border-accent" />
      </details>

      {preview && preview.hands > 0 && (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] text-white/70"><span className="font-bold text-white">{preview.hands}</span> hands found{preview.format ? ` (${preview.format})` : ''}.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-white/45">You are</span>
              {preview.heroCandidates.length > 0 ? (
                <select value={hero} onChange={e => setHero(e.target.value)}
                  className="w-full rounded-xl border border-ink-500 bg-ink-900 px-3 py-2.5 text-sm text-white outline-none focus:border-accent">
                  {preview.heroCandidates.map(c => <option key={c}>{c}</option>)}
                </select>
              ) : (
                <input value={hero} onChange={e => setHero(e.target.value)} placeholder="Your screen name"
                  className="w-full rounded-xl border border-ink-500 bg-ink-900 px-3 py-2.5 text-sm text-white outline-none focus:border-accent" />
              )}
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-white/45">Session name</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Optional"
                className="w-full rounded-xl border border-ink-500 bg-ink-900 px-3 py-2.5 text-sm text-white outline-none focus:border-accent" />
            </label>
          </div>
          <button onClick={submit} disabled={busy || !hero}
            className="w-full rounded-xl bg-accent py-3 text-sm font-bold text-white transition-colors hover:bg-accent-dim disabled:bg-ink-600 disabled:text-white/40">
            {busy ? 'Importing…' : `Import and grade ${preview.hands} hands`}
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-[13px] text-raise">{error}</p>}
    </Panel>
  )
}
