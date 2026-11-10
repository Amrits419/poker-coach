import { useState, useEffect, useRef } from 'react'
import type { Setup, StartState, HandHistoryEntry, Analysis, TableState } from '../api'
import { villainAct, analyzeHand, getTable, explainVillain } from '../api'
import { Card, CardBack, FlipCard, EmptySlot, ActionTag } from './Card'
import { parseCards } from '../lib/cards'
import { bb } from '../lib/format'

const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const
const ALL_POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
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
  if (idx <= 0) return []
  if (idx === 1) return b.flop
  if (idx === 2) return [...b.flop, b.turn]
  return [...b.flop, b.turn, b.river]
}

const r2 = (n: number) => Math.round(n * 100) / 100
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const RAISE_NAMES = ['Open', '3-bet', '4-bet', '5-bet']

// A sensible size to pre-fill when hero's turn comes round (they can change it).
function defaultBet(t: TableState, setup: Setup): string {
  if (!t.canRaise) return ''
  const size = t.toCall > 0
    ? (t.street === 'Preflop' ? (t.preflopRaises === 0 ? 2.5 : t.toCall * 3) : t.toCall * 2.5)
    : t.pot * (Number(setup.betSize ?? 75) / 100)
  return bb(Math.min(Math.max(Math.round(size * 10) / 10, t.minRaise), t.maxRaise))
}

type DealPhase = 'dealing' | 'done' | 'ready'
type GamePhase = 'hero_acts' | 'loading' | 'analyzing'

export interface VillainDesc { street: string; description: string }

interface Props {
  userId: string
  setup: Setup
  startState: StartState
  initialTable: TableState
  onDone: (analysis: Analysis, villainDescriptions: VillainDesc[]) => void
}

// The server owns the state of the hand. After every hero action the table is
// re-read from it, and villains are asked to act one at a time until it is
// hero's turn again or the hand is over; this component only draws the result.

