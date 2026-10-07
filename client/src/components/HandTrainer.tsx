import { useState, useEffect, useRef, useMemo } from 'react'
import type { Setup, StartState, HandHistoryEntry, Analysis, VillainResponse } from '../api'
import { villainAct, analyzeHand } from '../api'
import { Card, CardBack, FlipCard, EmptySlot, ActionTag } from './Card'
import { parseCards } from '../lib/cards'

const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const
const ALL_POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN']
const PREFLOP_ORDER = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']

// Seat centres as % of the table box; hero (seat 0) at the bottom, clockwise.
const SEAT_COORDS = [
  { x: 50, y: 94 },
  { x: 16, y: 84 },
  { x: 4,  y: 50 },
  { x: 16, y: 16 },
  { x: 50, y: 6  },
  { x: 84, y: 16 },
  { x: 96, y: 50 },
  { x: 84, y: 84 },
]
// Where a seat's bet chip sits: pulled toward the table centre.
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const chipPos = (s: { x: number; y: number }) => ({ x: lerp(s.x, 50, 0.42), y: lerp(s.y, 50, 0.46) })
const dealerPos = (s: { x: number; y: number }) => ({ x: lerp(s.x, 50, 0.26) + (s.x === 50 ? (s.y > 50 ? -12 : 12) : s.x > 50 ? -7 : 7), y: lerp(s.y, 50, 0.26) })

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

