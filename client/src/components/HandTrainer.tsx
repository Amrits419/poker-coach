import { useState, useEffect } from 'react'
import type { Setup, StartState, HandHistoryEntry, Analysis } from '../api'
import { villainAct, analyzeHand } from '../api'

const SUITS: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' }
const RED = new Set(['h', 'd'])
const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const
const ALL_POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']

// positions go counterclockwise on screen = clockwise in real poker
// so BTN at bottom, SB to the left, BB next, etc.
const SEAT_COORDS = [
  { left: '50%', top: '85%' },
  { left: '24%', top: '79%' },
  { left: '9%',  top: '52%' },
  { left: '22%', top: '17%' },
  { left: '50%', top: '12%' },
  { left: '78%', top: '17%' },
  { left: '91%', top: '52%' },
  { left: '76%', top: '79%' },
]

function FaceUpCard({ card }: { card: string }) {
  const rank = card.slice(0, -1)
  const suit = card.slice(-1)
  return (
    <div className={`w-11 h-16 rounded-lg bg-white shadow-lg border border-gray-200 flex flex-col items-center justify-center text-lg font-bold leading-none ${RED.has(suit) ? 'text-red-500' : 'text-gray-900'}`}>
      <span>{rank}</span>
      <span className="text-sm">{SUITS[suit] ?? suit}</span>
    </div>
  )
}

function FaceDownCard() {
  return (
    <div className="w-8 h-11 rounded-md shadow border border-blue-500 bg-gradient-to-br from-blue-700 to-blue-900 flex items-center justify-center">
      <div className="w-5 h-7 rounded border border-blue-400/50 bg-blue-800/50" />
    </div>
  )
}

function ChipStack({ amount }: { amount: number }) {
  return (
    <div className="bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-0.5 rounded-full shadow">
      {amount}bb
    </div>
  )
}

function parseCards(str: string): string[] {
  return str.match(/.{2}/g) ?? []
}

function getBoardForStreet(idx: number, b: StartState['board']): string[] {
  if (idx === 0) return []
  if (idx === 1) return b.flop
  if (idx === 2) return [...b.flop, b.turn]
  return [...b.flop, b.turn, b.river]
}

type Phase = 'hero_acts' | 'loading' | 'analyzing'

interface Props {
  userId: string
  setup: Setup
  startState: StartState
  onDone: (analysis: Analysis) => void
}

