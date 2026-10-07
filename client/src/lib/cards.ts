/** Split a hole-card string like "AhKd" into ["Ah", "Kd"]. */
export function parseCards(str: string): string[] {
  return str.match(/.{2}/g) ?? []
}

/** Colour-coded action classes (GTO Wizard convention: fold blue, check/call green, bet/raise red). */
export function actionColor(action: string): string {
  if (action === 'fold') return 'bg-fold/15 text-fold border-fold/30'
  if (action === 'check' || action === 'call') return 'bg-call/15 text-call border-call/30'
  return 'bg-raise/15 text-raise border-raise/30'
}
