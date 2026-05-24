import OpenAI from 'openai'
import { dealFromDeck } from './cards'
import {
  getVillainActionFromSolver,
  evalHeroDecision,
  type HeroEval,
} from './solver'
import type { Setup, StartState, HandHistoryEntry, VillainResponse, Analysis } from './types'

export type { Setup, StartState, HandHistoryEntry, VillainResponse, Analysis }

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
})

const IP_POSITIONS = new Set(['CO', 'BTN', 'HJ'])

function pickVillainPositions(heroPos: string, count: number): string[] {
  const all = ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']
  const others = all.filter(p => p !== heroPos).sort(() => Math.random() - 0.5)
  // always involve BB in at least one spot
  const withBB = others.includes('BB')
    ? ['BB', ...others.filter(p => p !== 'BB')]
    : others
  return withBB.slice(0, count)
}

export async function startHand(setup: Setup): Promise<StartState> {
  const villainPositions = pickVillainPositions(setup.position, setup.isMultiway ? 2 : 1)
  const heroIsIP = IP_POSITIONS.has(setup.position)

  const { heroCards: holeCards, villainCards: villainHoleCards, board } = dealFromDeck(villainPositions.length)

  // figure out what happened preflop to reach hero's first decision
  const prompt = `You are a GTO NLHE poker engine. Generate the preflop action sequence up to the point where hero must make their first decision.

Hero: ${setup.position} with ${holeCards}, ${setup.stackDepth} effective
Villain(s): ${villainPositions.join(', ')}

Rules:
- Use realistic GTO opening frequencies for each position
- If hero is first to act (e.g. UTG), they haven't opened yet — describe that they are first to act
- If there's action before hero, summarize it (e.g. "CO opens 2.5bb, folds to you on BTN")
- If villain 3-bets hero's open, describe that (e.g. "You open 2.5bb, BB 3-bets to 8bb")
- Pot and stack must be mathematically accurate

Return JSON only:
{
  "context": "1-2 sentence description of the preflop situation hero is facing",
  "pot": <bb already in the pot BEFORE hero acts — blinds + any prior raises only, do NOT include hero's own bet>,
  "effectiveStack": <bb hero has behind BEFORE their decision>
}

Pot examples (must be exact):
- Hero opens with no prior action (BTN, CO, HJ, etc.): pot = 1.5 (SB 0.5 + BB 1.0 only)
- Hero in BB facing a BTN open of 2.5bb, SB folded: pot = 3.0 (BTN 2.5 + SB dead 0.5)
- Hero on BTN facing a CO open of 2.5bb: pot = 4.0 (CO 2.5 + SB 0.5 + BB 1.0)
- Hero facing a 3-bet of 9bb after opening 2.5bb: pot = 12.0 (hero's 2.5 + 3-bettor's 9 + dead 0.5)`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.6,
  })

  const data = JSON.parse(res.choices[0].message.content ?? '{}')

  return {
    holeCards,
    villainHoleCards,
    villainPositions,
    board,
    heroIsIP,
    preflopContext: data.context ?? `You're in ${setup.position} with ${holeCards}.`,
    pot: data.pot ?? 1.5,
    effectiveStack: data.effectiveStack ?? parseFloat(setup.stackDepth),
  }
}

export async function getVillainAction(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  currentBoard: string[],
  pot: number,
  effectiveStack: number
): Promise<VillainResponse> {
  // Preflop: LLM handles the full decision (3-bet frequencies, sizings, etc.)
  if (currentStreet === 'Preflop') {
    return getVillainActionLLM(setup, startState, history, currentStreet, currentBoard, pot, effectiveStack)
  }

  // Postflop: solver computes GTO frequencies, LLM explains the chosen action
  try {
    return await getVillainActionFromSolver(setup, startState, history, currentStreet, pot, effectiveStack)
  } catch (err) {
    // Solver unavailable — fall back to LLM so the game still works
    console.warn('Solver unavailable, falling back to LLM:', err)
    return getVillainActionLLM(setup, startState, history, currentStreet, currentBoard, pot, effectiveStack)
  }
}

