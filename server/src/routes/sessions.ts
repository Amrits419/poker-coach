import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma'
import { parseFile, splitHands } from '../lib/hh/pokerstars'
import { isPokerNowCsv, pokerNowHeroCandidates, pokerNowToPokerStars } from '../lib/hh/pokernow'
import { mapHand } from '../lib/hh/mapper'
import { startGrading } from '../lib/session/grader'
import { summarize } from '../lib/session/summary'
import { reconstruct, resolveCaptureDir } from '../lib/vision/capture'

const router = Router()

/** Names that appear in "Dealt to X [..]" lines, most frequent first. */
function heroCandidates(text: string): string[] {
  const counts: Record<string, number> = {}
  for (const m of text.matchAll(/^Dealt to (.+?) \[/gm)) counts[m[1]] = (counts[m[1]] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n]) => n)
}

// Preview a file before importing: hand count and who the hero might be
router.post('/preview', (req: Request, res: Response) => {
  const text = String(req.body?.text ?? '')
  if (isPokerNowCsv(text)) {
    res.json({ format: 'PokerNow log', hands: pokerNowToPokerStars(text).hands.length, heroCandidates: pokerNowHeroCandidates(text) })
    return
  }
  res.json({ format: 'PokerStars format', hands: splitHands(text).length, heroCandidates: heroCandidates(text) })
})

// Import a PokerStars-format hand-history file and start grading it
router.post('/import', async (req: Request, res: Response) => {
  const { userId, text, name } = req.body as { userId?: string; text?: string; name?: string }
  let heroName = (req.body?.heroName as string | undefined)?.trim()
  if (!userId || !text) { res.status(400).json({ error: 'userId and text are required' }); return }
  if (isPokerNowCsv(text)) {
    heroName ||= pokerNowHeroCandidates(text)[0]
    const converted = pokerNowToPokerStars(text, heroName)
    const result = await createSession({ userId, text: converted.hands.join('\n\n\n'), heroName: heroName ?? '', name, source: 'pokernow_log' })
    if ('error' in result) { res.status(400).json(result); return }
    res.json(result); return
  }
  heroName ||= heroCandidates(text)[0]
  if (!heroName) { res.status(400).json({ error: 'No "Dealt to" lines found, so the hero is unknown. Pass heroName.' }); return }
  const result = await createSession({ userId, text, heroName, name, source: 'pokerstars_import' })
  if ('error' in result) { res.status(400).json(result); return }
  res.json(result)
})

