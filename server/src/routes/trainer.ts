import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { startHand, getVillainAction, analyzeHand, Setup, HandHistoryEntry } from '../lib/openai'

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
})

// get villain's GTO response to the current situation
router.post('/villain-act', async (req: Request, res: Response) => {
  const { setup, startState, history, currentStreet, currentBoard, pot, effectiveStack } = req.body

  if (!setup || !startState || !currentStreet) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const response = await getVillainAction(
    setup, startState, history ?? [], currentStreet, currentBoard ?? [], pot, effectiveStack
  )

  // Override AI's pot/stack — LLMs are unreliable at arithmetic
  const { newPot, newStack } = calcPot(pot, effectiveStack, history ?? [], currentStreet, response.action, response.amount)
  response.newPot   = newPot
  response.newStack = newStack

  res.json(response)
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

  const analysis = await analyzeHand(setup, startState as any, history)

  await prisma.trainerHand.create({
    data: {
      userId,
      setup: setup as any,
      scenario: startState as any,
      userActions: history as any,
      analysis: analysis as any,
      leaks: analysis.leaks,
    },
  })

  res.json({ analysis })
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
