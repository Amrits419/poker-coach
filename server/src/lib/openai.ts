import OpenAI from 'openai'
import { dealFromDeck } from './cards'

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
})

export interface Setup {
  position: string
  isMultiway: boolean
  stackDepth: string
}

export interface HandHistoryEntry {
  street: string
  actor: 'hero' | 'villain'
  action: string
  amount?: number
}

export interface StartState {
  holeCards: string
  villainHoleCards: string[]
  villainPositions: string[]
  board: { flop: string[]; turn: string; river: string }
  heroIsIP: boolean
  preflopContext: string
  pot: number
  effectiveStack: number
}

export interface VillainResponse {
  action: string
  amount?: number
  description: string
  potOdds: string | null
  newPot: number
  newStack: number
  isHandOver: boolean
}

export interface Analysis {
  summary: string
  streetFeedback: {
    street: string
    heroAction: string
    correct: string
    explanation: string
    betterPlay: string
  }[]
  leaks: string[]
  score: number
  studyPlan: string[]
}

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

POSTFLOP STEP 1 — Opening action on a new street:
- Evaluate your actual hand strength on this board (pair, draw, air, etc.)
- If hero is IP and you are first to act: default to CHECK on boards where hero's range is stronger (A-high, K-high, Q-high). Only donk if you have a strong made hand or draw AND the board heavily favors your range.
- If you are IP: bet when you have value or a strong draw; check back marginal hands.

POSTFLOP STEP 2 — Responding to hero's bet/raise:
First calculate your actual equity with your specific hole cards on this board:
- FOLD if you have <15% equity or no clean outs (no pair, no draw, no backdoor that matters). On an A-high or K-high board, hands like 9T with no flush draw or straight draw have near-zero equity — FOLD.
- CALL if you have a flush draw (8+ outs), open-ended straight draw (8 outs), top pair decent kicker, or second pair with a draw. Verify pot odds: need equity > bet/(pot+bet).
- RAISE if you have two pair, a set, trips, a strong combo draw (flush draw + pair or OESD), or the nuts. Raise to 2.5-3x hero's bet.
Be honest about your hand — do not call with air just to "play GTO".

Return JSON only:
{
  "action": "check|bet|raise|call|fold",
  "amount": <bb if bet/raise, otherwise null>,
  "description": "e.g. 'BB bets 6bb (1/3 pot)' or 'BB checks'",
  "potOdds": "e.g. '3.2:1' if hero faces a bet, null if villain checks or folds",
  "newPot": <pot after this action>,
  "newStack": <effective stack after this action>,
  "isHandOver": <true only if villain folds or goes all-in with no decision needed>
}`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  })

  const data = JSON.parse(res.choices[0].message.content ?? '{}')
  return {
    action: data.action ?? 'check',
    amount: data.amount ?? undefined,
    description: data.description ?? 'Villain checks',
    potOdds: data.potOdds ?? null,
    newPot: data.newPot ?? pot,
    newStack: data.newStack ?? effectiveStack,
    isHandOver: data.isHandOver ?? false,
  }
}

export async function analyzeHand(
  setup: Setup,
  startState: StartState,
  history: HandHistoryEntry[]
): Promise<Analysis> {
  const heroActions = history.filter(h => h.actor === 'hero')
  const fullHistory = history
    .map(h => `${h.street} - ${h.actor === 'hero' ? 'Hero' : 'Villain'}: ${h.action}${h.amount ? ` ${h.amount}bb` : ''}`)
    .join('\n')

  const villainHandDesc = startState.villainPositions
    .map((pos, i) => `${pos}: ${startState.villainHoleCards?.[i] ?? '??'}`)
    .join(', ')

  const boardStr = `Flop: ${startState.board.flop.join(' ')} | Turn: ${startState.board.turn} | River: ${startState.board.river}`

  const prompt = `You are an expert NLHE poker coach. Analyze this hand with surgical precision — no generic solver-speak.

Context:
- Hero: ${setup.position}, hole cards: ${startState.holeCards}, stack: ${setup.stackDepth}
- Villain(s): ${startState.villainPositions.join(', ')}, hole cards: ${villainHandDesc}
- Board: ${boardStr}
- Hero is ${startState.heroIsIP ? 'IN POSITION (IP)' : 'OUT OF POSITION (OOP)'} post-flop
- ${setup.isMultiway ? 'Multiway pot' : 'Heads-up pot'}

Full hand history (hero and villain actions):
${fullHistory}

IMPORTANT: Use ONLY the board listed above. Do not invent or assume a different board.

STRICT RULES for your analysis — violating these makes the feedback useless:

1. POSITION MATTERS FOR EVERY JUDGMENT
   - 3-bet sizing OOP vs IP is different. A 12bb 3-bet OOP vs a large open can be correct.
   - Calling IP with weak holdings is better than calling OOP because of the informational advantage.
   - Never call a play wrong without specifying whether hero is IP or OOP.

2. HAND STRENGTH IN CONTEXT — not in isolation
   - AK is a standard 3-bet from any position. Do not call it questionable.
   - But AK on a 872 board with no draw is not a strong hand — evaluate equity vs the board, not the hand name.
   - Overcards alone are not strong equity. Name what equity hero actually has (pair outs, backdoor draws, etc.)

3. NO GENERIC BALANCE ADVICE
   - Do not say "call to stay balanced" or "fold disrupts your range" unless there is a concrete reason.
   - At most depths under 150bb, specific hand EV matters more than balance.
   - If hero should fold, say WHY: board favors villain, villain is not bluffing enough, hero has no equity, pot odds are wrong.

4. POT ODDS MUST BE CHECKED
   - If hero calls, verify: does hero have enough equity to justify the call?
   - State the required equity to call and estimate hero's actual equity vs villain's range given the action.

5. SIZING JUDGMENT
   - 3-bet to 12bb: only flag as too big if opener was small AND hero is IP. OOP can go bigger.
   - C-bet sizing: 1/3 pot on dry boards, 50-75% on wet boards is standard. Deviate only if SPR demands it.

6. WHEN FOLDING IS FINE
   - If villain is repping a strong range (heavy barrel, polarized river shove), folding is GTO even with decent equity.
   - Do not penalize a fold unless you can show hero had clearly enough equity to continue.

7. DO NOT REVEAL HERO'S HOLE CARDS IN EXPLANATIONS
   - Never write "hero has QcKd" or "with QK" or any specific card names in the explanation or betterPlay fields.
   - Refer to hand strength only in abstract terms: "top pair", "two pair", "flush draw", "overpair", "air", etc.
   - The player already knows their own cards — naming them adds no value and breaks immersion.

Evaluate only streets where hero made a decision. Skip streets where only villain acted.

Return JSON only:
{
  "summary": "2-3 sentence verdict grounded in position, equity, and villain's line — no fluff",
  "streetFeedback": [
    {
      "street": "Preflop|Flop|Turn|River",
      "heroAction": "exactly what hero did with sizing",
      "correct": "yes|close|no",
      "explanation": "specific reasoning: name the board, name hero's equity, name villain's range, explain the math",
      "betterPlay": "concrete alternative with sizing — only include if correct is close or no"
    }
  ],
  "leaks": ["specific leak label tied to this hand e.g. 'Oversizing 3-bets IP vs small opens'"],
  "score": <0-100, where 70+ means solid play with minor issues>,
  "studyPlan": [
    "concrete study topic tied to a mistake in this hand",
    "second item",
    "third item"
  ]
}`

  const res = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  })

  return JSON.parse(res.choices[0].message.content ?? '{}') as Analysis
}