async function getVillainActionLLM(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  currentStreet: string,
  currentBoard: string[],
  pot: number,
  effectiveStack: number
): Promise<VillainResponse> {
  const historyText = history.length > 0
    ? history.map(h => `${h.street} - ${h.actor === 'hero' ? 'Hero' : 'Villain'}: ${h.action}${h.amount ? ` ${h.amount}bb` : ''}`).join('\n')
    : 'No previous action'

  const villainHandDesc = startState.villainPositions
    .map((pos, i) => `${pos}: ${startState.villainHoleCards[i] ?? '??'}`)
    .join(', ')

  const prompt = `You are a GTO NLHE poker AI playing as villain. Determine your optimal action.

Game state:
- Hero position: ${setup.position} — hero is ${startState.heroIsIP ? 'IN POSITION (IP)' : 'OUT OF POSITION (OOP)'} post-flop
- Villain position: ${startState.villainPositions.join(', ')}
- Villain hole cards (fixed — do NOT change): ${villainHandDesc}
- Stack depth: ${setup.stackDepth}
- Current street: ${currentStreet}
- Board: ${currentBoard.length > 0 ? currentBoard.join(' ') : 'none (preflop)'}
- Pot: ${pot}bb
- Effective stack: ${effectiveStack}bb

Hand history:
${historyText}

You have a SPECIFIC hand (listed above). Make every decision based on your actual hole cards and their equity on the current board — not range theory.

PREFLOP — If hero has just opened and you haven't acted yet:
You MUST consider 3-betting. GTO 3-bet frequency from BB vs a BTN/CO open is ~13-15%. Do not always call.
3-bet with these hand categories:
  VALUE 3-bets (always): QQ+, AK. These are mandatory 3-bets.
  LIGHT 3-bets (sometimes): JJ, TT, AQs, AJs, KQs, A5s, A4s, K5s, 76s, 65s — 3-bet these ~40-60% of the time as bluffs/semi-bluffs.
  CALL range: 99-22, KJo, QJs, suited connectors not in the 3-bet range.
  FOLD: weak offsuit hands with no equity vs a raise (72o, 83o, etc.)
3-bet sizing: 3x hero's open if IP, 3.5-4x if OOP. Example: hero opens 2.5bb → 3-bet to 9bb OOP or 7.5bb IP.
If your hand is in the VALUE or LIGHT category above, you MUST 3-bet — do not call instead.

Return JSON only:
{
  "action": "check|bet|raise|call|fold",
  "amount": <bb if bet/raise, otherwise null>,
  "description": "e.g. 'BB 3-bets to 9bb' or 'BB calls' — NEVER mention hole cards here",
  "potOdds": "e.g. '3.2:1' if hero faces a bet, null otherwise",
  "newPot": <pot after this action>,
  "newStack": <effective stack after this action>,
  "isHandOver": <true only if villain folds>
}`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  })

  const data = JSON.parse(res.choices[0].message.content ?? '{}')
  return {
    action:      data.action      ?? 'check',
    amount:      data.amount      ?? undefined,
    description: data.description ?? 'Villain checks',
    potOdds:     data.potOdds     ?? null,
    newPot:      data.newPot      ?? pot,
    newStack:    data.newStack    ?? effectiveStack,
    isHandOver:  data.isHandOver  ?? false,
  }
}

export async function analyzeHand(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[]
): Promise<Analysis> {
  // Collect solver evaluations for every postflop hero decision.
  // Run these in parallel to minimise latency.
  const heroPostflopDecisions = history
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => h.actor === 'hero' && h.street !== 'Preflop')

  let solverEvals: HeroEval[] = []
  if (heroPostflopDecisions.length > 0) {
    try {
      // Approximate pot/stack at each decision by replaying history
      solverEvals = await Promise.all(
        heroPostflopDecisions.map(({ h, idx }) => {
          const { pot, stack } = potStackAt(history, idx, startState.pot, startState.effectiveStack)
          return evalHeroDecision(setup, startState, history, h, idx, pot, stack)
        })
      )
    } catch (err) {
      console.warn('Solver unavailable for analysis, proceeding without solver data:', err)
    }
  }

  return analyzeHandWithLLM(setup, startState, history, solverEvals)
}

