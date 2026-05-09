import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { analyzeHand, HandInput } from '../lib/openai'

const router = Router()

// submit a hand and get back GPT analysis
router.post('/', async (req: Request, res: Response) => {
  const { userId, position, holeCards, board, actions, potSize, stackSize } =
    req.body as HandInput & { userId: string }

  if (!userId || !position || !holeCards || !actions || !potSize || !stackSize) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const analysis = await analyzeHand({ position, holeCards, board, actions, potSize, stackSize })

  const hand = await prisma.hand.create({
    data: {
      userId,
      position,
      holeCards,
      board: board || '',
      actions,
      potSize,
      stackSize,
      analysis,
      leaks: analysis.leaks,
    },
  })

  res.json({ hand, analysis })
})

router.get('/user/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params

  const hands = await prisma.hand.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })

  res.json(hands)
})

// aggregate leaks across all hands for a user and sort by frequency
router.get('/leaks/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params

  const hands = await prisma.hand.findMany({
    where: { userId },
    select: { leaks: true },
  })

  const leakCounts: Record<string, number> = {}
  for (const hand of hands) {
    for (const leak of hand.leaks) {
      leakCounts[leak] = (leakCounts[leak] || 0) + 1
    }
  }

  const sorted = Object.entries(leakCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([leak, count]) => ({ leak, count }))

  res.json(sorted)
})

export default router
