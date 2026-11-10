import type { GradeMode } from '../../api'

export function Panel({ title, right, children, className = '' }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h3 className="text-[11px] font-bold uppercase tracking-wider text-white/45">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, sub, tone = 'text-white' }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
      <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tracking-tight ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-white/40">{sub}</p>}
    </div>
  )
}


const MODE: Record<GradeMode, { label: string; cls: string; title: string }> = {
  solver_llm:   { label: 'Solver',      cls: 'border-accent/40 bg-accent/15 text-accent', title: 'Postflop decisions graded by the GTO solver, explained by the coach' },
  llm_only:     { label: 'Coach only',  cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300', title: 'Multiway or unmodelled line: the coach grades without solver numbers' },
  preflop_rule: { label: 'Preflop',     cls: 'border-white/15 bg-white/5 text-white/60', title: 'Hand ended preflop for you: graded from the range tables' },
  skipped:      { label: 'Not dealt',   cls: 'border-white/10 bg-transparent text-white/30', title: 'You were not dealt into this hand' },
}
export function ModeBadge({ mode }: { mode: GradeMode }) {
  const m = MODE[mode]
  return <span title={m.title} className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${m.cls}`}>{m.label}</span>
}
