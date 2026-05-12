import type { Analysis, StartState } from '../api'

const SUITS: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' }
const RED = new Set(['h', 'd'])

const correctColor: Record<string, string> = {
  yes: 'text-emerald-400',
  close: 'text-yellow-400',
  no: 'text-red-400',
}

const correctLabel: Record<string, string> = {
  yes: '✓ Good',
  close: '~ Close',
  no: '✗ Mistake',
}

function Card({ card }: { card: string }) {
  const rank = card.slice(0, -1)
  const suit = card.slice(-1)
  return (
    <div className={`w-9 rounded-md bg-white border border-gray-200 flex flex-col items-center justify-center text-sm font-bold leading-none px-1 py-1.5 ${RED.has(suit) ? 'text-red-500' : 'text-gray-900'}`}>
      <span>{rank}</span>
      <span className="text-xs">{SUITS[suit] ?? suit}</span>
    </div>
  )
}

function parseCards(str: string): string[] {
  return str.match(/.{2}/g) ?? []
}

interface Props {
  analysis: Analysis
  startState: StartState
  onNext: () => void
  onMenu: () => void
}

export default function AnalysisResult({ analysis, startState, onNext, onMenu }: Props) {
  const heroCards = parseCards(startState.holeCards)
  const board = [...startState.board.flop, startState.board.turn, startState.board.river]
  const scoreColor =
    analysis.score >= 75 ? 'text-emerald-400' :
    analysis.score >= 50 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="space-y-5">
      {/* showdown — reveal all cards */}
      <div className="bg-slate-800/60 rounded-xl p-4 space-y-3">
        <p className="text-slate-400 text-xs uppercase tracking-wide">Showdown</p>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-emerald-400 text-xs font-medium">You</p>
            <div className="flex gap-1">
              {heroCards.map((c, i) => <Card key={i} card={c} />)}
            </div>
          </div>
          <div className="flex gap-1 flex-wrap justify-center">
            {board.map((c, i) => <Card key={i} card={c} />)}
          </div>
          <div className="space-y-1 items-end flex flex-col">
            {startState.villainPositions.map((pos, vi) => (
              <div key={pos}>
                <p className="text-yellow-400 text-xs font-medium text-right">{pos}</p>
                <div className="flex gap-1">
                  {parseCards(startState.villainHoleCards[vi] ?? '').map((c, i) => <Card key={i} card={c} />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* score header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-slate-400 text-sm">Score</p>
          <p className={`text-4xl font-bold ${scoreColor}`}>
            {analysis.score}<span className="text-lg text-slate-400">/100</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onMenu}
            className="text-sm text-slate-400 hover:text-white border border-slate-700 px-3 py-1.5 rounded-lg"
          >
            Menu
          </button>
          <button
            onClick={onNext}
            className="text-sm bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg"
          >
            Next hand →
          </button>
        </div>
      </div>

      {/* summary */}
      <div className="bg-slate-800 rounded-lg p-4">
        <p className="text-slate-200 text-sm leading-relaxed">{analysis.summary}</p>
      </div>

      {/* street by street */}
      <div>
        <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">Street Breakdown</p>
        <div className="space-y-2">
          {analysis.streetFeedback.map((s, i) => (
            <div key={i} className="bg-slate-800 rounded-lg p-3 space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-white text-sm font-medium">{s.street}</span>
                <span className={`text-xs font-medium ${correctColor[s.correct] ?? 'text-slate-400'}`}>
                  {correctLabel[s.correct] ?? s.correct}
                </span>
              </div>
              <p className="text-slate-400 text-xs">You: {s.heroAction}</p>
              <p className="text-slate-300 text-xs leading-relaxed">{s.explanation}</p>
              {s.correct !== 'yes' && (
                <p className="text-emerald-400 text-xs leading-relaxed">Better: {s.betterPlay}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* leaks */}
      {analysis.leaks.length > 0 && (
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">Leaks Spotted</p>
          <div className="flex flex-wrap gap-2">
            {analysis.leaks.map((leak, i) => (
              <span
                key={i}
                className="bg-red-900/40 border border-red-700/50 text-red-300 text-xs px-2.5 py-1 rounded-full"
              >
                {leak}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* study plan */}
      <div className="bg-slate-800 rounded-lg p-4">
        <p className="text-emerald-400 text-xs uppercase tracking-wide mb-2">Study Plan</p>
        <ul className="space-y-1">
          {analysis.studyPlan.map((item, i) => (
            <li key={i} className="text-slate-200 text-sm flex gap-2">
              <span className="text-slate-500 shrink-0">{i + 1}.</span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
