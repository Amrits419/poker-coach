import type { RecordedHand } from '@prisma/client'
import type { Analysis } from '../types'

export interface SessionSummary {
  handsTotal: number
  handsDealt: number
  handsGraded: number
  vpip: number
  pfr: number
  netBb: number
  bbPer100: number
  avgScore: number | null
  verdicts: { yes: number; close: number; no: number }
  modes: Record<string, number>
  byPosition: { position: string; hands: number; netBb: number; mistakes: number }[]
  leakCategories: { category: string; count: number }[]
  biggestMistakes: string[]   // hand ids
}

const POS_ORDER = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']

export function summarize(hands: RecordedHand[]): SessionSummary {
  const dealt = hands.filter(h => h.gradeMode !== 'skipped')
  const graded = dealt.filter(h => h.gradedAt && h.score != null)
  const verdicts = { yes: 0, close: 0, no: 0 }
  const cats: Record<string, number> = {}
  const modes: Record<string, number> = {}
  const pos: Record<string, { hands: number; netBb: number; mistakes: number }> = {}

  for (const h of hands) modes[h.gradeMode] = (modes[h.gradeMode] ?? 0) + 1
  for (const h of dealt) {
    const p = (pos[h.heroPosition ?? '?'] ??= { hands: 0, netBb: 0, mistakes: 0 })
    p.hands++; p.netBb += h.netBb; p.mistakes += h.mistakes
    const a = h.analysis as unknown as Analysis | null
    for (const s of a?.streetFeedback ?? []) {
      if (s.correct === 'yes' || s.correct === 'close' || s.correct === 'no') verdicts[s.correct]++
      if (s.correct === 'no') {
        const c = category(s.street, s.heroAction, h)
        cats[c] = (cats[c] ?? 0) + 1
      }
    }
  }
  const netBb = round(dealt.reduce((s, h) => s + h.netBb, 0))
  const biggest = [...graded].filter(h => h.mistakes > 0)
    .sort((a, b) => b.mistakes - a.mistakes || (a.score ?? 100) - (b.score ?? 100) || Math.abs(b.netBb) - Math.abs(a.netBb))
    .slice(0, 8).map(h => h.id)

  return {
    handsTotal: hands.length,
    handsDealt: dealt.length,
    handsGraded: hands.filter(h => h.gradedAt).length,
    vpip: pct(dealt.filter(h => h.heroVoluntary).length, dealt.length),
    pfr: pct(dealt.filter(h => h.heroPfr).length, dealt.length),
    netBb,
    bbPer100: dealt.length ? round(netBb / dealt.length * 100) : 0,
    // Trivial folds would inflate the average: score the hands hero played or misplayed
    avgScore: avg(graded.filter(h => h.heroVoluntary || h.mistakes > 0).map(h => h.score ?? 0)),
    verdicts, modes,
    byPosition: Object.entries(pos).map(([position, v]) => ({ position, ...v, netBb: round(v.netBb) }))
      .sort((a, b) => POS_ORDER.indexOf(a.position) - POS_ORDER.indexOf(b.position)),
    leakCategories: Object.entries(cats).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    biggestMistakes: biggest,
  }
}

function category(street: string, heroAction: string, h: RecordedHand): string {
  const act = (heroAction.match(/^(fold|check|call|bet|raise|limp|3-bet|4-bet)/i)?.[1] ?? heroAction.split(' ')[0] ?? '').toLowerCase()
  if (street === 'Preflop') {
    const d = (h.details as { preflop?: { verdict: string; label: string }[] } | null)?.preflop?.find(x => x.verdict === 'no')
    return `Preflop · ${d?.label ?? 'decision'} · ${act}`
  }
  return `${street} · ${act}`
}

const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null
const pct = (a: number, b: number) => b ? Math.round(a / b * 100) : 0
const round = (n: number) => Math.round(n * 100) / 100