// ── Sequential villain runner ─────────────────────────────────────────────────

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
  indicesToRun: number[],
  onStep?: (villainIdx: number) => void,
): Promise<{
  history: HandHistoryEntry[]
  descs: VillainDesc[]
  pot: number
  stack: number
  foldedVillains: Set<number>
  handOver: boolean
  raisedResp: VillainResponse | null
  raisedBy: number | null
}> {
  let hist = initHistory
  let descs = initDescs
  let pot = initPot
  let stack = initStack
  const folded = new Set(foldedVillains)

  for (const vi of indicesToRun) {
    if (folded.has(vi)) continue
    onStep?.(vi)
    const resp = await villainAct(setup, startState, hist, street, board, pot, stack, vi)
    hist = [...hist, { street, actor: 'villain', action: resp.action, amount: resp.amount, villainIdx: vi }]
    descs = [...descs, { street, description: resp.description }]
    pot = resp.newPot
    stack = resp.newStack

    if (resp.action === 'fold' || resp.isHandOver) {
      folded.add(vi)
      if (folded.size >= startState.villainPositions.length)
        return { history: hist, descs, pot, stack, foldedVillains: folded, handOver: true, raisedResp: null, raisedBy: null }
    } else if (resp.action === 'bet' || resp.action === 'raise') {
      return { history: hist, descs, pot, stack, foldedVillains: folded, handOver: false, raisedResp: resp, raisedBy: vi }
    }
  }
  return { history: hist, descs, pot, stack, foldedVillains: folded, handOver: false, raisedResp: null, raisedBy: null }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HandTrainer({ userId, setup, startState, onDone }: Props) {
  const heroIdx = ALL_POSITIONS.indexOf(setup.position)
  const seatedPositions = heroIdx === -1
    ? ALL_POSITIONS
    : [...ALL_POSITIONS.slice(heroIdx), ...ALL_POSITIONS.slice(0, heroIdx)]

  // ── Deal animation state ──────────────────────────────────────────────────
  const [dealt, setDealt] = useState<boolean[][]>(() => Array.from({ length: 8 }, () => [false, false]))
  const [mucked, setMucked] = useState<Set<number>>(new Set())
  const [heroRevealed, setHeroRevealed] = useState(false)
  const [dealPhase, setDealPhase] = useState<DealPhase>('dealing')

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const push = (fn: () => void, delay: number) => { timersRef.current.push(setTimeout(fn, delay)) }
    const INTERVAL = 90

    for (let round = 0; round < 2; round++) {
      for (let seat = 0; seat < 8; seat++) {
        const delay = 60 + (round * 8 + seat) * INTERVAL
        const r = round, s = seat
        push(() => {
          setDealt(prev => { const next = prev.map(row => [...row]); next[s][r] = true; return next })
        }, delay)
      }
    }

    const flipDelay = 60 + 15 * INTERVAL + 300
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
        beforeHero.sort((a, b) => PREFLOP_ORDER.indexOf(seatedPositions[a]) - PREFLOP_ORDER.indexOf(seatedPositions[b]))
        beforeHero.forEach((seat, j) => { push(() => setMucked(prev => new Set([...prev, seat])), j * 180) })
        const readyDelay = beforeHero.length > 0 ? (beforeHero.length - 1) * 180 + 420 : 0
        push(() => setDealPhase('ready'), readyDelay)
      }, 480)
    }, flipDelay)

    return () => { timersRef.current.forEach(clearTimeout); timersRef.current = [] }
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
  const [thinkingVillain, setThinkingVillain] = useState<number | null>(null)
  const [villainDescriptions, setVillainDescriptions] = useState<VillainDesc[]>([])
  const [foldedVillains, setFoldedVillains] = useState<Set<number>>(new Set())
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const retryRef = useRef<(() => Promise<void>) | null>(null)

  // Run a villain/analysis step; on failure, surface it and keep a retry handle
  // instead of leaving the table stuck on "villain to act".
  const guarded = async (step: () => Promise<void>) => {
    setErrorMsg(null)
    try { await step() } catch (err) {
      console.error(err)
      setThinkingVillain(null)
      setGamePhase('hero_acts')
      setErrorMsg('The villain request failed (server or LLM error).')
      retryRef.current = step
    }
  }

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

  const setVillainRaise = (resp: VillainResponse | null) => {
    setVillainBet(resp?.amount ?? null)
    setPotOdds(resp?.potOdds ?? null)
  }

  const applyResult = (result: Awaited<ReturnType<typeof runVillainsSequential>>) => {
    setHistory(result.history); setVillainDescriptions(result.descs)
    setPot(result.pot); setEffectiveStack(result.stack); setFoldedVillains(result.foldedVillains)
    setThinkingVillain(null)
  }

  const fetchVillainOpener = (idx: number) => guarded(async () => {
    const board = getBoardForStreet(idx, startState.board)
    const street = STREETS[idx]
    setGamePhase('loading'); setStatusMsg(`${street}: villain to act`)
    const result = await runVillainsSequential(setup, startState, history, villainDescriptions, street, board, pot, effectiveStack, foldedVillains, oopVillainIndices, setThinkingVillain)
    applyResult(result)
    if (result.handOver) { await runAnalysis(result.history, result.descs); return }
    setVillainRaise(result.raisedResp)
    setGamePhase('hero_acts')
  })

  const runAnalysis = async (finalHistory: HandHistoryEntry[], descs: VillainDesc[]) => {
    setGamePhase('analyzing'); setStatusMsg('Solver is grading your decisions…'); setThinkingVillain(null)
    try {
      const { analysis } = await analyzeHand(userId, setup, startState, finalHistory)
      onDone(analysis, descs)
    } catch (err) {
      console.error('Analysis error:', err)
      setGamePhase('hero_acts')
      setErrorMsg('Analysis failed.')
      retryRef.current = () => runAnalysis(finalHistory, descs)
    }
  }

  // Street transitions are driven by streetIndex so the villain opener runs
  // against fresh state after the previous street's updates have rendered.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (streetIndex === 0) {
      setGamePhase('hero_acts')
      // If villain opened preflop, hero faces their raise immediately
      const faces = !startState.heroIsPFR ? (startState.preflopRaiseAmount ?? null) : null
      setVillainBet(faces)
      setPotOdds(null)
      return
    }
    if (oopVillainIndices.length > 0) fetchVillainOpener(streetIndex)
    else { setGamePhase('hero_acts'); setVillainRaise(null) }
  }, [streetIndex]) // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const muckAfterHero = () => {
    const heroPfIdx = PREFLOP_ORDER.indexOf(setup.position)
    const afterHero: number[] = []
    for (let i = 1; i < 8; i++) {
      const pos = seatedPositions[i]
      if (startState.villainPositions.includes(pos)) continue
      const pfIdx = PREFLOP_ORDER.indexOf(pos)
      if (pfIdx !== -1 && pfIdx > heroPfIdx) afterHero.push(i)
    }
    afterHero.sort((a, b) => PREFLOP_ORDER.indexOf(seatedPositions[a]) - PREFLOP_ORDER.indexOf(seatedPositions[b]))
    afterHero.forEach((seat, j) => { setTimeout(() => setMucked(prev => new Set([...prev, seat])), j * 180) })
  }

  const handleHeroAction = async (action: string, amount?: number) => {
    if (currentStreet === 'Preflop') muckAfterHero()

    const heroEntry: HandHistoryEntry = { street: currentStreet, actor: 'hero', action, amount }
    const newHistory = [...history, heroEntry]
    setHistory(newHistory); setVillainRaise(null); setBetAmount('')
    if (action === 'fold') { await runAnalysis(newHistory, villainDescriptions); return }
    await guarded(() => afterHeroAction(action, amount, newHistory))
  }

  const afterHeroAction = async (action: string, amount: number | undefined, newHistory: HandHistoryEntry[]) => {
    setGamePhase('loading'); setStatusMsg('Villain responding…')

    if (currentStreet === 'Preflop' && !startState.heroIsPFR && action === 'call') {
      const callAmt = startState.preflopRaiseAmount ?? 0
      const postedBlind = setup.position === 'BB' ? 1.0 : setup.position === 'SB' ? 0.5 : 0
      const newPot = Math.round((pot + callAmt) * 10) / 10
      const newStack = Math.max(0, Math.round((effectiveStack - Math.max(0, callAmt - postedBlind)) * 10) / 10)
      setPot(newPot)
      setEffectiveStack(newStack)

      const coldCallers = startState.villainPositions.slice(1).map((_, i) => i + 1)
      if (coldCallers.length > 0) {
        const result = await runVillainsSequential(setup, startState, newHistory, villainDescriptions, 'Preflop', [], newPot, newStack, foldedVillains, coldCallers, setThinkingVillain)
        applyResult(result)
        if (result.handOver) { await runAnalysis(result.history, result.descs); return }
      }
      setThinkingVillain(null)
      setStreetIndex(1)
      setGamePhase('hero_acts')
      return
    }

    let villainsToRun: number[]
    if (currentStreet === 'Preflop') {
      villainsToRun = preflopVillainIndices
    } else if (action === 'call') {
      const callAmt = amount ?? 0
      setPot(p => Math.round((p + callAmt) * 10) / 10)
      setEffectiveStack(s => Math.max(0, Math.round((s - callAmt) * 10) / 10))
      const nextIdx = streetIndex + 1
      if (nextIdx >= STREETS.length) { await runAnalysis(newHistory, villainDescriptions); return }
      setStreetIndex(nextIdx)
      return
    } else if (action === 'check') {
      villainsToRun = ipVillainIndices
    } else {
      villainsToRun = [...oopVillainIndices, ...ipVillainIndices]
    }

    const result = await runVillainsSequential(setup, startState, newHistory, villainDescriptions, currentStreet, currentBoard, pot, effectiveStack, foldedVillains, villainsToRun, setThinkingVillain)
    applyResult(result)
    if (result.handOver) { await runAnalysis(result.history, result.descs); return }
    if (result.raisedResp) { setVillainRaise(result.raisedResp); setGamePhase('hero_acts'); return }
    const nextIdx = streetIndex + 1
    if (nextIdx >= STREETS.length) { await runAnalysis(result.history, result.descs); return }
    setStreetIndex(nextIdx)
  }

  // ── Bet sizing ────────────────────────────────────────────────────────────
  const r1 = (n: number) => Math.round(n * 10) / 10
  const minBet = facingBet ? r1((villainBet ?? 0) * 2) : currentStreet === 'Preflop' ? 2 : 1
  const maxBet = Math.max(minBet, effectiveStack)
  const presets = facingBet
    ? [{ label: '2×', amt: r1(villainBet! * 2) }, { label: '2.5×', amt: r1(villainBet! * 2.5) }, { label: '3×', amt: r1(villainBet! * 3) }, { label: 'All-in', amt: effectiveStack }]
    : currentStreet === 'Preflop'
      ? [{ label: '2bb', amt: 2 }, { label: '2.5bb', amt: 2.5 }, { label: '3bb', amt: 3 }, { label: 'All-in', amt: effectiveStack }]
      : [{ label: '33%', amt: r1(pot * 0.33) }, { label: '50%', amt: r1(pot * 0.5) }, { label: '75%', amt: r1(pot * 0.75) }, { label: 'Pot', amt: pot }, { label: 'All-in', amt: effectiveStack }]
  const betNum = parseFloat(betAmount)
  // A raise must be at least the min-raise unless it's a shove
  const betValid = !Number.isNaN(betNum) && betNum > 0 && betNum <= maxBet && (betNum >= minBet || betNum === effectiveStack)
  const sliderVal = betValid ? Math.min(Math.max(betNum, minBet), maxBet) : minBet
  const sliderFill = maxBet > minBet ? ((sliderVal - minBet) / (maxBet - minBet)) * 100 : 100

  const aggressiveLabel = facingBet ? 'Raise' : currentStreet === 'Preflop' ? 'Open' : 'Bet'
  const passiveLabel = facingBet ? `Call ${villainBet}bb` : currentStreet === 'Preflop' ? 'Check / Fold' : 'Check'

  // Chips in front of each seat on the current street: preflop starts from the
  // blinds/open/3-bet the server dealt us into, then every action updates it.
  const streetBets = useMemo(() => {
    const bets: Record<string, number> = currentStreet === 'Preflop' ? { ...(startState.preflopBets ?? {}) } : {}
    for (const h of history) {
      if (h.street !== currentStreet) continue
      const pos = h.actor === 'hero' ? setup.position : startState.villainPositions[h.villainIdx ?? 0]
      if (!pos) continue
      if (h.action === 'fold') delete bets[pos]
      else if (h.action === 'bet' || h.action === 'raise') { if (h.amount != null) bets[pos] = h.amount }
      else if (h.action === 'call') bets[pos] = h.amount ?? Math.max(0, ...Object.values(bets))
    }
    return bets
  }, [history, currentStreet, startState, setup.position])

  const canAct = !isWaiting && dealPhase === 'ready'
  const btnSeat = seatedPositions.indexOf('BTN')

  // Pre-fill a sensible size at each new decision point (user can change it)
  const decisionKey = `${currentStreet}|${villainBet ?? ''}|${history.length}`
  const lastDecisionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!canAct || lastDecisionRef.current === decisionKey) return
    lastDecisionRef.current = decisionKey
    const solverPct = Number(setup.betSize ?? 75) / 100
    const def = facingBet ? r1((villainBet ?? 0) * 2.5) : currentStreet === 'Preflop' ? 2.5 : r1(pot * solverPct)
    setBetAmount(String(Math.min(Math.max(def, minBet), maxBet)))
  }, [canAct, decisionKey])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-4">
        {/* ── Table ─────────────────────────────────────────────────────── */}
        <div className="relative mx-auto w-full" style={{ maxWidth: 880, aspectRatio: '1.6 / 1' }}>
          {/* Rail + felt */}
          <div className="absolute inset-x-14 inset-y-14 rounded-[999px]" style={{
            background: 'linear-gradient(180deg, #2a3147 0%, #161b2b 100%)',
            boxShadow: '0 20px 50px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}>
            <div className="absolute inset-[11px] rounded-[999px]" style={{
              background: 'radial-gradient(ellipse at 50% 40%, #2c7a4d 0%, #1f5c3a 50%, #16452b 100%)',
              boxShadow: 'inset 0 0 60px rgba(0,0,0,0.45)',
            }}>
              <div className="absolute inset-[22px] rounded-[999px]" style={{ border: '1.5px solid rgba(255,255,255,0.07)' }} />
            </div>
          </div>

          {/* Centre: pot + board */}
          <div className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
            <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-[12px] font-semibold text-white/90 backdrop-blur-sm">
              <span className="text-white/50">Pot</span>
              <span className="text-[14px] font-bold">{pot}bb</span>
              {potOdds && <span className="ml-1 border-l border-white/15 pl-2 text-white/60">odds {potOdds}</span>}
            </div>
            <div className="flex gap-1.5">
              {currentBoard.map((c, i) => (
                <div key={c} style={{ animation: 'dealCard 0.3s ease-out both', animationDelay: `${i >= 3 ? 0 : i * 70}ms` }}>
                  <Card card={c} size="lg" />
                </div>
              ))}
              {Array.from({ length: 5 - currentBoard.length }).map((_, i) => <EmptySlot key={i} size="lg" />)}
            </div>
            <div className="flex gap-1">
              {STREETS.map((s, i) => (
                <span key={s} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  i === streetIndex ? 'bg-white/15 text-white' : i < streetIndex ? 'text-white/45' : 'text-white/20'
                }`}>{s}</span>
              ))}
            </div>
          </div>

          {/* Dealer button */}
          {btnSeat !== -1 && (() => { const p = dealerPos(SEAT_COORDS[btnSeat]); return (
            <div className="absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[11px] font-black text-ink-900 shadow-seat"
              style={{ left: `${p.x}%`, top: `${p.y}%` }}>D</div>
          )})()}

          {/* Seats */}
          {seatedPositions.map((pos, seatIdx) => {
            const isHero = seatIdx === 0
            const villainIdx = startState.villainPositions.indexOf(pos)
            const isVillain = villainIdx !== -1
            const isFolded = isVillain && foldedVillains.has(villainIdx)
            const isMucked = mucked.has(seatIdx)
            const isOut = isMucked || isFolded
            const isActing = (isHero && canAct) || (isVillain && thinkingVillain === villainIdx)
            const chip = streetBets[pos] ?? null
            const s = SEAT_COORDS[seatIdx]
            const c = chipPos(s)

            return (
              <div key={pos}>
                {/* Bet chip */}
                {chip != null && chip > 0 && !isOut && (
                  <div className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full bg-black/55 py-0.5 pl-0.5 pr-2.5 text-[12px] font-bold text-white backdrop-blur-sm"
                    style={{ left: `${c.x}%`, top: `${c.y}%`, animation: 'chipIn 0.25s ease-out both' }}>
                    <span className="h-4 w-4 rounded-full border-[3px] border-dashed border-white/80" style={{ background: isHero ? '#8b7cff' : '#ff5c5c' }} />
                    {chip}bb
                  </div>
                )}

                {/* Seat */}
                <div className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
                  style={{ left: `${s.x}%`, top: `${s.y}%` }}>
                  {dealt[seatIdx][0] && (
                    <div className={`${isHero ? '-mb-3 gap-1.5' : s.y < 50 ? 'order-2 -mt-1.5 gap-0.5' : '-mb-2.5 gap-0.5'} flex`} style={isMucked ? { animation: 'muckCards 0.35s ease-in forwards' } : {}}>
                      {[0, 1].map(ci => (
                        <div key={ci} style={dealt[seatIdx][ci] ? { animation: 'dealCard 0.22s ease-out both' } : { opacity: 0 }}>
                          {isHero
                            ? <FlipCard card={heroCards[ci]} revealed={heroRevealed} size="md" />
                            : <CardBack size="sm" dim={isFolded} />}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className={`relative z-10 flex flex-col items-center rounded-xl border shadow-seat transition-all ${
                    isHero ? 'min-w-[96px] border-accent/50 bg-ink-800 px-3 py-1.5' : isVillain ? 'min-w-[92px] border-white/10 bg-ink-800 px-3 py-1.5' : 'border-white/5 bg-ink-900/80 px-2.5 py-1'
                  } ${isOut ? 'opacity-40' : ''} ${isActing ? 'seat-active' : ''}`}>
                    {(isHero || isVillain) && (
                      <span className={`text-[12px] font-bold leading-tight ${isHero ? 'text-white' : 'text-white/90'}`}>{isHero ? 'You' : 'Villain'}</span>
                    )}
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${isHero || isVillain ? 'text-white/45' : 'text-white/30'}`}>
                      {pos}{isHero ? ` · ${effectiveStack}bb` : ''}
                    </span>
                    {isVillain && thinkingVillain === villainIdx && (
                      <span className="absolute -top-2 right-1 rounded bg-accent px-1 text-[9px] font-bold text-white">…</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Status / context ───────────────────────────────────────────── */}
        <div className="min-h-[22px] pt-1 text-center text-[13px] text-white/60">
          {isWaiting ? (
            <span className="inline-flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />{statusMsg}</span>
          ) : dealPhase !== 'ready' ? (
            <span className="inline-flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-white/40" />Dealing…</span>
          ) : streetIndex === 0 ? startState.preflopContext : facingBet ? `Facing a ${villainBet}bb ${currentStreet === 'Preflop' ? 'raise' : 'bet'}. Your move.` : 'Your move.'}
          {errorMsg && (
            <span className="ml-3 inline-flex items-center gap-2 rounded-md border border-raise/40 bg-raise/10 px-2.5 py-1 text-[12px] text-raise">
              {errorMsg}
              <button onClick={() => { const r = retryRef.current; if (r) { retryRef.current = null; guarded(r) } }}
                className="font-bold underline underline-offset-2 hover:text-white">Retry</button>
            </span>
          )}
        </div>

        {/* ── Action bar ────────────────────────────────────────────────── */}
        <div className={`rounded-2xl border border-ink-600/60 bg-ink-800/80 p-3 transition-opacity ${canAct && !errorMsg ? '' : 'pointer-events-none opacity-40'}`}>
          <div className="mb-3 flex items-center gap-3">
            <input type="range" className="bet-slider flex-1" min={minBet} max={maxBet} step={0.5} value={sliderVal}
              style={{ ['--fill' as string]: `${sliderFill}%` }}
              onChange={e => setBetAmount(e.target.value)} />
            <div className="flex items-center rounded-lg border border-ink-500 bg-ink-900 pr-2">
              <input type="number" value={betAmount} onChange={e => setBetAmount(e.target.value)} placeholder={String(minBet)}
                className="w-16 bg-transparent px-2 py-1.5 text-right text-sm font-bold text-white outline-none placeholder:text-white/25" />
              <span className="text-[11px] font-semibold text-white/40">bb</span>
            </div>
            <div className="hidden gap-1 sm:flex">
              {presets.map(({ label, amt }) => (
                <button key={label} onClick={() => setBetAmount(String(amt))}
                  className={`rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                    betAmount === String(amt) ? 'border-raise/60 bg-raise/20 text-white' : 'border-ink-500 bg-ink-900 text-white/60 hover:text-white'
                  }`}>{label}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button onClick={() => handleHeroAction('fold')}
              className="rounded-xl border border-fold/40 bg-fold/15 py-3.5 text-sm font-bold text-fold transition-colors hover:bg-fold/25">
              Fold
            </button>
            <button onClick={() => facingBet ? handleHeroAction('call', villainBet ?? undefined) : handleHeroAction('check')}
              className="rounded-xl border border-call/40 bg-call/15 py-3.5 text-sm font-bold text-call transition-colors hover:bg-call/25">
              {passiveLabel}
            </button>
            <button disabled={!betValid}
              onClick={() => betValid && handleHeroAction(facingBet || currentStreet === 'Preflop' ? 'raise' : 'bet', betNum)}
              className="rounded-xl border border-raise/40 bg-raise/15 py-3.5 text-sm font-bold text-raise transition-colors hover:bg-raise/25 disabled:border-ink-600 disabled:bg-ink-900 disabled:text-white/25">
              {aggressiveLabel}{betValid ? ` ${betNum}bb` : ''}
            </button>
          </div>
        </div>
      </div>

      {/* ── Hand log ───────────────────────────────────────────────────── */}
      <aside className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[12px] font-bold uppercase tracking-wider text-white/50">Hand log</h3>
          <span className="text-[11px] text-white/40">{setup.stackDepth} · {setup.isMultiway ? 'multiway' : 'heads-up'}</span>
        </div>
        {history.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-white/40">{startState.preflopContext}</p>
        ) : (
          <div className="space-y-3">
            {STREETS.filter(s => history.some(h => h.street === s)).map(s => (
              <div key={s}>
                <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-white/35">
                  {s}
                  {s !== 'Preflop' && <span className="flex gap-0.5">{getBoardForStreet(STREETS.indexOf(s), startState.board).slice(s === 'Flop' ? 0 : s === 'Turn' ? 3 : 4).map(c => <Card key={c} card={c} size="sm" />)}</span>}
                </div>
                <div className="space-y-1">
                  {history.filter(h => h.street === s).map((h, i) => (
                    <div key={i} className="flex items-center justify-between text-[12px]">
                      <span className={h.actor === 'hero' ? 'font-semibold text-white' : 'text-white/60'}>{h.actor === 'hero' ? 'You' : 'Villain'}</span>
                      <ActionTag action={h.action} amount={h.amount} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}
