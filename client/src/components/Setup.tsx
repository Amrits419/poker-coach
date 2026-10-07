import { useState } from 'react'
import type { Setup } from '../api'

const POSITIONS = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const STACK_DEPTHS = ['25bb', '50bb', '100bb', '150bb', '200bb']
const BET_SIZES = ['33', '50', '75', '100']

const POS_DESC: Record<string, string> = {
  UTG: 'Under the gun', 'UTG+1': 'UTG+1', MP: 'Middle position', HJ: 'Hijack',
  CO: 'Cutoff', BTN: 'Button', SB: 'Small blind', BB: 'Big blind',
}

// Mini table preview: 8 seats around an oval, hero seat highlighted.
const MINI_SEATS = [
  { x: 50, y: 92 }, { x: 18, y: 80 }, { x: 6, y: 50 }, { x: 18, y: 20 },
  { x: 50, y: 8 }, { x: 82, y: 20 }, { x: 94, y: 50 }, { x: 82, y: 80 },
]

interface Props {
  onStart: (setup: Setup) => void
  loading: boolean
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-white/45">{title}</span>
        {hint && <span className="text-[12px] font-medium text-accent">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`rounded-lg border py-2.5 text-[13px] font-semibold transition-all ${
        active ? 'border-accent bg-accent/20 text-white shadow-[0_0_0_1px_rgba(139,124,255,0.5)]'
               : 'border-ink-500 bg-ink-900 text-white/55 hover:border-ink-500 hover:text-white'
      }`}>
      {children}
    </button>
  )
}

export default function SetupScreen({ onStart, loading }: Props) {
  const [position, setPosition] = useState('BTN')
  const [isMultiway, setIsMultiway] = useState(false)
  const [stackDepth, setStackDepth] = useState('100bb')
  const [betSize, setBetSize] = useState('75')

  const heroIdx = POSITIONS.indexOf(position)
  const seated = [...POSITIONS.slice(heroIdx), ...POSITIONS.slice(0, heroIdx)]

  return (
    <div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[1fr_340px]">
      {/* Preview */}
      <div className="rounded-2xl border border-ink-600/60 bg-ink-800/60 p-5">
        <div className="mb-4">
          <h2 className="text-lg font-bold tracking-tight text-white">New hand</h2>
          <p className="text-[13px] text-white/50">You'll be dealt in at <span className="font-semibold text-white/80">{POS_DESC[position]}</span>, {stackDepth} effective, {isMultiway ? 'multiway' : 'heads-up'} pot.</p>
        </div>
        <div className="relative mx-auto w-full" style={{ maxWidth: 520, aspectRatio: '1.9 / 1' }}>
          <div className="absolute inset-x-8 inset-y-5 rounded-[999px]" style={{ background: 'linear-gradient(180deg, #2a3147, #161b2b)', boxShadow: '0 12px 30px rgba(0,0,0,0.6)' }}>
            <div className="absolute inset-[8px] rounded-[999px]" style={{ background: 'radial-gradient(ellipse at 50% 40%, #2c7a4d 0%, #1f5c3a 50%, #16452b 100%)', boxShadow: 'inset 0 0 40px rgba(0,0,0,0.45)' }} />
          </div>
          {seated.map((pos, i) => {
            const isHero = i === 0
            return (
              <button key={pos} onClick={() => setPosition(pos)}
                className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-all ${
                  isHero ? 'seat-active border-accent bg-ink-800 text-white' : 'border-white/10 bg-ink-900/90 text-white/50 hover:text-white'
                }`}
                style={{ left: `${MINI_SEATS[i].x}%`, top: `${MINI_SEATS[i].y}%` }}>
                {isHero ? `You · ${pos}` : pos}
              </button>
            )
          })}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] font-semibold uppercase tracking-[0.25em] text-white/25">Click a seat</div>
        </div>
      </div>

      {/* Controls */}
      <div className="space-y-5 rounded-2xl border border-ink-600/60 bg-ink-800/60 p-5">
        <Section title="Position" hint={POS_DESC[position]}>
          <div className="grid grid-cols-4 gap-1.5">
            {POSITIONS.map(p => <Chip key={p} active={position === p} onClick={() => setPosition(p)}>{p}</Chip>)}
          </div>
        </Section>

        <Section title="Pot type">
          <div className="grid grid-cols-2 gap-1.5">
            <Chip active={!isMultiway} onClick={() => setIsMultiway(false)}>Heads-up</Chip>
            <Chip active={isMultiway} onClick={() => setIsMultiway(true)}>Multiway</Chip>
          </div>
        </Section>

        <Section title="Effective stack">
          <div className="grid grid-cols-5 gap-1.5">
            {STACK_DEPTHS.map(d => <Chip key={d} active={stackDepth === d} onClick={() => setStackDepth(d)}>{d.replace('bb', '')}</Chip>)}
          </div>
          <p className="mt-1.5 text-right text-[11px] text-white/35">big blinds</p>
        </Section>

        <Section title="Solver bet size" hint={`${betSize}% pot`}>
          <div className="grid grid-cols-4 gap-1.5">
            {BET_SIZES.map(b => <Chip key={b} active={betSize === b} onClick={() => setBetSize(b)}>{b}%</Chip>)}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-white/35">The solver uses one bet size per street to stay fast; the villain bets this size and your bets are graded against it. Smaller sizes build bigger trees, so the first flop solve takes longer.</p>
        </Section>

        <button onClick={() => onStart({ position, isMultiway, stackDepth, betSize })} disabled={loading}
          className="w-full rounded-xl bg-accent py-3.5 text-[15px] font-bold text-white shadow-[0_8px_30px_rgba(139,124,255,0.3)] transition-colors hover:bg-accent-dim disabled:bg-ink-600 disabled:text-white/40 disabled:shadow-none">
          {loading ? <span className="inline-flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-white" />Dealing…</span> : 'Deal hand'}
        </button>
      </div>
    </div>
  )
}