export default function HandTrainer({ userId, setup, startState, initialTable, onDone }: Props) {
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
    // The deal animation runs once per hand (the component is keyed by hand).
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Game state ────────────────────────────────────────────────────────────
  const [table, setTable] = useState<TableState>(initialTable)
  const [history, setHistory] = useState<HandHistoryEntry[]>([])
  const [gamePhase, setGamePhase] = useState<GamePhase>('hero_acts')
  const [betAmount, setBetAmount] = useState(() => defaultBet(initialTable, setup))
  const [statusMsg, setStatusMsg] = useState('')
  const [thinkingVillain, setThinkingVillain] = useState<number | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // The async loop below outlives renders, so it reads the latest history from a ref.
  const historyRef = useRef<HandHistoryEntry[]>([])
  const descsRef = useRef<Promise<VillainDesc>[]>([])
  const retryRef = useRef<(() => Promise<void>) | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  // Run a step; on failure, surface it and keep a retry handle instead of
  // leaving the table stuck on "villain to act".
  const guarded = async (step: () => Promise<void>) => {
    setErrorMsg(null)
    try { await step() } catch (err) {
      console.error(err)
      setThinkingVillain(null)
      setGamePhase('hero_acts')
      setErrorMsg('That request failed (server, solver or LLM error).')
      retryRef.current = step
    }
  }

  const runAnalysis = async () => {
    setGamePhase('analyzing'); setStatusMsg('Solver is grading your decisions…'); setThinkingVillain(null)
    const [{ analysis }, descs] = await Promise.all([
      analyzeHand(userId, setup, startState, historyRef.current),
      Promise.all(descsRef.current),
    ])
    if (aliveRef.current) onDone(analysis, descs)
  }

  // Bring the table up to date with the server, letting villains act until it
  // is hero's turn or the hand ends. Safe to re-run after a failure.
  const sync = async () => {
    setGamePhase('loading'); setStatusMsg('Villain responding…')
    let h = historyRef.current
    let t = await getTable(setup, startState, h)
    setTable(t)
    while (!t.handOver && typeof t.toAct === 'number') {
      setThinkingVillain(t.toAct)
      setStatusMsg(`${t.street}: ${startState.villainPositions[t.toAct]} to act`)
      const r = await villainAct(setup, startState, h)
      h = r.history; t = r.table
      historyRef.current = h; setHistory(h); setTable(t)
      // The solver's reasoning is worded by the LLM in the background; it is only
      // shown after the hand, so it never holds up the next action.
      const desc = { street: r.entry.street, description: r.description }
      descsRef.current.push(r.explain
        ? explainVillain(r.explain).then(description => ({ ...desc, description }), () => desc)
        : Promise.resolve(desc))
    }
    setThinkingVillain(null)
    if (t.handOver) {
      if (t.allInRunout) await sleep(1400)   // let the run-out be seen
      await runAnalysis()
      return
    }
    setBetAmount(defaultBet(t, setup))
    setGamePhase('hero_acts')
  }

  const currentStreet = table.street
  const streetIndex = Math.max(0, STREETS.indexOf(currentStreet as typeof STREETS[number]))
  const currentBoard = getBoardForStreet(streetIndex, startState.board)
  const heroCards = parseCards(startState.holeCards)
  const isWaiting = gamePhase === 'loading' || gamePhase === 'analyzing'
  const canAct = !isWaiting && dealPhase === 'ready' && table.toAct === 'hero' && !errorMsg
  const facingBet = table.toCall > 0

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

  const handleHeroAction = (action: string, amount?: number) => {
    if (!canAct) return
    if (history.length === 0) muckAfterHero()

    const to = action === 'call' ? Math.min(table.toCall, table.maxRaise) : action === 'bet' || action === 'raise' ? amount : undefined
    const entry: HandHistoryEntry = { street: currentStreet, actor: 'hero', action, amount: to }
    const h = [...historyRef.current, entry]
    historyRef.current = h; setHistory(h)
    // Show hero's chips going in straight away; the server's table replaces this.
    setTable(t => {
      const add = to == null ? 0 : r2(to - t.heroIn)
      return {
        ...t, toAct: null, toCall: 0, callCost: 0, potOdds: null,
        pot: r2(t.pot + add), heroStack: r2(t.heroStack - add),
        heroIn: to ?? t.heroIn, bets: to == null ? t.bets : { ...t.bets, [setup.position]: to },
      }
    })
    guarded(sync)
  }

  // ── Bet sizing ────────────────────────────────────────────────────────────
  const { minRaise: minBet, maxRaise: maxBet } = table
  const unopened = currentStreet === 'Preflop' && table.preflopRaises === 0
  const presets = (unopened
    ? [{ label: '2bb', amt: 2 }, { label: '2.5bb', amt: 2.5 }, { label: '3bb', amt: 3 }]
    : facingBet
      ? [2.5, 3, 4].map(m => ({ label: `${m}×`, amt: r2(table.toCall * m) }))
      : [{ label: '33%', amt: r2(table.pot * 0.33) }, { label: '50%', amt: r2(table.pot * 0.5) }, { label: '75%', amt: r2(table.pot * 0.75) }, { label: 'Pot', amt: r2(table.pot) }]
  ).filter(p => p.amt >= minBet && p.amt < maxBet).concat([{ label: 'All-in', amt: maxBet }])
  const betNum = parseFloat(betAmount)
  // A bet or raise must be at least the minimum unless it is all-in
  const betValid = table.canRaise && !Number.isNaN(betNum) && betNum > 0 && betNum <= maxBet && (betNum >= minBet || betNum === maxBet)
  const isShove = betValid && betNum >= maxBet
  const sliderVal = betValid ? Math.min(Math.max(betNum, minBet), maxBet) : minBet
  const sliderFill = maxBet > minBet ? ((sliderVal - minBet) / (maxBet - minBet)) * 100 : 100

  const aggressiveName = currentStreet === 'Preflop' ? RAISE_NAMES[Math.min(table.preflopRaises, RAISE_NAMES.length - 1)] : facingBet ? 'Raise' : 'Bet'
  const aggressiveLabel = !betValid ? aggressiveName
    : isShove ? `All-in ${bb(betNum)}bb`
    : `${aggressiveName}${facingBet && !unopened ? ' to' : ''} ${bb(betNum)}bb`
  const passiveLabel = !facingBet ? 'Check' : table.callCost >= table.heroStack ? `Call all-in ${bb(table.callCost)}bb` : `Call ${bb(table.callCost)}bb`

  const fold = () => { if (facingBet) handleHeroAction('fold') }
  const checkOrCall = () => handleHeroAction(facingBet ? 'call' : 'check')
  const betOrRaise = () => { if (betValid) handleHeroAction(currentStreet !== 'Preflop' && !facingBet ? 'bet' : 'raise', betNum) }

  // Keyboard: F fold, C check/call, R (or B) bet/raise. Re-bound every render so
  // the handlers always see the current table.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el as HTMLInputElement).type !== 'range') return
      const k = e.key.toLowerCase()
      if (k === 'f') fold()
      else if (k === 'c') checkOrCall()
      else if (k === 'r' || k === 'b') betOrRaise()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const streetBets = table.bets
  const foldedVillains = table.folded
  const btnSeat = seatedPositions.indexOf('BTN')
  const actorName = (h: HandHistoryEntry) => h.actor === 'hero' ? 'You' : startState.villainPositions[h.villainIdx ?? 0] ?? 'Villain'

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
              <span className="text-[14px] font-bold">{bb(table.pot)}bb</span>
              {table.potOdds && canAct && <span className="ml-1 border-l border-white/15 pl-2 text-white/60">odds {table.potOdds}</span>}
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
            const isFolded = isVillain && foldedVillains.includes(villainIdx)
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
                    {bb(chip)}bb
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
                      {pos}{isHero ? ` · ${bb(table.heroStack)}bb` : ''}
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
          ) : history.length === 0 ? startState.preflopContext
            : facingBet ? `Facing ${bb(table.toCall)}bb — ${bb(table.callCost)}bb to call${table.potOdds ? ` (pot odds ${table.potOdds})` : ''}.`
            : 'Your move.'}
          {errorMsg && (
            <span className="ml-3 inline-flex items-center gap-2 rounded-md border border-raise/40 bg-raise/10 px-2.5 py-1 text-[12px] text-raise">
              {errorMsg}
              <button onClick={() => { const r = retryRef.current ?? sync; retryRef.current = null; guarded(r) }}
                className="font-bold underline underline-offset-2 hover:text-white">Retry</button>
            </span>
          )}
        </div>

        {/* ── Action bar ────────────────────────────────────────────────── */}
        <div className={`rounded-2xl border border-ink-600/60 bg-ink-800/80 p-3 transition-opacity ${canAct ? '' : 'pointer-events-none opacity-40'}`}>
          <div className={`mb-3 flex items-center gap-3 ${table.canRaise || !canAct ? '' : 'pointer-events-none opacity-30'}`}>
            <input type="range" className="bet-slider flex-1" min={minBet} max={maxBet} step={0.5} value={sliderVal}
              style={{ ['--fill' as string]: `${sliderFill}%` }}
              onChange={e => setBetAmount(e.target.value)} />
            <div className="flex items-center rounded-lg border border-ink-500 bg-ink-900 pr-2">
              <input type="number" value={betAmount} onChange={e => setBetAmount(e.target.value)} placeholder={bb(minBet)}
                className="w-16 bg-transparent px-2 py-1.5 text-right text-sm font-bold text-white outline-none placeholder:text-white/25" />
              <span className="text-[11px] font-semibold text-white/40">bb</span>
            </div>
            <div className="hidden gap-1 sm:flex">
              {presets.map(({ label, amt }) => (
                <button key={label} onClick={() => setBetAmount(bb(amt))}
                  className={`rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                    betAmount === bb(amt) ? 'border-raise/60 bg-raise/20 text-white' : 'border-ink-500 bg-ink-900 text-white/60 hover:text-white'
                  }`}>{label}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button disabled={!facingBet} onClick={fold} title="Fold (F)"
              className="rounded-xl border border-fold/40 bg-fold/15 py-3.5 text-sm font-bold text-fold transition-colors hover:bg-fold/25 disabled:border-ink-600 disabled:bg-ink-900 disabled:text-white/25">
              Fold
            </button>
            <button onClick={checkOrCall} title={`${facingBet ? 'Call' : 'Check'} (C)`}
              className="rounded-xl border border-call/40 bg-call/15 py-3.5 text-sm font-bold text-call transition-colors hover:bg-call/25">
              {passiveLabel}
            </button>
            <button disabled={!betValid} onClick={betOrRaise} title={`${aggressiveName} (R)`}
              className="rounded-xl border border-raise/40 bg-raise/15 py-3.5 text-sm font-bold text-raise transition-colors hover:bg-raise/25 disabled:border-ink-600 disabled:bg-ink-900 disabled:text-white/25">
              {aggressiveLabel}
            </button>
          </div>
          <p className="mt-2 hidden text-center text-[10px] font-medium uppercase tracking-wider text-white/25 sm:block">Keys: F fold · C check / call · R bet / raise</p>
        </div>
      </div>

      {/* ── Hand log ───────────────────────────────────────────────────── */}
      <aside className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[12px] font-bold uppercase tracking-wider text-white/50">Hand log</h3>
          <span className="text-[11px] text-white/40">{setup.stackDepth} · {startState.villainPositions.length > 1 ? 'multiway' : 'heads-up'}</span>
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
                      <span className={h.actor === 'hero' ? 'font-semibold text-white' : 'text-white/60'}>{actorName(h)}</span>
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
