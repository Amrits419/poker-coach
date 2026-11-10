export const scoreTone = (s: number | null | undefined) => s == null ? 'text-white/40' : s >= 75 ? 'text-call' : s >= 50 ? 'text-amber-300' : 'text-raise'
export const netTone = (n: number) => n > 0 ? 'text-call' : n < 0 ? 'text-raise' : 'text-white/60'
export const fmtBb = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}bb`
/** A chip amount without float noise: 5.5, 18.25, 100 */
export const bb = (n: number) => String(Math.round(n * 100) / 100)
