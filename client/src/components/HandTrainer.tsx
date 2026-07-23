import { useState, useEffect, useRef } from 'react'
import type { Setup, StartState, HandHistoryEntry, Analysis, VillainResponse } from '../api'
import { villainAct, analyzeHand } from '../api'

const SUITS: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' }
const RED = new Set(['h', 'd'])
const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const
const ALL_POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN']
const PREFLOP_ORDER = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']

const SEAT_COORDS = [
  { left: '50%', top: '88%' },
  { left: '22%', top: '77%' },
  { left: '7%',  top: '50%' },
  { left: '20%', top: '19%' },
  { left: '50%', top: '8%'  },
  { left: '80%', top: '19%' },
  { left: '93%', top: '50%' },
  { left: '78%', top: '77%' },
]

// ── Card components ───────────────────────────────────────────────────────────

function FaceUpCard({ card, lg = false }: { card: string; lg?: boolean }) {
  const rank = card.slice(0, -1)
  const suit = card.slice(-1)
  const isRed = RED.has(suit)
  const sym = SUITS[suit] ?? suit
  const w = lg ? 48 : 40
  const h = lg ? 68 : 56

  return (
    <div
      className="relative bg-white rounded-lg shadow-xl select-none"
      style={{ width: w, height: h, border: '1px solid rgba(0,0,0,0.12)', flexShrink: 0 }}
    >
      <div className={`absolute top-0.5 left-1 font-black leading-none ${isRed ? 'text-red-500' : 'text-gray-900'}`}
        style={{ fontSize: lg ? 11 : 9 }}>
        <div>{rank}</div>
        <div>{sym}</div>
      </div>
      <div className={`absolute inset-0 flex items-center justify-center font-bold ${isRed ? 'text-red-500' : 'text-gray-900'}`}
        style={{ fontSize: lg ? 22 : 17 }}>
        {sym}
      </div>
      <div className={`absolute bottom-0.5 right-1 font-black leading-none rotate-180 ${isRed ? 'text-red-500' : 'text-gray-900'}`}
        style={{ fontSize: lg ? 11 : 9 }}>
        <div>{rank}</div>
        <div>{sym}</div>
      </div>
    </div>
  )
}

function FaceDownCard({ folded = false }: { folded?: boolean }) {
  if (folded) {
    return (
      <div className="rounded-md" style={{
        width: 30, height: 42,
        background: '#374151', opacity: 0.28,
        border: '1px solid #4b5563', flexShrink: 0,
      }} />
    )
  }
  return (
    <div className="rounded-md shadow-md" style={{
      width: 30, height: 42,
      background: 'linear-gradient(150deg, #991b1b 0%, #7f1d1d 100%)',
      border: '1px solid #dc2626', flexShrink: 0,
    }}>
      <div style={{
        margin: 3, height: 'calc(100% - 6px)', borderRadius: 3,
        border: '1px solid rgba(252,165,165,0.2)',
        background: 'repeating-linear-gradient(-45deg, transparent, transparent 2px, rgba(0,0,0,0.12) 2px, rgba(0,0,0,0.12) 3px)',
      }} />
    </div>
  )
}

// 3-D card flip: starts face-down (rotateY 180°), flips to face-up (0°)
function FlippableCard({ card, revealed, lg = false }: { card: string; revealed: boolean; lg?: boolean }) {
  const w = lg ? 48 : 40
  const h = lg ? 68 : 56
  return (
    <div style={{ perspective: 500, width: w, height: h, flexShrink: 0 }}>
      <div style={{
        width: '100%', height: '100%',
        position: 'relative',
        transformStyle: 'preserve-3d',
        transition: 'transform 0.5s cubic-bezier(0.4,0,0.2,1)',
        transform: revealed ? 'rotateY(0deg)' : 'rotateY(180deg)',
      }}>
        {/* Front — face up */}
        <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden' }}>
          <FaceUpCard card={card} lg={lg} />
        </div>
        {/* Back — face down */}
        <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
          <FaceDownCard />
        </div>
      </div>
    </div>
  )
}