// Approximate pot and effective stack at position `idx` in history.
function potStackAt(
  history: HandHistoryEntry[],
  idx: number,
  startPot: number,
  startStack: number
): { pot: number; stack: number } {
  let pot = startPot
  let stack = startStack
  for (let i = 0; i < idx; i++) {
    const h = history[i]
    const amt = h.amount ?? 0
    if (h.action === 'bet' || h.action === 'raise') {
      pot += amt; stack = h.actor === 'hero' ? stack - amt : stack
    } else if (h.action === 'call') {
      pot += amt
    }
  }
  return { pot: Math.round(pot * 10) / 10, stack: Math.max(0, Math.round(stack * 10) / 10) }
}

async function analyzeHandWithLLM(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[],
  solverEvals: HeroEval[]
): Promise<Analysis> {
  const fullHistory = history
    .map(h => `${h.street} - ${h.actor === 'hero' ? 'Hero' : 'Villain'}: ${h.action}${h.amount ? ` ${h.amount}bb` : ''}`)
    .join('\n')

  const villainHandDesc = startState.villainPositions
    .map((pos, i) => `${pos}: ${startState.villainHoleCards?.[i] ?? '??'}`)
    .join(', ')

  const boardStr = `Flop: ${startState.board.flop.join(' ')} | Turn: ${startState.board.turn} | River: ${startState.board.river}`

  // Format solver evaluations so the LLM can reference exact GTO frequencies
  const solverBlock = solverEvals.length > 0
    ? `\nSOLVER GROUND TRUTH (use these as fact — do not contradict them):\n` +
      solverEvals.map(e => {
        const gto = e.gtoFrequencies
          .filter(a => a.frequency > 0.02)
          .map(a => `${a.action}${a.amount ? ` ${a.amount}bb` : ''} ${(a.frequency * 100).toFixed(0)}%`)
          .join(', ')
        const heroFreq = e.gtoFrequencies.find(a => a.action === e.heroAction)
        const heroGtoFreq = heroFreq ? (heroFreq.frequency * 100).toFixed(0) : '0'
        return `- ${e.street}: Hero ${e.heroAction}${e.heroAmount ? ` ${e.heroAmount}bb` : ''} (GTO frequency: ${heroGtoFreq}%). Full GTO mix: ${gto}. Hero equity: ${(e.heroEquity * 100).toFixed(0)}%.`
      }).join('\n')
    : ''

  const prompt = `You are an expert NLHE poker coach. Analyze this hand with surgical precision.

Context:
- Hero: ${setup.position}, hole cards: ${startState.holeCards}, stack: ${setup.stackDepth}
- Villain(s): ${startState.villainPositions.join(', ')}, hole cards: ${villainHandDesc}
- Board: ${boardStr}
- Hero is ${startState.heroIsIP ? 'IN POSITION (IP)' : 'OUT OF POSITION (OOP)'} post-flop
- ${setup.isMultiway ? 'Multiway pot' : 'Heads-up pot'}

Full hand history:
${fullHistory}
${solverBlock}

RULES:
1. For postflop streets with solver data: base your evaluation on the GTO frequencies above, not intuition.
   If GTO calls 80% and hero folded, that is clearly wrong — say so with the equity and pot odds math.
2. For preflop and streets without solver data: use standard GTO reasoning.
3. Never name hero's specific hole cards in explanation/betterPlay fields — use "top pair", "flush draw", etc.
4. Position matters: always specify IP vs OOP in your reasoning.
5. No generic balance advice — give concrete equity/pot-odds reasoning.

Evaluate only streets where hero made a decision.

Return JSON only:
{
  "summary": "2-3 sentence verdict grounded in position, equity, and the solver data",
  "streetFeedback": [
    {
      "street": "Preflop|Flop|Turn|River",
      "heroAction": "exactly what hero did with sizing",
      "correct": "yes|close|no",
      "explanation": "specific reasoning referencing solver frequencies, equity, pot odds where available",
      "betterPlay": "concrete alternative with sizing — only if correct is close or no"
    }
  ],
  "leaks": ["specific leak label tied to this hand"],
  "score": <0-100>,
  "studyPlan": ["concrete study topic", "second", "third"]
}`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  })

  return JSON.parse(res.choices[0].message.content ?? '{}') as Analysis
}
