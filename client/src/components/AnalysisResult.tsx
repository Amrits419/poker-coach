import type { Analysis, StartState } from '../api'
import type { VillainDesc } from './HandTrainer'

const SUITS: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' }
const RED = new Set(['h', 'd'])

function Card({ card }: { card: string }) {
  const rank = card.slice(0, -1)
  const suit = card.slice(-1)
  const isRed = RED.has(suit)
  return (
    <div className={`relative bg-white rounded-md shadow-md select-none`}
      style={{ width: 34, height: 48, border: '1px solid rgba(0,0,0,0.1)', flexShrink: 0 }}>
      <div className={`absolute top-0.5 left-1 font-black leading-none text-[9px] ${isRed ? 'text-red-500' : 'text-gray-900'}`}>
        <div>{rank}</div>
        <div>{SUITS[suit] ?? suit}</div>
      </div>
      <div className={`absolute inset-0 flex items-center justify-center font-bold text-base ${isRed ? 'text-red-500' : 'text-gray-900'}`}>
        {SUITS[suit] ?? suit}
      </div>
    </div>
  )
}

function FaceDownSmall() {
  return (
    <div className="rounded-md shadow" style={{
      width: 28, height: 40,
      background: 'linear-gradient(150deg, #991b1b 0%, #7f1d1d 100%)',
      border: '1px solid #dc2626',
    }}>
      <div style={{ margin: 2, height: 'calc(100% - 4px)', borderRadius: 2, border: '1px solid rgba(252,165,165,0.2)' }} />
    </div>
  )
}

function parseCards(str: string): string[] {
  return str.match(/.{2}/g) ?? []
}

const CORRECT_COLOR: Record<string, string> = {
  yes: 'text-emerald-400',
  close: 'text-yellow-400',
  no: 'text-red-400',
}
const CORRECT_LABEL: Record<string, string> = {
  yes: 'Correct',
  close: 'Close',
  no: 'Mistake',
}
const STREET_BORDER: Record<string, string> = {
  yes: 'border-emerald-600/60',
  close: 'border-yellow-500/60',
  no: 'border-red-600/60',
}

interface Props {
  analysis: Analysis
  startState: StartState
  villainDescriptions: VillainDesc[]
  onNext: () => void
  onMenu: () => void
}

