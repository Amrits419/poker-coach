import { Analysis } from '../api'

// maps assessment string to a color class
const assessmentColor: Record<string, string> = {
  good: 'text-emerald-400',
  questionable: 'text-yellow-400',
  mistake: 'text-red-400',
}

interface Props {
  analysis: Analysis
  onReset: () => void
}

export default function AnalysisResult({ analysis, onReset }: Props) {
  const scoreColor =
    analysis.score >= 75
      ? 'text-emerald-400'
      : analysis.score >= 50
      ? 'text-yellow-400'
      : 'text-red-400'

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-slate-400 text-sm">Decision Score</p>
          <p className={`text-4xl font-bold ${scoreColor}`}>
            {analysis.score}
            <span className="text-lg text-slate-400">/100</span>
          </p>
        </div>
        <button
          onClick={onReset}
          className="text-sm text-slate-400 hover:text-white border border-slate-700 px-3 py-1.5 rounded-lg"
        >
          Analyze another hand
        </button>
      </div>

      <div className="bg-slate-800 rounded-lg p-4">
        <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">Summary</p>
        <p className="text-slate-200 text-sm leading-relaxed">{analysis.summary}</p>
      </div>

      <div>
        <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">Street Breakdown</p>
        <div className="space-y-2">
          {analysis.streetBreakdown.map((s, i) => (
            <div key={i} className="bg-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-1">
                <span className="text-white text-sm font-medium">{s.street}</span>
                <span className={`text-xs font-medium capitalize ${assessmentColor[s.assessment] ?? 'text-slate-400'}`}>
                  {s.assessment}
                </span>
              </div>
              <p className="text-slate-300 text-xs">{s.decision}</p>
              <p className="text-slate-500 text-xs mt-1">{s.evImpact}</p>
            </div>
          ))}
        </div>
      </div>

      {analysis.leaks.length > 0 && (
        <div>
          <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">Leaks Detected</p>
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

      <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-lg p-4">
        <p className="text-emerald-400 text-xs uppercase tracking-wide mb-1">Recommendation</p>
        <p className="text-slate-200 text-sm leading-relaxed">{analysis.recommendation}</p>
      </div>
    </div>
  )
}
