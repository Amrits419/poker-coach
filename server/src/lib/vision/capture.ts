import { existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { pokerNowHeroCandidates, pokerNowToPokerStars } from '../hh/pokernow'

// Reads a PokerRecorder session folder and turns it into PokerStars-format hand text for
// the normal importer. The folder holds a text log, never screenshots:
//   table.jsonl        one line per table change: text Vision read (+ position, ink colour)
//                      and card regions with a 10×14 corner fingerprint
//   pokernow_log.csv   PokerNow's own game log, if one was downloaded during the session
//
// PokerNow logs are exact and are used whenever present. Screen-read sessions (ClubGG and
// others) need a one-time calibration (seat regions + card fingerprints → ranks/suits)
// before hands can be rebuilt; until then reconstruct() returns no hands and the session is
// stored as "needs_calibration" with what was captured.

export const CAPTURE_ROOT = join(homedir(), 'Library', 'Application Support', 'PokerRecorder', 'sessions')

export interface OcrBox { s: string; c: number; x: number; y: number; w: number; h: number; rgb: [number, number, number] }
export interface CardRegion { x: number; y: number; w: number; h: number; sig: string; rgb: [number, number, number] }
export interface OcrFrame { i?: number; t: number; w: number; h: number; boxes: OcrBox[]; cards?: CardRegion[] }

export interface CaptureResult {
  hands: string[]                // PokerStars-format hand texts
  heroName: string
  source: 'pokernow_log' | 'screen'
  info: {
    frames: number
    cardRegions: number
    durationMin: number
    window: { w: number; h: number } | null
    textBoxes: number
    amountsSeen: number          // numbers that look like chip amounts
    calibrated: boolean
    message: string
  }
}

/** Resolve and validate a capture folder: it must live under the recorder's sessions root. */
export function resolveCaptureDir(dir: string): string {
  const abs = resolve(dir)
  const root = existsSync(CAPTURE_ROOT) ? realpathSync(CAPTURE_ROOT) : CAPTURE_ROOT
  const real = existsSync(abs) ? realpathSync(abs) : abs
  if (!real.startsWith(root + '/')) throw new Error('Capture folder must be inside the PokerRecorder sessions folder.')
  if (!['table.jsonl', 'ocr.jsonl', 'pokernow_log.csv'].some(f => existsSync(join(real, f)))) throw new Error('This session folder has no table log yet. End the session in Poker Recorder first.')
  return real
}

export function loadFrames(dir: string): OcrFrame[] {
  const file = ['table.jsonl', 'ocr.jsonl'].map(f => join(dir, f)).find(existsSync)
  if (!file) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as OcrFrame)
}

const CALIBRATION_FILE = join(CAPTURE_ROOT, '..', 'calibration.json')

export function reconstruct(dir: string): CaptureResult {
  const frames = loadFrames(dir)
  const cardRegions = frames.reduce((s, f) => s + (f.cards?.length ?? 0), 0)
  const pnLog = join(dir, 'pokernow_log.csv')
  if (existsSync(pnLog)) {
    const text = readFileSync(pnLog, 'utf8')
    const heroName = pokerNowHeroCandidates(text)[0] ?? ''
    const { hands } = pokerNowToPokerStars(text, heroName)
    return {
      hands, heroName, source: 'pokernow_log',
      info: { frames: frames.length, cardRegions, durationMin: 0, window: null, textBoxes: 0, amountsSeen: 0, calibrated: true,
              message: `Graded from PokerNow's own game log (${hands.length} hands).` },
    }
  }
  const first = frames[0], last = frames[frames.length - 1]
  const textBoxes = frames.reduce((s, f) => s + f.boxes.length, 0)
  const amountsSeen = frames.reduce((s, f) => s + f.boxes.filter(b => /^\$?\d+(\.\d+)?\s*(bb|BB)?$/.test(b.s.trim())).length, 0)
  const calibrated = existsSync(CALIBRATION_FILE)
  return {
    hands: [], heroName: 'Hero', source: 'screen',
    info: {
      frames: frames.length, cardRegions,
      durationMin: first && last ? Math.round((last.t - first.t) / 60000) : 0,
      window: first ? { w: first.w, h: first.h } : null,
      textBoxes, amountsSeen, calibrated,
      message: calibrated
        ? 'A calibration exists but the ClubGG hand reader has not been built yet.'
        : 'Table log saved (text only, no screenshots). Rebuilding hands from a screen-read table needs a one-time calibration from a real session like this one: which seat is where and which card fingerprint is which rank and suit. For PokerNow, download the game log during the session and it is used instead.',
    },
  }
}