// A PokerRecorder screen capture, after the session ended and its frames were read
router.post('/capture', async (req: Request, res: Response) => {
  const { userId, dir } = req.body as { userId?: string; dir?: string }
  if (!userId || !dir) { res.status(400).json({ error: 'userId and dir are required' }); return }
  let real: string
  try { real = resolveCaptureDir(dir) } catch (e) { res.status(400).json({ error: (e as Error).message }); return }
  const existing = await prisma.session.findFirst({ where: { userId, captureDir: real } })
  if (existing) { res.json({ session: existing, parseErrors: 0 }); return }

  const cap = reconstruct(real)
  const site = cap.source === 'pokernow_log' ? 'PokerNow' : 'Screen-read table'
  const name = `${site === 'PokerNow' ? 'PokerNow' : 'Recorded'} session ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  if (!cap.hands.length) {
    try {
      const session = await prisma.session.create({
        data: { userId, name, source: 'screen_capture', site, heroName: 'Hero', status: 'needs_calibration',
                captureDir: real, captureInfo: cap.info as object, handsTotal: 0 },
      })
      res.json({ session, parseErrors: 0 })
    } catch {
      // Two requests for the same recording raced; the unique index kept one
      res.json({ session: await prisma.session.findFirst({ where: { userId, captureDir: real } }), parseErrors: 0 })
    }
    return
  }
  const result = await createSession({ userId, text: cap.hands.join('\n\n\n'), heroName: cap.heroName, name, source: cap.source === 'pokernow_log' ? 'pokernow_log' : 'screen_capture', captureDir: real, captureInfo: cap.info })
  if ('error' in result) { res.status(400).json(result); return }
  res.json(result)
})

async function createSession(o: { userId: string; text: string; heroName: string; name?: string; source: string; captureDir?: string; captureInfo?: object }) {
  const { userId, text, heroName, name } = o
  const { hands, errors } = parseFile(text, heroName)
  if (!hands.length) return { error: 'No hands could be parsed.', errors: errors.slice(0, 5) }

  const first = hands[0]
  const session = await prisma.session.create({
    data: {
      userId, heroName, source: o.source, status: 'grading', captureDir: o.captureDir, captureInfo: o.captureInfo,
      name: name?.trim() || `${first.site} session ${first.startedAt?.slice(0, 10) ?? ''}`.trim(),
      site: first.site,
      stakes: `${first.smallBlind}/${first.bigBlind}${first.currency ? ` ${first.currency}` : ''}`,
      startedAt: first.startedAt ? new Date(first.startedAt.replace(/\//g, '-')) : null,
      handsTotal: hands.length,
    },
  })
  await prisma.recordedHand.createMany({
    data: hands.map((h, seq) => {
      const m = mapHand(h)
      return {
        sessionId: session.id, seq, externalId: h.id, hhText: h.raw,
        heroPosition: m.heroPosition ?? null, heroCards: h.heroCards ?? null, board: h.board,
        playersDealt: m.playersDealt, heroVoluntary: m.heroVoluntary, heroPfr: m.heroPfr,
        sawFlop: m.sawFlop, netBb: m.netBb, gradeMode: m.gradeMode, gradeNote: m.gradeNote || null,
        startState: (m.startState as object) ?? undefined,
      }
    }),
  })
  startGrading(session.id)
  return { session, parseErrors: errors.length }
}

router.get('/', async (req: Request, res: Response) => {
  const userId = String(req.query.userId ?? '')
  if (!userId) { res.status(400).json({ error: 'userId required' }); return }
  const sessions = await prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
  res.json(sessions)
})

// One hand in full (analysis, grading details, raw text)
router.get('/hands/:handId', async (req: Request, res: Response) => {
  const hand = await prisma.recordedHand.findUnique({ where: { id: String(req.params.handId) } })
  if (!hand) { res.status(404).json({ error: 'Hand not found' }); return }
  res.json(hand)
})

router.get('/:id', async (req: Request, res: Response) => {
  const session = await prisma.session.findUnique({ where: { id: String(req.params.id) } })
  if (!session) { res.status(404).json({ error: 'Session not found' }); return }
  const hands = await prisma.recordedHand.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } })
  res.json({
    session,
    summary: summarize(hands),
    hands: hands.map(h => ({
      id: h.id, seq: h.seq, heroPosition: h.heroPosition, heroCards: h.heroCards, board: h.board,
      playersDealt: h.playersDealt, heroVoluntary: h.heroVoluntary, sawFlop: h.sawFlop, netBb: h.netBb,
      gradeMode: h.gradeMode, score: h.score, mistakes: h.mistakes, leaks: h.leaks,
      graded: !!h.gradedAt, error: h.error,
      summary: (h.analysis as { summary?: string } | null)?.summary ?? null,
    })),
  })
})

router.post('/:id/regrade', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  // Optional ?modes=solver_llm,llm_only to re-grade only some hands
  const modes = typeof req.query.modes === 'string' ? req.query.modes.split(',') : null
  const where = { sessionId: id, ...(modes ? { gradeMode: { in: modes } } : {}) }
  await prisma.recordedHand.updateMany({ where, data: { gradedAt: null, error: null } })
  const handsGraded = await prisma.recordedHand.count({ where: { sessionId: id, gradedAt: { not: null } } })
  await prisma.session.update({ where: { id }, data: { status: 'grading', handsGraded, error: null } })
  startGrading(id)
  res.json({ ok: true })
})

router.delete('/:id', async (req: Request, res: Response) => {
  await prisma.session.delete({ where: { id: String(req.params.id) } }).catch(() => null)
  res.json({ ok: true })
})

export default router
