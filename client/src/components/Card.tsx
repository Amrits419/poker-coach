import { actionColor } from '../lib/cards'

const SUITS: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' }
const SUIT_COLOR: Record<string, string> = { h: '#e03131', d: '#2f6fed', c: '#2b8a3e', s: '#111827' }

export type CardSize = 'sm' | 'md' | 'lg'
const DIMS: Record<CardSize, { w: number; h: number; rank: number; pip: number }> = {
  sm: { w: 30, h: 42, rank: 13, pip: 12 },
  md: { w: 42, h: 60, rank: 18, pip: 17 },
  lg: { w: 56, h: 80, rank: 24, pip: 24 },
}

/** Four-colour deck, PokerNow-style: big rank top-left, suit pip beneath, large pip bottom-right. */
export function Card({ card, size = 'md' }: { card: string; size?: CardSize }) {
  const rank = card.slice(0, -1).replace('T', '10')
  const suit = card.slice(-1)
  const color = SUIT_COLOR[suit] ?? '#111827'
  const d = DIMS[size]
  return (
    <div
      className="relative select-none rounded-[5px] bg-white"
      style={{ width: d.w, height: d.h, flexShrink: 0, color, boxShadow: '0 1px 2px rgba(0,0,0,0.5), 0 4px 10px rgba(0,0,0,0.35)' }}
    >
      <div className="absolute left-[9%] top-[5%] font-extrabold leading-none" style={{ fontSize: d.rank }}>
        {rank}
      </div>
      <div className="absolute left-[9%] font-bold leading-none" style={{ top: `${size === 'sm' ? 40 : 36}%`, fontSize: d.pip - 2 }}>
        {SUITS[suit] ?? suit}
      </div>
      <div className="absolute bottom-[4%] right-[7%] leading-none" style={{ fontSize: d.pip + 4 }}>
        {SUITS[suit] ?? suit}
      </div>
    </div>
  )
}

export function CardBack({ size = 'md', dim = false }: { size?: CardSize; dim?: boolean }) {
  const d = DIMS[size]
  return (
    <div
      className="rounded-[5px]"
      style={{
        width: d.w, height: d.h, flexShrink: 0,
        opacity: dim ? 0.25 : 1,
        background: 'linear-gradient(160deg, #2b3a6b 0%, #1a2446 100%)',
        border: '2px solid #e9edf7',
        boxShadow: '0 1px 2px rgba(0,0,0,0.5), 0 4px 10px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{
        margin: 3, height: 'calc(100% - 6px)', borderRadius: 3,
        background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 6px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 6px)',
        border: '1px solid rgba(255,255,255,0.15)',
      }} />
    </div>
  )
}

/** 3-D flip from back to face. */
export function FlipCard({ card, revealed, size = 'md' }: { card: string; revealed: boolean; size?: CardSize }) {
  const d = DIMS[size]
  return (
    <div style={{ perspective: 600, width: d.w, height: d.h, flexShrink: 0 }}>
      <div style={{
        width: '100%', height: '100%', position: 'relative', transformStyle: 'preserve-3d',
        transition: 'transform 0.45s cubic-bezier(0.4,0,0.2,1)',
        transform: revealed ? 'rotateY(0deg)' : 'rotateY(180deg)',
      }}>
        <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden' }}><Card card={card} size={size} /></div>
        <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}><CardBack size={size} /></div>
      </div>
    </div>
  )
}

export function EmptySlot({ size = 'md' }: { size?: CardSize }) {
  const d = DIMS[size]
  return <div className="rounded-[5px]" style={{ width: d.w, height: d.h, flexShrink: 0, border: '1.5px dashed rgba(255,255,255,0.14)' }} />
}

export function ActionTag({ action, amount }: { action: string; amount?: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${actionColor(action)}`}>
      {action}{amount != null ? <span className="font-bold normal-case">{amount}bb</span> : null}
    </span>
  )
}