function EmptyCardSlot() {
  return (
    <div className="rounded-lg" style={{
      width: 40, height: 56,
      border: '1.5px dashed rgba(255,255,255,0.1)',
      flexShrink: 0,
    }} />
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

type DealPhase = 'dealing' | 'done' | 'ready'
type GamePhase = 'hero_acts' | 'loading' | 'analyzing'

export interface VillainDesc { street: string; description: string }

interface Props {
  userId: string
  setup: Setup
  startState: StartState
  onDone: (analysis: Analysis, villainDescriptions: VillainDesc[]) => void
}

// ── Sequential villain runner (unchanged logic) ───────────────────────────────

async function runVillainsSequential(
  setup: Setup,
  startState: StartState,
  initHistory: HandHistoryEntry[],
  initDescs: VillainDesc[],
  street: string,
  board: string[],
  initPot: number,
  initStack: number,
  foldedVillains: Set<number>,
  indicesToRun: number[]
): Promise<{
  history: HandHistoryEntry[]
  descs: VillainDesc[]
  pot: number
  stack: number
  foldedVillains: Set<number>
  handOver: boolean
  raisedResp: VillainResponse | null
}> {
  let hist = initHistory
  let descs = initDescs
  let pot = initPot
  let stack = initStack
  const folded = new Set(foldedVillains)

  for (const vi of indicesToRun) {
    if (folded.has(vi)) continue
    const resp = await villainAct(setup, startState, hist, street, board, pot, stack, vi)
    hist = [...hist, { street, actor: 'villain', action: resp.action, amount: resp.amount }]
    descs = [...descs, { street, description: resp.description }]
    pot = resp.newPot
    stack = resp.newStack

    if (resp.action === 'fold' || resp.isHandOver) {
      folded.add(vi)
      if (folded.size >= startState.villainPositions.length)
        return { history: hist, descs, pot, stack, foldedVillains: folded, handOver: true, raisedResp: null }
    } else if (resp.action === 'bet' || resp.action === 'raise') {
      return { history: hist, descs, pot, stack, foldedVillains: folded, handOver: false, raisedResp: resp }
    }
  }
  return { history: hist, descs, pot, stack, foldedVillains: folded, handOver: false, raisedResp: null }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HandTrainer({ userId, setup, startState, onDone }: Props) {
  // ── Seating layout (stable, never changes during a hand) ──────────────────
  const heroIdx = ALL_POSITIONS.indexOf(setup.position)
  const seatedPositions = heroIdx === -1
    ? ALL_POSITIONS
    : [...ALL_POSITIONS.slice(heroIdx), ...ALL_POSITIONS.slice(0, heroIdx)]

  // ── Deal animation state ──────────────────────────────────────────────────
  // dealt[seatIdx][cardIdx]: one slot per seat (8 seats, 2 cards each)
  const [dealt, setDealt] = useState<boolean[][]>(() => Array.from({ length: 8 }, () => [false, false]))
  const [mucked, setMucked] = useState<Set<number>>(new Set())
  const [heroRevealed, setHeroRevealed] = useState(false)
  const [dealPhase, setDealPhase] = useState<DealPhase>('dealing')

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const analysisRetryRef = useRef<{ history: HandHistoryEntry[]; descs: VillainDesc[] } | null>(null)

  useEffect(() => {
    const push = (fn: () => void, delay: number) => {
      timersRef.current.push(setTimeout(fn, delay))
    }

    const INTERVAL = 105  // ms between each card dealt

    // Phase 1: deal to all 8 seats, card 0 round then card 1 round
    for (let round = 0; round < 2; round++) {
      for (let seat = 0; seat < 8; seat++) {
        const delay = 60 + (round * 8 + seat) * INTERVAL
        const r = round, s = seat
        push(() => {
          setDealt(prev => {
            const next = prev.map(row => [...row])
            next[s][r] = true
            return next
          })
        }, delay)
      }
    }

    // Phase 2: flip hero cards, then muck positions that already folded BEFORE hero
    // in preflop order (e.g. UTG→CO for a BTN open). After those clear, set 'ready'.
    const flipDelay = 60 + 15 * INTERVAL + 320
    push(() => {
      setHeroRevealed(true)
      push(() => {
        setDealPhase('done')

        const heroPfIdx = PREFLOP_ORDER.indexOf(setup.position)
        const beforeHero: number[] = []
        for (let i = 1; i < 8; i++) {
          const pos = seatedPositions[i]
          if (startState.villainPositions.includes(pos)) continue
          const pfIdx = PREFLOP_ORDER.indexOf(pos)
          if (pfIdx !== -1 && pfIdx < heroPfIdx) beforeHero.push(i)
        }
        // Sort by preflop order so they fold in the right sequence
        beforeHero.sort((a, b) =>
          PREFLOP_ORDER.indexOf(seatedPositions[a]) - PREFLOP_ORDER.indexOf(seatedPositions[b])
        )
        beforeHero.forEach((seat, j) => {
          push(() => setMucked(prev => new Set([...prev, seat])), j * 200)
        })
        // Once all before-hero positions have folded, hero can act
        const readyDelay = beforeHero.length > 0 ? (beforeHero.length - 1) * 200 + 450 : 0
        push(() => setDealPhase('ready'), readyDelay)
      }, 520)
    }, flipDelay)

    return () => {
      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    }
  }, [])

  // ── Game state ────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<HandHistoryEntry[]>([])
  const [streetIndex, setStreetIndex] = useState(0)
  const [pot, setPot] = useState(startState.pot)
  const [effectiveStack, setEffectiveStack] = useState(startState.effectiveStack)
  const [gamePhase, setGamePhase] = useState<GamePhase>('hero_acts')
  const [villainBet, setVillainBet] = useState<number | null>(null)
  const [potOdds, setPotOdds] = useState<string | null>(null)
  const [betAmount, setBetAmount] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const [villainDescriptions, setVillainDescriptions] = useState<VillainDesc[]>([])
  const [foldedVillains, setFoldedVillains] = useState<Set<number>>(new Set())

  const currentStreet = STREETS[streetIndex]
  const currentBoard = getBoardForStreet(streetIndex, startState.board)
  const heroCards = parseCards(startState.holeCards)

  const heroPostflopIdx = POSTFLOP_ORDER.indexOf(setup.position)
  const oopVillainIndices = startState.villainPositions
    .map((pos, i) => ({ i, orderIdx: POSTFLOP_ORDER.indexOf(pos) }))
    .filter(({ orderIdx }) => orderIdx !== -1 && orderIdx < heroPostflopIdx)
    .sort((a, b) => a.orderIdx - b.orderIdx).map(({ i }) => i)
  const ipVillainIndices = startState.villainPositions
    .map((pos, i) => ({ i, orderIdx: POSTFLOP_ORDER.indexOf(pos) }))
    .filter(({ orderIdx }) => orderIdx !== -1 && orderIdx > heroPostflopIdx)
    .sort((a, b) => a.orderIdx - b.orderIdx).map(({ i }) => i)
  const heroPreflopIdx = PREFLOP_ORDER.indexOf(setup.position)
  const preflopVillainIndices = startState.villainPositions
    .map((pos, i) => ({ i, preflopIdx: PREFLOP_ORDER.indexOf(pos) }))
    .sort((a, b) => ((a.preflopIdx - heroPreflopIdx + 8) % 8) - ((b.preflopIdx - heroPreflopIdx + 8) % 8))
    .map(({ i }) => i)

  const facingBet = villainBet !== null
  const isWaiting = gamePhase === 'loading' || gamePhase === 'analyzing'

  useEffect(() => {
    if (streetIndex === 0) {
      setGamePhase('hero_acts')
      // If villain opened preflop, hero faces their raise immediately
      setVillainBet(!startState.heroIsPFR ? (startState.preflopRaiseAmount ?? null) : null)
      setPotOdds(null)
      return
    }
    if (oopVillainIndices.length > 0) fetchVillainOpener(streetIndex)
    else { setGamePhase('hero_acts'); setVillainBet(null) }
  }, [streetIndex])

  const fetchVillainOpener = async (idx: number) => {
    const board = getBoardForStreet(idx, startState.board)
    const street = STREETS[idx]
    setGamePhase('loading'); setStatusMsg(`Villain acting on ${street}...`)
    const result = await runVillainsSequential(setup, startState, history, villainDescriptions, street, board, pot, effectiveStack, foldedVillains, oopVillainIndices)
    setHistory(result.history); setVillainDescriptions(result.descs)
    setPot(result.pot); setEffectiveStack(result.stack); setFoldedVillains(result.foldedVillains)
    if (result.handOver) { await runAnalysis(result.history, result.descs); return }
    if (result.raisedResp) { setVillainBet(result.raisedResp.amount ?? null); setPotOdds(result.raisedResp.potOdds) }
    else { setVillainBet(null); setPotOdds(null) }
    setGamePhase('hero_acts')
  }

  const runAnalysis = async (finalHistory: HandHistoryEntry[], descs: VillainDesc[]) => {
    setGamePhase('analyzing'); setStatusMsg('Analyzing your decisions...')
    try {
      const { analysis } = await analyzeHand(userId, setup, startState, finalHistory)
      onDone(analysis, descs)
    } catch (err) {
      console.error('Analysis error:', err)
      setGamePhase('hero_acts')
      analysisRetryRef.current = { history: finalHistory, descs }
    }
  }

  // When hero acts preflop, muck empty seats that come AFTER hero in preflop order
  // (e.g. SB for BTN hero vs BB). They fold to hero's open in sequence.
  const muckAfterHero = () => {
    const heroPfIdx = PREFLOP_ORDER.indexOf(setup.position)
    const afterHero: number[] = []
    for (let i = 1; i < 8; i++) {
      const pos = seatedPositions[i]
      if (startState.villainPositions.includes(pos)) continue
      const pfIdx = PREFLOP_ORDER.indexOf(pos)
      if (pfIdx !== -1 && pfIdx > heroPfIdx) afterHero.push(i)
    }
    afterHero.sort((a, b) =>
      PREFLOP_ORDER.indexOf(seatedPositions[a]) - PREFLOP_ORDER.indexOf(seatedPositions[b])
    )
    afterHero.forEach((seat, j) => {
      setTimeout(() => setMucked(prev => new Set([...prev, seat])), j * 200)
    })
  }

  const handleHeroAction = async (action: string, amount?: number) => {
    if (currentStreet === 'Preflop') muckAfterHero()

    const heroEntry: HandHistoryEntry = { street: currentStreet, actor: 'hero', action, amount }
    const newHistory = [...history, heroEntry]
    setHistory(newHistory); setVillainBet(null); setPotOdds(null); setBetAmount('')
    if (action === 'fold') { await runAnalysis(newHistory, villainDescriptions); return }

    setGamePhase('loading'); setStatusMsg('Villain responding...')

    // Hero called villain's preflop open → secondary villains (index 1+) still need to act
    if (currentStreet === 'Preflop' && !startState.heroIsPFR && action === 'call') {
      const callAmt = startState.preflopRaiseAmount ?? 0
      const postedBlind = setup.position === 'BB' ? 1.0 : setup.position === 'SB' ? 0.5 : 0
      const newPot = Math.round((pot + callAmt) * 10) / 10
      const newStack = Math.max(0, Math.round((effectiveStack - Math.max(0, callAmt - postedBlind)) * 10) / 10)
      setPot(newPot)
      setEffectiveStack(newStack)

      // In multiway, villain indices 1+ haven't acted yet on the opener's raise
      const coldCallers = startState.villainPositions.slice(1).map((_, i) => i + 1)
      if (coldCallers.length > 0) {
        const result = await runVillainsSequential(
          setup, startState, newHistory, villainDescriptions,
          'Preflop', [], newPot, newStack, foldedVillains, coldCallers
        )
        setHistory(result.history); setVillainDescriptions(result.descs)
        setPot(result.pot); setEffectiveStack(result.stack); setFoldedVillains(result.foldedVillains)
        if (result.handOver) { await runAnalysis(result.history, result.descs); return }
      }

      setStreetIndex(1)
      setGamePhase('hero_acts')
      return
    }

    let villainsToRun: number[]
    if (currentStreet === 'Preflop') {
      villainsToRun = preflopVillainIndices
    } else if (action === 'call') {
      // Hero called a villain bet — street is over in heads-up.
      // Add hero's call to pot directly, then advance.
      const callAmt = amount ?? 0
      setPot(p => Math.round((p + callAmt) * 10) / 10)
      setEffectiveStack(s => Math.max(0, Math.round((s - callAmt) * 10) / 10))
      const nextIdx = streetIndex + 1
      if (nextIdx >= STREETS.length) { await runAnalysis(newHistory, villainDescriptions); return }
      setStreetIndex(nextIdx)
      return
    } else if (action === 'check') {
      // Hero checked — only IP villains still need to act
      villainsToRun = ipVillainIndices
    } else {
      // Hero bet/raised — ALL villains respond (OOP who checked now faces a bet)
      villainsToRun = [...oopVillainIndices, ...ipVillainIndices]
    }

    const result = await runVillainsSequential(setup, startState, newHistory, villainDescriptions, currentStreet, currentBoard, pot, effectiveStack, foldedVillains, villainsToRun)
    setHistory(result.history); setVillainDescriptions(result.descs)
    setPot(result.pot); setEffectiveStack(result.stack); setFoldedVillains(result.foldedVillains)
    if (result.handOver) { await runAnalysis(result.history, result.descs); return }
    if (result.raisedResp) { setVillainBet(result.raisedResp.amount ?? null); setPotOdds(result.raisedResp.potOdds); setGamePhase('hero_acts'); return }
    const nextIdx = streetIndex + 1
    if (nextIdx >= STREETS.length) { await runAnalysis(result.history, result.descs); return }
    setStreetIndex(nextIdx)
  }

  // Bet size presets
  const r = (n: number) => Math.round(n * 10) / 10
  const betPresets = currentStreet === 'Preflop'
    ? [{ label: '2bb', amt: 2 }, { label: '2.5bb', amt: 2.5 }, { label: '3bb', amt: 3 }]
    : [{ label: '33%', amt: r(pot * 0.33) }, { label: '50%', amt: r(pot * 0.5) }, { label: '75%', amt: r(pot * 0.75) }, { label: 'Pot', amt: pot }]
  const raisePresets = villainBet
    ? [{ label: '2×', amt: r(villainBet * 2) }, { label: '2.5×', amt: r(villainBet * 2.5) }, { label: '3×', amt: r(villainBet * 3) }]
    : []

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      {/* ── Poker Table ────────────────────────────────────────────────────── */}
      <div className="relative" style={{
        height: 440,
        borderRadius: '50%',
        background: 'radial-gradient(ellipse at 50% 35%, #1c6b3a 0%, #124a28 55%, #0b3019 100%)',
        border: '14px solid #6b3c1a',
        boxShadow: 'inset 0 4px 40px rgba(0,0,0,0.5), inset 0 -4px 20px rgba(0,0,0,0.3), 0 0 0 3px #3d200a, 0 24px 60px rgba(0,0,0,0.8)',
        overflow: 'hidden',
      }}>
        {/* Inner felt line */}
        <div className="absolute inset-0 pointer-events-none" style={{
          borderRadius: '50%', border: '2px solid rgba(255,255,255,0.04)', margin: 10,
        }} />

        {/* Street dots */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-2 z-20">
          {STREETS.map((s, i) => (
            <div key={s} className={`rounded-full transition-all ${
              i < streetIndex ? 'w-2 h-2 bg-emerald-400' :
              i === streetIndex ? 'w-2.5 h-2.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]' :
              'w-2 h-2 bg-white/15'
            }`} />
          ))}
        </div>

        {/* Board */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-3 z-10">
          <div className="flex gap-2 items-center">
            {currentBoard.length === 0 ? (
              <span className="text-white/20 text-xs font-semibold uppercase tracking-[0.2em]">Preflop</span>
            ) : (
              <>
                {currentBoard.map((c, i) => <FaceUpCard key={i} card={c} lg />)}
                {Array.from({ length: 5 - currentBoard.length }).map((_, i) => <EmptyCardSlot key={i} />)}
              </>
            )}
          </div>
          <div className="bg-black/50 backdrop-blur-sm text-white text-sm font-bold px-5 py-1.5 rounded-full border border-white/10">
            Pot: {pot}bb
          </div>
          {potOdds && (
            <span className="text-slate-300 text-xs bg-black/40 px-3 py-1 rounded-full">
              Pot odds {potOdds}
            </span>
          )}
        </div>

        {/* Loading / error overlay */}
        {isWaiting && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-end pb-8">
            <div className="flex items-center gap-2 bg-black/60 backdrop-blur-sm px-4 py-2 rounded-full border border-white/10">
              <span className="text-base animate-spin">♠</span>
              <span className="text-white/80 text-xs font-medium">{statusMsg}</span>
            </div>
          </div>
        )}
        {gamePhase === 'hero_acts' && analysisRetryRef.current && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-end pb-8">
            <button
              onClick={() => {
                const retry = analysisRetryRef.current
                if (!retry) return
                analysisRetryRef.current = null
                runAnalysis(retry.history, retry.descs)
              }}
              className="flex items-center gap-2 bg-red-900/80 backdrop-blur-sm px-5 py-2.5 rounded-full border border-red-700/50 text-red-200 text-xs font-semibold hover:bg-red-800/80 transition-colors"
            >
              Analysis failed — tap to retry
            </button>
          </div>
        )}

        {/* Seats */}
        {seatedPositions.map((pos, seatIdx) => {
          const isHero = seatIdx === 0
          const isVillain = startState.villainPositions.includes(pos)
          const villainIdx = startState.villainPositions.indexOf(pos)
          const isFolded = villainIdx !== -1 && foldedVillains.has(villainIdx)
          const isActive = isHero || isVillain
          const isMucked = mucked.has(seatIdx)
          const cardOneDealt = dealt[seatIdx][0]

          // Always render dealt cards — muckCards animation (forwards) keeps them at opacity:0 after playing
          const showCards = cardOneDealt

          return (
            <div
              key={pos}
              className="absolute flex flex-col items-center gap-1.5 z-10"
              style={{ left: SEAT_COORDS[seatIdx].left, top: SEAT_COORDS[seatIdx].top, transform: 'translate(-50%, -50%)' }}
            >
              {showCards && (
                <div
                  className="flex gap-1"
                  style={isMucked ? { animation: 'muckCards 0.38s ease-in forwards' } : {}}
                >
                  {[0, 1].map(ci => (
                    <div
                      key={ci}
                      style={dealt[seatIdx][ci]
                        ? { animation: 'dealCard 0.22s ease-out both' }
                        : { opacity: 0 }
                      }
                    >
                      {isHero ? (
                        // Hero cards flip face-up after mucking is done
                        <FlippableCard card={heroCards[ci]} revealed={heroRevealed} />
                      ) : (
                        <FaceDownCard folded={isActive && isFolded} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className={`px-2 py-0.5 rounded-md text-[11px] font-bold tracking-wide transition-opacity ${
                isHero ? 'bg-emerald-600/80 text-white border border-emerald-400/30'
                : isFolded ? 'text-white/20'
                : isVillain ? 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/20'
                : dealPhase === 'done' ? 'text-white/12'
                : 'text-white/25'
              }`}>
                {isHero ? `YOU · ${pos}` : pos}
              </div>

              {isHero && <span className="text-white/40 text-[10px]">{effectiveStack}bb</span>}

              {isVillain && !isFolded && villainBet && (
                <div className="bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-0.5 rounded-full shadow-lg">
                  {villainBet}bb
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Preflop context */}
      {streetIndex === 0 && !isWaiting && dealPhase === 'ready' && (
        <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl px-4 py-3">
          <p className="text-slate-300 text-sm leading-relaxed">{startState.preflopContext}</p>
        </div>
      )}

      {/* ── Action Panel ──────────────────────────────────────────────────── */}
      {!isWaiting && dealPhase === 'ready' && (
        <div className="space-y-2.5">
          {facingBet ? (
            <>
              <div className="flex gap-2">
                {raisePresets.map(({ label, amt }) => (
                  <button key={label} onClick={() => setBetAmount(String(amt))}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-all ${
                      betAmount === String(amt) ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => handleHeroAction('fold')}
                  className="py-3.5 bg-red-950/70 hover:bg-red-900/70 border border-red-800/50 text-red-300 rounded-xl text-sm font-bold transition-colors">
                  Fold
                </button>
                <button onClick={() => handleHeroAction('call', villainBet ?? undefined)}
                  className="py-3.5 bg-slate-700/80 hover:bg-slate-600 border border-slate-600 text-white rounded-xl text-sm font-bold transition-colors">
                  Call {villainBet}bb
                </button>
                <button onClick={() => betAmount && handleHeroAction('raise', parseFloat(betAmount))}
                  disabled={!betAmount}
                  className="py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl text-sm font-bold transition-colors border border-emerald-500/30">
                  Raise
                </button>
              </div>
              <input type="number" value={betAmount} onChange={e => setBetAmount(e.target.value)}
                placeholder="Raise to (bb)"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20" />
            </>
          ) : (
            <>
              <div className="flex gap-2">
                {betPresets.map(({ label, amt }) => (
                  <button key={label} onClick={() => setBetAmount(String(amt))}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-all ${
                      betAmount === String(amt) ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => handleHeroAction('fold')}
                  className="py-3.5 bg-red-950/70 hover:bg-red-900/70 border border-red-800/50 text-red-300 rounded-xl text-sm font-bold transition-colors">
                  Fold
                </button>
                <button onClick={() => handleHeroAction('check')}
                  className="py-3.5 bg-slate-700/80 hover:bg-slate-600 border border-slate-600 text-white rounded-xl text-sm font-bold transition-colors">
                  {currentStreet === 'Preflop' ? 'Fold / BB' : 'Check'}
                </button>
                <button onClick={() => betAmount && handleHeroAction(currentStreet === 'Preflop' ? 'raise' : 'bet', parseFloat(betAmount))}
                  disabled={!betAmount}
                  className="py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl text-sm font-bold transition-colors border border-emerald-500/30">
                  {currentStreet === 'Preflop' ? 'Open' : 'Bet'}
                </button>
              </div>
              <input type="number" value={betAmount} onChange={e => setBetAmount(e.target.value)}
                placeholder={currentStreet === 'Preflop' ? 'Open to (bb)' : 'Bet size (bb)'}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/20" />
            </>
          )}
        </div>
      )}
    </div>
  )
}
