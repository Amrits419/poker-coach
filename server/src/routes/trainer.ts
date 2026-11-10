import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { startHand, getVillainAction, analyzeHand, villainCertainlyCalls, Setup, HandHistoryEntry } from '../lib/openai'
import { presolveFlop, explainVillainAction, plainDescription, type ExplainContext } from '../lib/solver'
import { replay, tableView, optionsFor, type HandState } from '../lib/engine'
import type { StartState } from '../lib/types'

const router = Router()

// The server is the single source of truth for the state of a hand: the client
// sends the deal and the action history, and every number it shows (pot, stacks,
// who acts, what a call costs) comes back from the engine's replay.

// start a new hand — returns the deal and the table as hero first sees it
router.post('/start', async (req: Request, res: Response) => {
  const { userId, setup } = req.body as { userId: string; setup: Setup }

  if (!userId || !setup) {
    res.status(400).json({ error: 'userId and setup required' })
    return
  }

  try {
    const startState = await startHand(setup)
    res.json({ startState, table: tableView(replay(setup, startState, []), startState) })
    predictAndPresolve(setup, startState)
  } catch (err) {
    console.error('Could not deal a hand:', err)
    res.status(500).json({ error: 'Could not deal a hand' })
  }
})

// Speculatively solve the flop while the user is still thinking preflop. Only
// when the line is predictable: heads-up, and either hero faces a raise (we
// assume a call) or hero opens 2.5bb (the client default) into a villain whose
// range-table response is certainly a call. A wrong guess costs nothing but CPU;
// a right one hides most of the flop solve behind the preflop decision. The
// guess goes through the same replay as real play, so it lands on the same
// solver cache entry.
function predictAndPresolve(setup: Setup, startState: StartState) {
  if (startState.villainPositions.length !== 1) return
  const first = replay(setup, startState, [])
  const o = optionsFor(first, 'hero')
  const guess: HandHistoryEntry[] = []
  if (first.raisers.length > 0) {
    guess.push({ street: 'Preflop', actor: 'hero', action: 'call', amount: o.toCall })
  } else {
    guess.push({ street: 'Preflop', actor: 'hero', action: 'raise', amount: 2.5 })
    const afterOpen = replay(setup, startState, guess)
    if (afterOpen.toAct !== 0 || !villainCertainlyCalls(startState, afterOpen, 0)) return
    guess.push({ street: 'Preflop', actor: 'villain', action: 'call', amount: 2.5, villainIdx: 0 })
  }
  presolveIfFlopJustDealt(setup, startState, guess, replay(setup, startState, guess))
}

// Preflop just closed: start the flop solve now, before anyone has to act on it.
function presolveIfFlopJustDealt(setup: Setup, startState: StartState, history: HandHistoryEntry[], state: HandState) {
  if (state.street === 'Flop' && !state.over && !history.some(h => h.street === 'Flop')) {
    presolveFlop(setup, startState, state)
  }
}

interface HandBody { setup?: Setup; startState?: StartState; history?: HandHistoryEntry[] }

// the table after the given history — called once hero has acted
router.post('/table', (req: Request, res: Response) => {
  const { setup, startState, history = [] } = req.body as HandBody
  if (!setup || !startState) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  const state = replay(setup, startState, history)
  res.json({ table: tableView(state, startState) })
  presolveIfFlopJustDealt(setup, startState, history, state)
})

// the next villain's action — the client calls this while the table says a villain is to act
router.post('/villain-act', async (req: Request, res: Response) => {
  const { setup, startState, history = [] } = req.body as HandBody
  if (!setup || !startState) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const state = replay(setup, startState, history)
  if (state.over || typeof state.toAct !== 'number') {
    res.status(409).json({ error: 'No villain is to act', table: tableView(state, startState) })
    return
  }
  const villainIdx = state.toAct

  try {
    const decision = await getVillainAction(setup, startState, history, state, villainIdx)
    const entry: HandHistoryEntry = {
      street: state.street, actor: 'villain', action: decision.action, amount: decision.amount, villainIdx,
    }
    const newHistory = [...history, entry]
    const next = replay(setup, startState, newHistory)
    res.json({
      entry,
      history: newHistory,
      description: decision.description,
      explain: decision.explain ?? null,
      table: tableView(next, startState),
    })
    presolveIfFlopJustDealt(setup, startState, newHistory, next)
  } catch (err) {
    console.error('Villain action failed:', err)
    res.status(502).json({ error: 'Villain action failed', detail: String((err as Error)?.message ?? err) })
  }
})

// why the solver's villain did what it did — fetched in the background during play
router.post('/explain', async (req: Request, res: Response) => {
  const ctx = (req.body as { explain?: ExplainContext }).explain
  if (!ctx?.villainPosition || !ctx.action || !Array.isArray(ctx.frequencies) || !Array.isArray(ctx.board)) {
    res.status(400).json({ error: 'explain context required' })
    return
  }
  try {
    res.json({ description: await explainVillainAction(ctx) })
  } catch (err) {
    console.warn('Explanation failed, using the plain description:', (err as Error)?.message ?? err)
    res.json({ description: plainDescription(ctx.villainPosition, ctx.action, ctx.amount) })
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
    const analysis = await analyzeHand(setup, startState as StartState, history)

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
