import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { startHand, getVillainAction, analyzeHand, Setup, HandHistoryEntry } from '../lib/openai'
import { presolveFlop } from '../lib/solver'
import { getVillainPreflopFrequencies } from '../lib/ranges'
import type { StartState } from '../lib/types'

const router = Router()

// Compute pot/stack deterministically — don't trust LLM math
function calcPot(
  pot: number,
  effectiveStack: number,
  history: HandHistoryEntry[],
  currentStreet: string,
  villainAction: string,
  villainAmount: number | undefined
): { newPot: number; newStack: number } {
  const rev = [...history].reverse()
  const heroAct  = rev.find(h => h.actor === 'hero'    && h.street === currentStreet)
  const prevVill = rev.find(h => h.actor === 'villain'  && h.street === currentStreet)

  // Hero's raise/bet this action (calls tracked separately below)
  const heroRaise = (heroAct?.action === 'raise' || heroAct?.action === 'bet')
    ? (heroAct.amount ?? 0) : 0

  // If hero called villain's bet, the call amount equals villain's prior bet
  const heroCall = heroAct?.action === 'call' ? (prevVill?.amount ?? 0) : 0

  // On preflop BB's first action, BB already has 1bb in the pot
  const villainActedBefore = history.some(h => h.actor === 'villain' && h.street === currentStreet)
  const bbAlreadyIn = (currentStreet === 'Preflop' && !villainActedBefore) ? 1 : 0

  let newPot   = pot + heroRaise + heroCall
  let newStack = effectiveStack - heroRaise - heroCall

  if (villainAction === 'call' && heroRaise > 0) {
    newPot += Math.max(0, heroRaise - bbAlreadyIn)
  } else if ((villainAction === 'bet' || villainAction === 'raise') && villainAmount) {
    newPot += villainAmount
    // hero hasn't responded yet — stack stays as-is after hero's own bet
  }

  return {
    newPot:   Math.round(newPot   * 10) / 10,
    newStack: Math.round(Math.max(0, newStack) * 10) / 10,
  }
}

// start a new hand — returns hole cards, board, preflop context
router.post('/start', async (req: Request, res: Response) => {
  const { userId, setup } = req.body as { userId: string; setup: Setup }

  if (!userId || !setup) {
    res.status(400).json({ error: 'userId and setup required' })
    return
  }

  const state = await startHand(setup)
  res.json(state)
  predictAndPresolve(setup, state)
})

// Speculatively solve the flop while the user is still thinking preflop. Only
// when the line is predictable: heads-up, and either hero faces a raise (we
// assume a call) or hero opens 2.5bb (the client default) into a villain whose
// range-table response is certain. A wrong guess costs nothing but CPU; a right
// one hides most of the flop solve behind the preflop decision.
function predictAndPresolve(setup: Setup, state: StartState | null) {
  if (!state || state.villainPositions.length !== 1) return
  const villainPos = state.villainPositions[0]
  const heroBlind  = setup.position === 'BB' ? 1.0 : setup.position === 'SB' ? 0.5 : 0
  if (!state.heroIsPFR) {
    // Hero calls the raise in front of them
    const call = state.preflopRaiseAmount ?? 0
    if (!call) return
    const pot   = Math.round((state.pot + call) * 10) / 10
    const stack = Math.max(0, Math.round((state.effectiveStack - Math.max(0, call - heroBlind)) * 10) / 10)
    presolveFlop(setup, state, pot, stack)
    return
  }
  const OPEN = 2.5
  const { aggrFreq, callFreq } = getVillainPreflopFrequencies(villainPos, state.villainHoleCards[0] ?? '', setup.position, true)
  if (aggrFreq > 0 || callFreq <= 0) return   // villain might 3-bet or will fold: unpredictable / no flop
  // Same arithmetic as calcPot(): villain's call adds (open - 1bb already posted)
  const pot   = Math.round((state.pot + OPEN + Math.max(0, OPEN - 1)) * 10) / 10
  const stack = Math.max(0, Math.round((state.effectiveStack - OPEN) * 10) / 10)
  presolveFlop(setup, state, pot, stack)
}

// get villain's GTO response to the current situation
router.post('/villain-act', async (req: Request, res: Response) => {
  const { setup, startState, history, currentStreet, currentBoard, pot, effectiveStack, actingVillainIndex } = req.body
  const villainIndex: number = typeof actingVillainIndex === 'number' ? actingVillainIndex : 0

  if (!setup || !startState || !currentStreet) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const response = await getVillainAction(
    setup, startState, history ?? [], currentStreet, currentBoard ?? [], pot, effectiveStack, villainIndex
  )

  // Override AI's pot/stack — LLMs are unreliable at arithmetic
  const { newPot, newStack } = calcPot(pot, effectiveStack, history ?? [], currentStreet, response.action, response.amount)
  response.newPot   = newPot
  response.newStack = newStack

  res.json(response)

  // Preflop just closed with a call: start the flop solve now, before the client
  // has even animated the flop. Useful when hero is first to act on the flop.
  if (currentStreet === 'Preflop' && response.action === 'call' && startState.villainPositions?.length === 1) {
    presolveFlop(setup, startState, newPot, newStack)
  }
})

// analyze the completed hand and save it
router.post('/analyze', async (req: Request, res: Response) => {
  const { userId, setup, startState, history } = req.body as {
    userId: string
    setup: Setup
    startState: unknown
    history: HandHistoryEntry[]
  }

  if (!userId || !setup || !startState || !history) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  try {
    const analysis = await analyzeHand(setup, startState as any, history)

    // Return analysis immediately — don't block on DB save
    res.json({ analysis })

    prisma.trainerHand.create({
      data: {
        userId,
        setup: setup as any,
        scenario: startState as any,
        userActions: history as any,
        analysis: analysis as any,
        leaks: analysis.leaks,
      },
    }).catch(err => console.error('DB save failed (non-fatal):', err))
  } catch (err) {
    console.error('Analysis failed:', err)
    res.status(500).json({ error: 'Analysis failed', detail: String(err) })
  }
})

router.get('/history/:userId', async (req: Request, res: Response) => {
  const userId = String(req.params.userId)
  const hands = await prisma.trainerHand.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  res.json(hands)
})

router.get('/leaks/:userId', async (req: Request, res: Response) => {
  const userId = String(req.params.userId)
  const hands = await prisma.trainerHand.findMany({
    where: { userId },
    select: { leaks: true },
  })

  const leakCounts: Record<string, number> = {}
  for (const hand of hands) {
    for (const leak of hand.leaks) {
      leakCounts[leak] = (leakCounts[leak] || 0) + 1
    }
  }

  res.json(
    Object.entries(leakCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([leak, count]) => ({ leak, count }))
  )
})

export default router