export default function HandTrainer({ userId, setup, startState, onDone }: Props) {
  const [history, setHistory] = useState<HandHistoryEntry[]>([])
  const [streetIndex, setStreetIndex] = useState(0)
  const [pot, setPot] = useState(startState.pot)
  const [effectiveStack, setEffectiveStack] = useState(startState.effectiveStack)
  const [phase, setPhase] = useState<Phase>('hero_acts')
  const [villainMessage, setVillainMessage] = useState<string | null>(null)
  const [villainBet, setVillainBet] = useState<number | null>(null)
  const [potOdds, setPotOdds] = useState<string | null>(null)
  const [raiseAmount, setRaiseAmount] = useState('')
  const [statusMsg, setStatusMsg] = useState('')

  const currentStreet = STREETS[streetIndex]
  const currentBoard = getBoardForStreet(streetIndex, startState.board)
  const heroCards = parseCards(startState.holeCards)

  const heroIdx = ALL_POSITIONS.indexOf(setup.position)
  const seatedPositions = heroIdx === -1
    ? ALL_POSITIONS
    : [...ALL_POSITIONS.slice(heroIdx), ...ALL_POSITIONS.slice(0, heroIdx)]

  useEffect(() => {
    if (streetIndex === 0) {
      setPhase('hero_acts')
      setVillainMessage(null)
      setVillainBet(null)
      return
    }
    if (startState.heroIsIP) {
      fetchVillainOpener(streetIndex)
    } else {
      setPhase('hero_acts')
      setVillainMessage(null)
      setVillainBet(null)
    }
  }, [streetIndex])

  const fetchVillainOpener = async (idx: number) => {
    const board = getBoardForStreet(idx, startState.board)
    const street = STREETS[idx]
    setPhase('loading')
    setStatusMsg(`Villain acting on ${street}...`)

    const resp = await villainAct(setup, startState, history, street, board, pot, effectiveStack)
    const entry: HandHistoryEntry = { street, actor: 'villain', action: resp.action, amount: resp.amount }
    const newHistory = [...history, entry]
    setHistory(newHistory)
    setVillainMessage(resp.description)
    setVillainBet(resp.amount ?? null)
    setPotOdds(resp.potOdds)
    setPot(resp.newPot)
    setEffectiveStack(resp.newStack)

    if (resp.isHandOver) {
      await runAnalysis(newHistory)
    } else {
      setPhase('hero_acts')
    }
  }

  const runAnalysis = async (finalHistory: HandHistoryEntry[]) => {
    setPhase('analyzing')
    setStatusMsg('Analyzing your decisions...')
    const { analysis } = await analyzeHand(userId, setup, startState, finalHistory)
    onDone(analysis)
  }

  const handleHeroAction = async (action: string, amount?: number) => {
    const heroEntry: HandHistoryEntry = { street: currentStreet, actor: 'hero', action, amount }
    const newHistory = [...history, heroEntry]
    setHistory(newHistory)
    setVillainMessage(null)
    setVillainBet(null)
    setPotOdds(null)
    setRaiseAmount('')

    if (action === 'fold') {
      await runAnalysis(newHistory)
      return
    }

    setPhase('loading')
    setStatusMsg('Villain responding...')

    const resp = await villainAct(
      setup, startState, newHistory, currentStreet, currentBoard, pot, effectiveStack
    )
    const villainEntry: HandHistoryEntry = {
      street: currentStreet, actor: 'villain', action: resp.action, amount: resp.amount
    }
    const historyWithVillain = [...newHistory, villainEntry]
    setHistory(historyWithVillain)
    setPot(resp.newPot)
    setEffectiveStack(resp.newStack)

    if (resp.action === 'raise' || resp.action === 'bet') {
      setVillainMessage(resp.description)
      setVillainBet(resp.amount ?? null)
      setPotOdds(resp.potOdds)
      setPhase('hero_acts')
      return
    }

    if (resp.isHandOver || resp.action === 'fold') {
      await runAnalysis(historyWithVillain)
      return
    }

    const nextIdx = streetIndex + 1
    if (nextIdx >= STREETS.length) {
      await runAnalysis(historyWithVillain)
      return
    }

    setStreetIndex(nextIdx)
  }

  if (phase === 'loading' || phase === 'analyzing') {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-3">
        <div className="text-3xl animate-pulse">♠</div>
        <p className="text-slate-400 text-sm">{statusMsg}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="relative rounded-[80px] bg-green-800 border-[10px] border-amber-900 shadow-2xl h-[480px] overflow-hidden">
        <div className="absolute inset-0 rounded-[70px] opacity-10 bg-[radial-gradient(ellipse_at_center,_#fff_0%,_transparent_70%)]" />

        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-1.5 z-20">
          {STREETS.map((s, i) => (
            <div key={s} className={`w-2 h-2 rounded-full ${
              i < streetIndex ? 'bg-emerald-400' : i === streetIndex ? 'bg-white' : 'bg-white/20'
            }`} />
          ))}
        </div>

        {seatedPositions.map((pos, seatIdx) => {
          const coord = SEAT_COORDS[seatIdx]
          const isHero = seatIdx === 0
          const isVillain = startState.villainPositions.includes(pos)

          return (
            <div
              key={pos}
              className="absolute flex flex-col items-center gap-1 z-10"
              style={{ left: coord.left, top: coord.top, transform: 'translate(-50%, -50%)' }}
            >
              {isHero ? (
                <div className="flex gap-1.5">
                  {heroCards.map((c, i) => <FaceUpCard key={i} card={c} />)}
                </div>
              ) : isVillain ? (
                <div className="flex gap-1">
                  <FaceDownCard /><FaceDownCard />
                </div>
              ) : null}

              <span className={`text-xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                isHero ? 'text-white bg-emerald-700/70' : isVillain ? 'text-yellow-300' : 'text-white/25'
              }`}>
                {isHero ? `You · ${pos}` : pos}
              </span>

              {isHero && (
                <span className="text-white/55 text-xs">{effectiveStack}bb behind</span>
              )}

              {isVillain && villainMessage && (
                <div className="bg-black/50 text-yellow-300 text-xs px-2 py-0.5 rounded-full border border-yellow-500/30 max-w-[120px] text-center leading-tight">
                  {villainMessage}
                </div>
              )}

              {isVillain && villainBet && <ChipStack amount={villainBet} />}
            </div>
          )
        })}

        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-2 z-10">
          <div className="flex gap-2 items-center min-h-[64px]">
            {currentBoard.length > 0
              ? currentBoard.map((c, i) => <FaceUpCard key={i} card={c} />)
              : <span className="text-white/25 text-xs uppercase tracking-widest">Preflop</span>
            }
          </div>
          <div className="bg-black/50 text-white text-sm font-bold px-5 py-1.5 rounded-full border border-white/10">
            Pot: {pot}bb
          </div>
          {potOdds && (
            <span className="text-slate-300 text-xs">Pot odds: {potOdds}</span>
          )}
        </div>
      </div>

      {streetIndex === 0 && (
        <div className="bg-slate-800 rounded-lg px-4 py-3">
          <p className="text-slate-300 text-sm leading-relaxed">{startState.preflopContext}</p>
        </div>
      )}

      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => handleHeroAction('fold')}
            className="py-3 bg-red-900/60 hover:bg-red-800/70 border border-red-700/50 text-red-300 rounded-xl text-sm font-semibold transition-colors"
          >
            Fold
          </button>
          <button
            onClick={() => handleHeroAction('call')}
            className="py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-sm font-semibold transition-colors"
          >
            Call
          </button>
          <button
            onClick={() => handleHeroAction('check')}
            className="py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-sm font-semibold transition-colors"
          >
            Check
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="number"
            value={raiseAmount}
            onChange={e => setRaiseAmount(e.target.value)}
            placeholder="Bet / raise (bb)"
            className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={() => raiseAmount && handleHeroAction('raise', parseFloat(raiseAmount))}
            disabled={!raiseAmount}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl text-sm font-semibold transition-colors"
          >
            Raise
          </button>
        </div>
      </div>
    </div>
  )
}