export default function AnalysisResult({ analysis, startState, villainDescriptions, onNext, onMenu }: Props) {
  const heroCards = parseCards(startState.holeCards)
  const board = [...startState.board.flop, startState.board.turn, startState.board.river].filter(Boolean)

  const scoreColor =
    analysis.score >= 75 ? '#10b981' :
    analysis.score >= 50 ? '#f59e0b' : '#ef4444'

  const circumference = 2 * Math.PI * 30
  const dash = (analysis.score / 100) * circumference

  return (
    <div className="space-y-5 pb-4">
      {/* ── Header: Score + Cards ───────────────────────────────────── */}
      <div className="bg-slate-800/50 border border-slate-700/40 rounded-2xl p-4">
        <div className="flex items-center justify-between">
          {/* Score ring */}
          <div className="flex items-center gap-4">
            <div className="relative w-20 h-20">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="30" fill="none" stroke="#1e293b" strokeWidth="7" />
                <circle cx="40" cy="40" r="30" fill="none" stroke={scoreColor} strokeWidth="7"
                  strokeDasharray={`${dash} ${circumference}`} strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-black text-white leading-none">{analysis.score}</span>
                <span className="text-[9px] text-slate-500 font-medium">/100</span>
              </div>
            </div>
            {/* Hero cards */}
            <div className="space-y-1">
              <p className="text-slate-500 text-xs font-medium uppercase tracking-wide">Your hand</p>
              <div className="flex gap-1.5">
                {heroCards.map((c, i) => <Card key={i} card={c} />)}
              </div>
            </div>
          </div>

          {/* Villain hands */}
          <div className="flex flex-col items-end gap-2">
            {startState.villainPositions.map((pos, vi) => (
              <div key={pos} className="flex items-center gap-2">
                <span className="text-yellow-400/70 text-xs font-medium">{pos}</span>
                <div className="flex gap-1">
                  {parseCards(startState.villainHoleCards[vi] ?? '').map((c, i) => <Card key={i} card={c} />)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Board */}
        {board.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-700/40">
            <p className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-2">Board</p>
            <div className="flex gap-1.5">
              {board.map((c, i) => <Card key={i} card={c} />)}
            </div>
          </div>
        )}
      </div>

      {/* ── Coach Verdict ───────────────────────────────────────────── */}
      <div className="bg-slate-800/50 border border-slate-700/40 rounded-2xl p-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Coach Verdict</p>
        <p className="text-slate-200 text-sm leading-relaxed">{analysis.summary}</p>
      </div>

      {/* ── Street Breakdown ────────────────────────────────────────── */}
      <div className="space-y-2.5">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Street Breakdown</p>
        {analysis.streetFeedback.map((s, i) => (
          <div key={i} className={`bg-slate-800/50 rounded-2xl p-4 border-l-4 ${STREET_BORDER[s.correct] ?? 'border-slate-600'}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-white font-bold text-sm">{s.street}</span>
                <span className="text-slate-500 text-xs">·</span>
                <span className="text-slate-400 text-xs">{s.heroAction}</span>
              </div>
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                s.correct === 'yes'   ? 'bg-emerald-900/50 text-emerald-400' :
                s.correct === 'close' ? 'bg-yellow-900/50 text-yellow-400' :
                                        'bg-red-900/50 text-red-400'
              }`}>
                {CORRECT_LABEL[s.correct] ?? s.correct}
              </span>
            </div>
            <p className="text-slate-300 text-sm leading-relaxed">{s.explanation}</p>
            {s.correct !== 'yes' && s.betterPlay && (
              <div className="mt-3 bg-emerald-950/50 border border-emerald-700/30 rounded-xl px-3.5 py-2.5">
                <p className="text-emerald-400 text-[10px] font-bold uppercase tracking-wider mb-1">Better play</p>
                <p className="text-emerald-200 text-sm leading-relaxed">{s.betterPlay}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Villain Actions ─────────────────────────────────────────── */}
      {villainDescriptions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Villain Actions</p>
          {villainDescriptions.map((v, i) => (
            <div key={i} className="bg-slate-800/40 border border-slate-700/30 rounded-xl px-3.5 py-2.5 flex gap-3 items-start">
              <span className="text-yellow-400/70 text-xs font-bold shrink-0 pt-0.5 min-w-[40px]">{v.street}</span>
              <p className="text-slate-400 text-xs leading-relaxed">{v.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Leaks ───────────────────────────────────────────────────── */}
      {analysis.leaks.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2.5">Leaks Spotted</p>
          <div className="flex flex-wrap gap-2">
            {analysis.leaks.map((leak, i) => (
              <span key={i} className="bg-red-950/50 border border-red-800/40 text-red-300 text-xs px-3 py-1.5 rounded-full font-medium">
                {leak}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Study Plan ──────────────────────────────────────────────── */}
      <div className="bg-slate-800/50 border border-emerald-800/20 rounded-2xl p-4">
        <p className="text-xs font-semibold text-emerald-500 uppercase tracking-wider mb-3">What to Drill Next</p>
        <div className="space-y-3">
          {analysis.studyPlan.map((item, i) => (
            <div key={i} className="flex gap-3 items-start">
              <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-900/60 border border-emerald-700/40 text-emerald-400 text-xs font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <p className="text-slate-300 text-sm leading-relaxed">{item}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── CTA Buttons ─────────────────────────────────────────────── */}
      <div className="flex gap-3 pt-1">
        <button onClick={onMenu}
          className="flex-1 py-3.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-xl text-sm font-semibold transition-colors">
          Menu
        </button>
        <button onClick={onNext}
          className="flex-1 py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-bold transition-colors shadow-lg shadow-emerald-900/30">
          Next Hand →
        </button>
      </div>
    </div>
  )
}
