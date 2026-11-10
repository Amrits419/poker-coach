# Session Recorder — Implementation Plan

Status: written 2026-10-08. **Phase 1 (PokerStars importer + session rundown) implemented 2026-10-08**; see "Sessions" in CLAUDE.md. Deviations from this plan: EV-loss ranking (`action_evs`) is not built yet, so mistakes are ranked by mistake count and hand score; `CalibrationProfile` and the capture fields are deferred to Phases 2–3; batch grading runs one hand at a time.

Goal: a recorder the user starts before a ClubGG session. It silently captures the
table window to disk. When the user clicks **End session**, the app reconstructs every
hand, writes a PokerStars-format hand history per hand, and grades the **hero's**
decisions with the existing solver + LLM pipeline. Phase 1 delivers the same rundown
for any site that already exports hand histories (PokerNow, PokerStars, GG exports),
so the analysis half is built and tested before a single screenshot is parsed.

---

## 0. Design rules (non-negotiable)

These are product constraints, not preferences. Every phase below is checked against them.

| # | Rule | How the design enforces it |
|---|------|----------------------------|
| R1 | **Capture only during the session.** Nothing is parsed, recognized, analyzed, displayed or counted while recording. No overlay, no hints, no live stats, not even "hands detected: 12". | The recorder is a separate package (`recorder/`) that only writes JPEG frames + a timestamp index. It has no import path to the vision/parser code. The web UI during recording shows only *elapsed time* and *frames written*. All recognition starts on **End session**. |
| R2 | **Grade only the hero.** No persistent per-opponent statistics (that is a HUD, and ClubGG already ships its own "SmartHUD"; third-party ones are banned). | Opponents are stored only as `Seat N` inside each hand's text. There is no `Player`/`Opponent` table, no aggregation across hands keyed by opponent, and the ClubGG recognizer never OCRs player names. |
| R3 | **ToS risk is acknowledged.** ClubGG's terms prohibit third-party software, data mining and automated collection, and its anti-cheat may detect screen capture. A post-session-only recorder is the least-invasive design, but the user has accepted the risk of account action. | Documented here and in the recorder's startup banner. Capture is window-scoped and never touches the ClubGG process, files, or network. |
| R4 | **Light on a 16 GB M2 Air with Chrome open.** | Change-triggered window capture at ≤4 fps, ~100 MB RSS, no solver running during capture. Post-session work runs at background QoS with the solver capped at 4 threads and one tree in memory. Budget in §8. |
| R5 | **Low-confidence hands are never silently graded.** | Every reconstructed hand carries a confidence score; below threshold it goes to a review/fix UI. |
| R6 | **Read-only toward ClubGG.** | Never write to ClubGG directories, never inspect its network traffic, never decrypt anything. |

---

## 1. Investigation findings

### 1.1 Does ClubGG store hand data locally? — **No.**

Everything under the user's library was inspected read-only on 2026-10-08:

| Location | Contents | Hand data? |
|----------|----------|-----------|
| `~/Library/Application Support/com.nsus.clubgg.mac.game/` | `RumLog/RumLog.json` (0 bytes; RUM = real-user-monitoring telemetry buffer) and `Unity/<guid>/Analytics/{config,values}` (Unity Analytics config; `ArchivedEvents/` empty) | No |
| `~/Library/Application Support/com.nsus.clubgg.mac.launcher/` | empty | No |
| `~/Library/Caches/com.nsus.clubgg.mac.game/` | 223 MB of Unity Addressables asset bundles (50 hashed dirs with `__data`/`__info`) — textures, prefabs | No |
| `~/Library/Caches/com.nsus.clubgg.mac.launcher/` | 2 MB `Cache.db` (standard NSURLCache of the Swift launcher) | No |
| `~/Library/Logs/NSUS Limited/ClubGG/Player.log` (+`Player-prev.log`) | Unity Player log, 296 KB / 8 111 lines: engine init, RUM JSON records (`Domain`, `Scene`, `Fps_n`, `Message`), DNS errors, exception stack traces. Zero matches for any `[AKQJT2-9][shdc]` card token. | No |
| `~/Library/Preferences/com.nsus.clubgg.mac.game.plist` | Client settings (see below) | No |
| `~/Library/HTTPStorages/com.nsus.clubgg.mac.launcher*` | launcher cookies/HTTP storage (not opened) | No |
| `~/Library/Containers`, `Group Containers`, `WebKit`, `Saved Application State` | no nsus/clubgg entries | — |
| `/Applications/ClubGG.app` (751 MB) | Swift launcher (`com.nsus.clubgg.mac.launcher` 1.0.3) wrapping a Unity 6000.1.14 IL2CPP game at `storage/ClubGG.app` (`com.nsus.clubgg.mac.game` 26.05.0229) plus asset/avatar/localization folders | No |

Supporting evidence from the IL2CPP metadata strings (`global-metadata.dat`, read with
`strings`, no decryption): the client has an **in-app hand history viewer**
(`InGameHandHistoryPopup`, `HandHistoryStreetData.cs`, `LobbyProfileHandHistoryPanel`) and a
**PokerCraft** button (`_pokerCraftButton`, `_isNewPokerCraft`). These are UI classes fed by
server packets (`P_*_REQ/RES`); nothing is persisted to disk. Stack traces in `Player.log`
confirm cards arrive as packets and go straight to rendering
(`HoldemGameTable:Draw_P_PCard_INFO(P_PCard_INFO)` → `CardDealingController`).

**Conclusion:** there is no local file, cache or database to read. Screen capture is the
only passive, read-only data source. (The in-app hand-history popup is a possible
*secondary* screen-scrape source: after a session, the user could page through it and the
app could OCR the structured text. It is noted as a Phase 0 spike, not the main path,
because it still requires clicking through every hand and its retention window is unknown.)

### 1.2 Useful facts from the settings plist

| Key | Value | Why it matters |
|-----|-------|----------------|
| `Screenmanager Resolution Width/Height` | 674 × 1252 (defaults 540 × 960) | ClubGG desktop is a **portrait, phone-style** window. One table fills the window; cards are large. At Retina scale the frame is 1348 × 2504 px. |
| `Screenmanager Fullscreen mode` | 3 (= Unity `Windowed`) | Window-scoped capture works; the window can sit behind Chrome. |
| `setting_chips_in_bb` | 1 | Stacks/bets are displayed in **big blinds**, so OCR reads bb directly. Keep this on; the pipeline still supports currency. |
| `setting_cardstyle` | 2 | A specific deck style; the calibration profile must record it (templates are per style). |
| `multi_table_config` | free: 4 tables | Multi-tabling exists (likely tab-switching inside the single window). v1 = one table. |
| `custom_bet_per_value_*` | 33 / 50 / 75 / 100 % | The user's bet presets coincide with the solver's four tree sizes — nearest-size mapping will usually be exact. |
| `clubgg_config_version` / app version | 26.05.0229 | Store with each calibration profile; a client update means recalibrate. |

### 1.3 Machine / toolchain (verified)

macOS 27.0, Xcode installed (Swift 6.3, SDK 26.5), Node 24.15, Python 3.11 (numpy, no OpenCV),
no tesseract. 16 GB RAM, Apple M2. ClubGG not running at inspection time.
→ ScreenCaptureKit and Apple Vision are available natively; no extra OCR install needed.

---

## 2. Architecture

```
 ┌──────────────────────────── DURING SESSION (capture only, R1) ────────────────────────────┐
 │                                                                                            │
 │   ClubGG window ──ScreenCaptureKit──▶  recorder/ (Node daemon :3003)                       │
 │   (com.nsus.clubgg.mac.game)           └─ spawns capture/ClubGGCapture (Swift CLI)         │
 │                                            • window-scoped SCStream, ≤4 fps                │
 │                                            • frame diff → keep changed frames only         │
 │                                            • JPEG q0.75 + index.jsonl                      │
 │                                                      │                                     │
 │                                                      ▼                                     │
 │          ~/Library/Application Support/poker-coach/sessions/<sessionId>/frames/*.jpg       │
 │                                                                                            │
 │   Web client "Sessions ▸ Record": [Start] [End session]  shows only elapsed + frame count   │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
                                      │  End session  (POST /api/sessions/:id/finalize)
                                      ▼
 ┌──────────────────────────── AFTER SESSION (background QoS, R4) ───────────────────────────┐
 │                                                                                            │
 │  server/src/lib/vision/            server/src/lib/hh/               server/src/lib/session/ │
 │  ┌──────────────┐  frames  ┌────────────────┐  PS text  ┌──────────────┐  ParsedHand        │
 │  │ calibration  │─────────▶│ frame→TableState│─────────▶│ reconstruct  │──────────────┐     │
 │  │ cards (tmpl) │          │ (per frame)     │          │ state machine│  + confidence │     │
 │  │ numbers(OCR) │          └────────────────┘          └──────┬───────┘              │     │
 │  └──────────────┘   (Vision OCR via Swift CLI `ocr`)          │ low conf              ▼     │
 │                                                               ▼               ┌───────────┐ │
 │  Any PokerStars-format file ────▶ hh/pokerstars.ts (parser) ─▶ ParsedHand ───▶│ hh/mapper │ │
 │  (PokerNow converted, PS, GG)          ▲                                      │ → Setup,  │ │
 │                                        └── review/fix UI edits PS text ───────│ StartState│ │
 │                                                                               │ history   │ │
 │                                                                               └─────┬─────┘ │
 │                                                                                     ▼       │
 │                                                      session/grader.ts (queue, p-limit)     │
 │                                                       ├─ preflop-only hands → range rules   │
 │                                                       ├─ HU postflop → Rust solver (nice'd) │
 │                                                       └─ everything → analyzeHandWithLLM    │
 │                                                                                     │       │
 │                                                                                     ▼       │
 │                                                      Postgres: Session, RecordedHand        │
 │                                                                                     │       │
 │                                                                                     ▼       │
 │   Web client: SessionSummary ▸ biggest mistakes ▸ leaks by category ▸ HandDrillDown         │
 │               (reuses AnalysisResult)   ▸ ReviewQueue (fix low-confidence hands)            │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Components and where they live

| Component | Path | Language | Notes |
|-----------|------|----------|-------|
| Capture helper | `capture/ClubGGCapture/` (Swift package, CLI binary) | Swift | Subcommands: `list-windows`, `record --bundle-id com.nsus.clubgg.mac.game --out DIR --max-fps 4 --diff 0.004`, `ocr --image F --regions JSON` (Apple Vision). The only native code in the project. |
| Recorder daemon | `recorder/` (new npm workspace) | TypeScript | Tiny HTTP server on `127.0.0.1:3003`: `POST /start`, `POST /stop`, `GET /status`. Spawns the Swift CLI, owns the session frames dir. **Depends on nothing in `server/src/lib`** (R1). Also usable from the terminal: `npm run recorder -- start` / Ctrl-C ends. |
| Hand-history model + parsers | `server/src/lib/hh/model.ts`, `pokerstars.ts`, `pokernow.ts` (optional CSV), `writer.ts` (ParsedHand → PS text) | TS | `ParsedHand` is the single canonical representation; both the file importer and the screen reconstructor produce it. |
| Mapper to existing pipeline | `server/src/lib/hh/mapper.ts`, `positions.ts`, `rangesFromLine.ts`, `sizing.ts` | TS | ParsedHand → `Setup` + `StartState` + `HandHistoryEntry[]` + explicit per-street pot/stack + explicit ranges. |
| Vision (post-session only) | `server/src/lib/vision/calibration.ts`, `frameState.ts`, `cards.ts`, `numbers.ts`, `reconstruct.ts` | TS (+ Swift `ocr`) | Frame → `TableState`; sequence of `TableState` → `ParsedHand` + confidence. |
| Session grading | `server/src/lib/session/grader.ts`, `summary.ts`, `leakCategories.ts` | TS | Queue with persistence in DB; resumable. |
| Routes | `server/src/routes/sessions.ts` | TS | See §5. |
| Solver additions | `server/solver-service/src/main.rs` | Rust | Return per-action EVs (`action_evs`) so EV loss can be ranked; optional `POST /cache/clear`. |
| Client | `client/src/components/sessions/{RecordPanel,SessionList,SessionSummary,HandList,HandDrillDown,ReviewHand,Calibrate,ImportHands}.tsx` + new `Sessions` tab in `App.tsx` | React | `HandDrillDown` reuses `AnalysisResult`. |
| Prisma | `server/prisma/schema.prisma` + migration | — | §4. |

Why Swift only for capture/OCR and TypeScript for the rest: the solo developer's stack is
TS; Apple's ScreenCaptureKit and Vision APIs are the lightest, most accurate options on this
machine and need no installs; template matching on tiny glyph crops is a few lines of JS with
`sharp` for decoding. No Python/OpenCV layer.

---

## 3. Capture design (macOS)

### 3.1 Approach decision

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **ScreenCaptureKit `SCStream` with `SCContentFilter(desktopIndependentWindow:)`** via a small Swift CLI | Window-scoped (works when occluded by Chrome), GPU-backed, we choose fps and get a frame callback so we can diff and drop unchanged frames; one process; ~1–3 % CPU at 4 fps | Needs Swift (~250 lines), Screen Recording permission | **Use for v1** |
| `screencapture -l <windowid>` in a loop | Zero code; good for the Phase 0 spike | Spawns a process per frame (~150 ms, PNG only, higher CPU), no diffing, no stream | Spike only |
| `CGWindowListCreateImage` polling from Node (via ffi) | No Swift | Deprecated on macOS 14+, native addon pain | No |

Capture parameters (defaults, tunable):

- Window selection: first `SCWindow` whose `owningApplication.bundleIdentifier == "com.nsus.clubgg.mac.game"` and `isOnScreen` with the largest area. Re-resolve every 5 s so a re-created window (table switch) is followed; a window change is logged in `index.jsonl` as an event.
- `minimumFrameInterval = 1/4 s`, BGRA, `showsCursor = false`, `capturesAudio = false`, queue depth 3, output size = window size × backing scale (1348 × 2504).
- Change trigger: downsample each frame to 48 × 90 grayscale, mean absolute difference vs the last *kept* frame; keep if `> diff` threshold (start 0.4 % of full scale), plus a keyframe every 10 s regardless. Expect ~1 kept frame/s during a hand, far fewer between hands.
- Encode JPEG q 0.75 (~120–200 KB at 2×) → roughly 300–600 MB per hour. Frames are deleted after a session reconstructs successfully, except frames referenced by hands that sit in the review queue.
- `index.jsonl`: one line per kept frame `{t: ms since start, f: "000123.jpg", d: diff, w, h}` plus events `{t, event: "window-changed"|"paused"}`.
- Permission: the binary that owns the stream (`ClubGGCapture`, or the terminal that launches it) must be granted **System Settings ▸ Privacy & Security ▸ Screen Recording**. macOS prompts on first run; macOS 15+ periodically re-asks for apps using screen capture — the recorder detects "no frames for 10 s" and surfaces "permission lost" in `/status`.
- No parsing anywhere in this path: the Swift CLI has no OCR import in `record` mode (the `ocr` subcommand is a separate command only invoked after End session).

### 3.2 Session lifecycle

1. User opens ClubGG (windowed), sits at a table, opens the web client **Sessions ▸ Record**.
2. Click **Start** → client `POST 127.0.0.1:3003/start {userId}` → daemon creates `sessions/<id>/`, starts the Swift CLI, and `POST /api/sessions` on the Express server with `{id, source: "clubgg_capture", captureDir, status: "recording"}`.
3. During play the panel shows elapsed time, frame count, and the permission indicator. Nothing else.
4. Click **End session** → daemon stops capture, writes a final index entry, then the client calls `POST /api/sessions/:id/finalize`. The server starts the pipeline (§6) in the background and the UI switches to a progress view (`reconstructing 0/1 → grading 12/58`).
5. The solver is **not** warmed during the session; if it was left running from the trainer, `finalize` first calls `POST /cache/clear` (new) so no stale 1 GB trees sit in RAM while the user still has Chrome open.

---

## 4. Data model (Prisma)

```prisma
model Session {
  id             String         @id @default(cuid())
  userId         String
  user           User           @relation(fields: [userId], references: [id])
  source         String         // "clubgg_capture" | "pokerstars_import" | "pokernow_csv"
  status         String         // recording | captured | reconstructing | grading | done | failed
  site           String?        // "ClubGG" | "PokerNow" | ...
  tableName      String?
  tableSize      Int?           // 2..10 seats
  smallBlind     Float?         // in currency units (or bb units when site shows bb)
  bigBlind       Float?
  currency       String?        // "USD" | "bb" | "chips"
  heroName       String?        // import only; ClubGG = "Hero" (bottom seat)
  captureDir     String?        // absolute path to frames (capture sessions)
  calibrationId  String?
  calibration    CalibrationProfile? @relation(fields: [calibrationId], references: [id])
  startedAt      DateTime       @default(now())
  endedAt        DateTime?
  handsTotal     Int            @default(0)
  handsGraded    Int            @default(0)
  handsReview    Int            @default(0)
  summary        Json?          // computed aggregates (see §7), cached
  error          String?
  hands          RecordedHand[]
}

model RecordedHand {
  id             String   @id @default(cuid())
  sessionId      String
  session        Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  seq            Int      // order within the session
  externalId     String?  // site hand id when known (PS header / OCR'd "#1234")
  hhText         String   // PokerStars-format text — the source of truth; edits go here
  parsed         Json     // ParsedHand (derived; regenerated on edit)
  heroPosition   String?  // "BTN" ... as used by ranges.ts
  heroCards      String?  // "AhKd"
  board          String[] // up to 5
  playersDealt   Int
  heroVoluntary  Boolean  @default(false) // hero put money in voluntarily
  sawFlop        Boolean  @default(false)
  huPostflop     Boolean  @default(false) // exactly 2 players from the flop on → solver-gradable
  gradeMode      String   // "solver_llm" | "llm_only" | "preflop_rule" | "skipped"
  confidence     Float    @default(1)     // 1 for file imports
  confParts      Json?    // {cards, numbers, sequence, completeness}
  needsReview    Boolean  @default(false)
  reviewNote     String?
  frameFirst     String?  // frames/000123.jpg (capture sessions)
  frameLast      String?
  setup          Json?    // Setup fed to analyzeHand (debug/replay)
  startState     Json?    // StartState fed to analyzeHand
  history        Json?    // HandHistoryEntry[]
  analysis       Json?    // Analysis (same shape as TrainerHand.analysis)
  score          Int?
  evLossBb       Float?   // sum over decisions of max(0, bestEV - heroEV), solver-graded streets only
  worstDecision  Json?    // {street, heroAction, evLossBb, gtoFreq}
  leaks          String[]
  leakCategories String[] // from leakCategories.ts (preflop_open, cbet, river_call, sizing, ...)
  gradedAt       DateTime?
  createdAt      DateTime @default(now())
  @@unique([sessionId, seq])
  @@index([sessionId, needsReview])
}

model CalibrationProfile {
  id          String   @id @default(cuid())
  userId      String
  site        String   // "ClubGG"
  appVersion  String?  // "26.05.0229" from the plist
  tableSize   Int      // 6 | 9 | 2 ...
  cardStyle   String?  // plist setting_cardstyle
  windowW     Int
  windowH     Int      // logical points; regions are stored as 0..1 fractions
  regions     Json     // see §5.1
  templates   Json     // rank/suit glyph templates as small base64 PNGs
  createdAt   DateTime @default(now())
}
```

`User` gains `sessions Session[]` and `calibrations CalibrationProfile[]`. `TrainerHand` is unchanged;
`LeakDashboard` later merges `TrainerHand.leaks` and `RecordedHand.leaks`.

Frames are **not** rows: they live on disk under
`~/Library/Application Support/poker-coach/sessions/<id>/frames/` with `index.jsonl`.
Only the two frame filenames bounding each hand are stored on the row (for the review UI).

Privacy note: frames and hand texts contain the user's own hole cards and results. Everything
stays local (local Postgres or the Railway DB the user already uses; the plan recommends local
Postgres for sessions). Opponent names: not captured for ClubGG (R2); for imports they remain
inside `hhText` only.

---

## 5. Recognition and reconstruction (post-session)

All of this runs only after `finalize`. Input: `frames/` + `CalibrationProfile`. Output: `ParsedHand[]` with confidence.

### 5.1 One-time calibration

`Calibrate.tsx`: pick any frame from a session (or take a one-off screenshot with the Swift CLI),
then drag rectangles on it. Regions are stored as fractions of window size so a resize at the
same aspect ratio still works (the profile records `windowW/H`; a different aspect ratio asks
for recalibration).

Regions per profile (6-max shown; 9-max adds seats):

```json
{
  "heroSeat": 0,
  "seats": [
    { "stack": [x,y,w,h], "bet": [..], "cards": [..], "dealerButton": [..], "activeRing": [..] }
  ],
  "heroCards": [[..],[..]],
  "board": [[..],[..],[..],[..],[..]],
  "pot": [..],
  "handNo": [..],          // optional, if ClubGG shows a hand number
  "blindsLabel": [..]      // optional, e.g. "0.5/1" text on the table
}
```

Hero seat: ClubGG (mobile layout) always draws the hero at the bottom centre, so `heroSeat` is a
fixed index per profile — no runtime detection needed.

**Card templates ("teach cards" wizard):** card crops are split into a *rank* sub-region and a
*suit* sub-region. The wizard clusters all crops from the session by pixel similarity and asks the
user to label each cluster once — in practice 13 rank glyphs + 4 suit glyphs = 17 labels, not 52.
Templates are stored in the profile. Unknown glyphs later (new theme) re-open the wizard.

Table sizes / themes / multi-tabling:

- One `CalibrationProfile` per (tableSize, cardStyle/theme, window aspect). The user keeps one
  theme; the profile records the plist `setting_cardstyle` and app version so a mismatch is
  flagged on `finalize`.
- 6-max first (the user's games), 9-max profile added when needed; the state machine is seat-count
  agnostic.
- Multi-tabling is out of scope for v1 (window-scoped capture = one table; in-window table
  switching is detected as a hand-number/blinds discontinuity and the hand is marked low
  confidence).

### 5.2 Frame → `TableState`

For each kept frame, using the profile:

| Field | Method | Why |
|-------|--------|-----|
| Hero hole cards, board cards | **Template matching** on rank/suit sub-crops (normalized cross-correlation on ~20×30 px grayscale, suits additionally by dominant hue for 4-colour decks). Score < 0.85 → `unknown`. | Fixed UI, fixed fonts: templates beat OCR (OCR confuses 6/9, J/1, 10) and need no model. Score doubles as the per-card confidence. |
| Pot, per-seat stack, per-seat bet | **Apple Vision** `VNRecognizeTextRequest` (`.accurate`, `usesLanguageCorrection=false`, crop upscaled 3×, custom words like "BB", "K", "M"). Batched: the Swift `ocr` subcommand takes one image + N regions and returns N strings with Vision confidence. | Numbers vary (`12.5`, `1,250`, `3.2K`); OCR is the right tool. ~50–100 ms per frame batch. |
| Dealer button per seat | Template/colour match in `dealerButton` zone | Positions. |
| Seat folded / empty | `cards` zone: face-down card backs present → in hand; absent → folded/empty | Fold detection without reading action labels. |
| Acting seat | `activeRing` zone colour (optional) | Helps ordering; not required. |
| Hand number | Vision OCR on `handNo` (if the UI shows one) | Hand boundary + external id. |

Each `TableState` carries per-field confidences. Frames where all card slots are unknown and
the pot is empty are "between hands".

Expected cost: ~5 000 frames/2 h × ~80 ms ≈ 7 min at background priority. Cheaper trick: only run
OCR on a frame when its card/button/fold state or diff score changed meaningfully versus the
previous frame (most kept frames are chip animations).

### 5.3 `TableState[]` → hands (state machine in `reconstruct.ts`)

Actions are inferred from **deltas**, not from reading action labels:

- **Hand start**: hero cards go from unknown → known, board empty, pot resets, button position read.
  Blinds = first non-zero `bet` values after the start (SB < BB); a third forced bet before any
  voluntary action = straddle.
- **Positions**: from the dealer-button seat and the set of seats with cards, clockwise;
  mapped to the labels `ranges.ts` uses (§6.1).
- **Street change**: board card count 0→3→4→5. Bets in front are swept into the pot.
- **Per-seat action**: between consecutive frames, for seats in clockwise order starting after
  the last actor: `bet` increased to the current max → `call`; above the max → `bet`/`raise to`;
  cards disappeared with hand still live → `fold`; turn passed with no change → `check`.
  Two folds between frames are unambiguous (seat order); a raise + re-raise collapsed into one
  frame is rare at ~1 kept frame/s and is detected (max bet jumped twice) → confidence penalty.
- **All-in**: a seat's stack reads 0 after its bet.
- **Hand end**: pot → 0 / cards cleared; winner = seat whose stack grew (informational only).
  Showdown cards for other seats are read if visible (face-up templates) and written as
  `shows [..]`; otherwise `mucks`.
- Every transition is validated by a legality checker (poker rules: amounts ≥ min-raise, to-call
  arithmetic, pot = sum of contributions ± 1 display unit). Each violation subtracts from
  `confParts.sequence`.

Output per hand: `ParsedHand` → `writer.ts` → PokerStars text, plus:

```
confidence = min(cards, numbers, sequence, completeness)
  cards        = min template score over hero + board cards (showdown cards excluded)
  numbers      = share of pot/bet reads that satisfy the arithmetic checks
  sequence     = 1 − 0.15 × (illegal/ambiguous transitions), floor 0
  completeness = 1 if hand start and end were observed and no frame gap > 3 s during the hand
```

Thresholds: ≥ 0.85 auto-grade; 0.6–0.85 → review queue (graded only after the user confirms);
< 0.6 → "unreadable" (listed, not graded, frames kept).

### 5.4 Review / fix UI (`ReviewHand.tsx`)

Left: the frames from `frameFirst`..`frameLast` as a scrubber (thumbnails + full view).
Right: the editable PokerStars text with the parser's inline errors, and the per-field confidence
chips (e.g. "river card 0.62"). Buttons: **Looks right → grade**, **Save fix → grade**,
**Discard**. Edits re-parse to `ParsedHand`, re-run the legality checker, and enqueue grading.

---

## 6. Feeding real hands into the existing pipeline (gaps and solutions)

The trainer pipeline (`openai.ts`, `solver.ts`, `ranges.ts`) assumes: hero vs one scripted
villain, villain range known from the scenario it dealt, heads-up postflop, one bet size per
tree, amounts already in bb, no rake, and `streetStartPotStack()` replays a two-actor history.
Real hands break each of those. Changes, all in `server/src/lib/hh/` unless noted:

### 6.1 `ParsedHand` → `Setup` / `StartState` / `HandHistoryEntry[]` (`mapper.ts`)

- **Position labels** (`positions.ts`): from `playersDealt` and the hero's distance from the
  button, mapped onto the 8 labels in `ranges.ts` (`UTG, UTG+1, MP, HJ, CO, BTN, SB, BB`):

  | players | seats after BB, in order |
  |---------|---------------------------|
  | 9–10 | UTG, UTG+1, MP, (MP), HJ, CO, BTN |
  | 8 | UTG, UTG+1, MP, HJ, CO, BTN |
  | 7 | UTG, MP, HJ, CO, BTN |
  | 6 | **MP**, HJ, CO, BTN  (6-max "UTG" ≈ full-ring MP by range width; note in the prompt as "UTG (6-max)") |
  | 5 | HJ, CO, BTN |
  | 4 | CO, BTN |
  | 3 | BTN |
  | 2 | BTN(=SB), BB |

  Unit-tested for every player count.
- **`Setup`**: `{ position, isMultiway: players at flop > 2, stackDepth: "<eff>bb", betSize: chosen tree size (§6.4) }`.
- **`StartState`**: `holeCards` from the hero's dealt line; `board` from FLOP/TURN/RIVER lines
  (missing streets = `''`); `villainPositions` = positions of the opponents still in when hero
  first acts postflop (preflop: the opener/3-bettor); `villainHoleCards` = showdown cards if shown
  else `''` (AnalysisResult gets a small change to render "not shown"); `heroIsIP` via
  `isHeroInPosition`; `heroIsPFR` = hero made the last preflop raise; `preflopContext` generated
  as text that **contains the token "3-bet"/"4-bet" when applicable**, because
  `getRangesForSpot` and `analyzeHandWithLLM` detect 3-bet pots by keyword; `pot`/`effectiveStack`
  at hero's first decision; `preflopRaiseAmount`; `preflopBets`.
- **`HandHistoryEntry[]`**: hero actions as `actor: 'hero'`; every opponent action as
  `actor: 'villain'` with `villainIdx` (the type already allows it client-side; add it to
  `types.ts`). Amounts in bb with one decimal. Preflop folds by third parties are *not* entries;
  their blinds become dead money (see pot handling below).
- **Street-start pot/stack**: `streetStartPotStack()` replays a two-actor history and cannot
  represent dead money from folded players or asymmetric stacks. The importer computes the exact
  street-start pot and the effective stack (min of hero and the remaining villain) from the parsed
  hand, and `evalHeroDecision` gets an optional `spot?: { pot, stack, oopRange, ipRange }`
  override that bypasses `streetStartPotStack`/`getRangesForSpot`. Because grading is the only
  caller for imported hands, cache keys stay consistent (same function computes every call).

### 6.2 Villain ranges from position + action line (`rangesFromLine.ts`)

The trainer knows villain ranges because it dealt the scenario. For real hands derive them from
the preflop line, reusing the tables in `ranges.ts` (export the private ones):

| Villain's preflop line | Range used |
|------------------------|-----------|
| Opened (RFI) and was called | `OPEN_RANGES[pos]` |
| Called an open from the BB / SB | `BB_CALL[openerPos]` / `SB_CALL_BTN` |
| Cold-called an open from another seat | new `COLD_CALL` table (≈ `BB_CALL[opener]` minus 3-bet hands, tightened) |
| Limped (unopened) and called/checked | new `LIMP` table ≈ BTN-vs-BB defend range (approximation, flagged) |
| 3-bet and was called | `THREE_BET_IP` / `THREE_BET_OOP` |
| Called a 3-bet | `CALL_3BET_IP` / `CALL_3BET_OOP` |
| 4-bet / called a 4-bet | `FOUR_BET_RANGE` / "call 4-bet" ≈ `AA,KK,QQ,AKs,AKo` |
| Anything else (limp-reraise, 5-bet, multiway squeeze, straddle pots, short-stack jams) | **no solver**; `gradeMode = llm_only`, labelled in the UI |

Hero's range uses the same table for hero's own line, with `withHandInRange()` so the exact
combo is always present. The chosen ranges are recorded in `RecordedHand.setup`/`startState`
for transparency (the drill-down shows "assumed villain range: BTN open ~51 %").

### 6.3 Multiway pots

- Preflop decisions are graded for every hand (range tables; `heroPreflopFrequencies` already
  handles facing-open and facing-3-bet; add facing-limp and facing-4-bet verdicts).
- Postflop with the solver **only** when exactly two players see the flop and it stays
  heads-up (`huPostflop`). A flop that is 3-way and folds to heads-up on the turn stays
  `llm_only` for the whole hand in v1 (the turn tree's ranges would need a multiway flop
  model). The UI labels each street "solver-graded" vs "coach opinion (no solver)".
- `analyzeHandWithLLM` already handles `isMultiway`; the prompt gains a line listing every
  opponent's position and line.

### 6.4 Arbitrary bet sizes vs one size per tree (`sizing.ts`)

- The tree size for a street is the one of `{33, 50, 75, 100}` % nearest to the **first bet on
  that street** (pot-relative). Every bet/raise amount in that street's `street_history` is
  snapped to the tree's size (a raise to the solver's raise size) before the solver replays it,
  and hero's own size deviation is recorded (`sizingDeltaPct`) and shown in the feedback
  ("you bet 62 %, graded against the 50 % tree").
- Snapping error above 35 % pot (e.g. a 2× overbet when the tree has 100 %) → `llm_only` for
  that street.
- Multi-size trees (`"50%, 100%"`) are allowed in a v2 "deep dive" button for one hand at a time
  (~2× RAM; 33 % trees already cost 2–3.6 GB — never used in batch mode; batch uses
  50/75/100 only, 33 % requests snap to 50 % with a note).
- All-ins: `force_allin_threshold` already collapses deep raise wars; a hero jam is graded as
  the tree's all-in action.

### 6.5 Units, stacks, rake

- All amounts are converted to bb at parse time (`bigBlind` from the header or from the first
  posted BB). ClubGG with `setting_chips_in_bb=1` is already in bb. One-decimal rounding; the
  solver works in 0.01 bb chips.
- Effective stack = min(hero, villain) at hand start; asymmetric multiway stacks are the LLM's
  problem (listed in the prompt).
- Rake: not modelled in the tree (postflop-solver has rake options; left off in v1 as a known
  approximation that mostly nudges thin preflop decisions). The PokerStars summary rake is
  parsed and stored for the result line only.

### 6.6 Batch grading without hammering Groq or the solver (`grader.ts`)

- Triage per hand (`gradeMode`):
  - hero folded preflop without voluntary money → `preflop_rule`: range-table verdict only
    (in/out of open or defend range), **no LLM call**. ~60 % of hands.
  - hero voluntary, hand ended preflop → `preflop_rule` + one short LLM call only if the verdict
    is "mistake" (saves most calls).
  - `huPostflop` → `solver_llm` (solver per postflop hero decision, then one LLM call).
  - otherwise → `llm_only`.
- Queue: in-process, persisted (`RecordedHand.gradeMode/gradedAt`), so a restart resumes.
  Solver concurrency 1 (one tree at a time, hands ordered so consecutive decisions in the same
  hand hit the cache); LLM concurrency 3 with exponential backoff on 429 and a token budget per
  minute (Groq free tier limits are per-model; verified in Phase 0).
- Dedup/caching: `analysis` is keyed by `sha256(hhText + model + treeSize)`; re-grading an edited
  hand only re-runs what changed.
- Priority: the solver is launched with `taskpolicy -b` (background QoS) and
  `RAYON_NUM_THREADS=4 SOLVER_CACHE_MB=1500`; the Node grader runs with concurrency as above.
  Expected session of 250 hands: ~40 HU-flop hands × ~25 s + ~90 LLM calls ≈ 20–25 min,
  progress shown in the session view.
- EV loss for ranking: `main.rs` adds `action_evs` (per-action EV for the acting hand from
  `expected_values_detail`) to the `/solve` response; `evLossBb = max(0, bestEV − heroEV)` per
  decision. Values < 0.3 bb are reported as "close" (solver noise at 10 % exploitability).
  Streets without solver data get no EV number — they are ranked by the LLM verdict only and
  shown separately.

---

## 7. Post-session rundown UI

`App.tsx` gains a **Sessions** tab (`SessionList` → `SessionSummary`).

**SessionSummary**
- Header: site, stakes, table size, duration, hands played / graded / in review, hero VPIP %
  and PFR % (hero only — R2), net result in bb if readable.
- Stat tiles: average score, total EV loss (bb, solver-graded streets), mistakes / close / correct counts.
- **Biggest mistakes** — hands ranked by `evLossBb` (then by LLM "no" verdicts for non-solver
  hands), each row: hero cards, board, position, the worst decision, EV loss, one-line coach
  summary → click → drill-down.
- **Leaks by category** — bars by `leakCategories` (`preflop_open`, `preflop_defend`,
  `3bet_pot`, `cbet`, `turn_barrel`, `river_value`, `river_call`, `sizing`, `bluff_catch`,
  `multiway`) derived from street + action type + verdict, plus the LLM's free-text leak labels
  (same as `LeakDashboard` today).
- **Hand list** with filters (voluntary only, saw flop, mistakes only, review queue) and per-hand
  score.
- **Review queue** badge → `ReviewHand`.

**HandDrillDown** reuses `AnalysisResult` with `villainDescriptions=[]`, a "grade mode" badge
per street (solver / coach-only), the assumed ranges, the sizing note, and a collapsible raw
PokerStars text. `LeakDashboard` later includes session hands in its aggregates.

---

## 8. Resource budget (16 GB, Chrome open)

| Phase | Process | RSS | CPU |
|-------|---------|-----|-----|
| Recording | Swift capture CLI + Node daemon | ~80–150 MB | 1–3 % (4 fps max, diffing on a 48×90 thumbnail) |
| Recording | Express + Postgres (idle) | ~250 MB | ~0 |
| Recording | Solver | **not running** / cache cleared | 0 |
| Post-session | Vision OCR (Swift) | ~150 MB | 1 core, background QoS |
| Post-session | Solver, 4 threads, one 50/75/100 % tree | ≤ 1.3 GB peak | 4 cores, background QoS |
| Post-session | Node grader | ~300 MB | low |

Leaves > 8 GB for Chrome + macOS during capture and > 6 GB during grading.
Disk: ~0.5 GB per hour of frames, deleted after successful reconstruction.

---

## 9. Phased milestones

Effort assumes a solo developer working part-time (evenings/weekends); "day" ≈ 4–6 focused hours.

### Phase 0 — Spikes (1–2 days). De-risk before building.

1. **Capture spike**: with ClubGG open on a play-money table, run `screencapture -l <windowId>`
   every 2 s for 10 minutes (window id from a 20-line Swift script using
   `CGWindowListCopyWindowInfo`, or the future `list-windows`). Collect **20+ screenshots**
   covering: dealing, each street, a fold, a raise, an all-in, showdown, time-bank, a chat
   bubble/emoji, a popup. Label them by hand.
2. **OCR spike**: crop pot/stack/bet regions from those screenshots, run Vision OCR
   (`swift` script, ~40 lines) → accuracy table. Target ≥ 98 % on numbers after 3× upscale.
3. **Card spike**: crop rank/suit glyphs, verify that NCC template matching separates all 13 ranks
   and 4 suits (score margin ≥ 0.1) for the user's `setting_cardstyle`.
4. **Hand-history popup spike**: open ClubGG's in-app hand history after the session; note what it
   shows (streets? actions? how many hands?) and screenshot it — decide whether it is a useful
   secondary source.
5. **Groq limits**: send 30 analysis prompts back-to-back, record 429 behaviour and tokens/min.
6. **Solver**: confirm `expected_values_detail` is reachable in the pinned `postflop-solver` git
   revision and prototype `action_evs` in `main.rs` (no behaviour change for the trainer).

Definition of done: `docs/spikes/` notes with the 20 labelled screenshots, OCR and template
accuracy numbers, Groq limits, and a go/no-go on the recognizer design. ToS banner text agreed.

### Phase 1 — PokerStars importer + session rundown (4–6 days). **Recommended first build.**

Works today with the PokerNow session the user already has
(a converted PokerNow export, 193 hands) and any site
that exports PokerStars-format text; the ClubGG recorder feeds the same importer in Phase 3.

Build: `hh/model.ts`, `hh/pokerstars.ts` (+ fixture-based unit tests: straddles, all-ins,
uncalled bets returned, run-it-twice hands → grade up to the all-in, split pots, `Dealt to`
with hero name), `hh/writer.ts` (round-trip test: parse → write → parse), `hh/positions.ts`
(tests for 2–10 players), `hh/rangesFromLine.ts`, `hh/sizing.ts`, `hh/mapper.ts`
(tests comparing mapped `StartState`/history against hand-written expectations for ~10 hands),
`solver.ts` `evalHeroDecision(..., spot?)` override, `types.ts` `villainIdx`, Prisma `Session` /
`RecordedHand` + migration, `routes/sessions.ts` (`POST /api/sessions/import` with
`{heroName, text}`, `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/hands`,
`GET /api/hands/:id`, `POST /api/hands/:id/regrade`), `session/grader.ts` with the triage,
queue, backoff and progress, `session/summary.ts`, `session/leakCategories.ts`, client
`ImportHands`, `SessionList`, `SessionSummary`, `HandList`, `HandDrillDown`, Sessions tab.

Definition of done: importing the PokerNow file produces a session with 193 hands, correct hero
positions for every hand (spot-check 20 by hand), triage counts that look right (most hands
`preflop_rule`), grading finishes without manual intervention with the solver at 4 threads, the
summary shows ranked mistakes with EV loss on solver-graded hands, and every hand opens in the
drill-down. `npm test` covers parser/mapper/positions/sizing. Trainer behaviour unchanged
(`npm test`, `cargo test --release` still pass).

### Phase 2 — Capture helper + recorder daemon (2–3 days)

Build: `capture/ClubGGCapture` (SwiftPM, `list-windows`, `record`, later `ocr`), `recorder/`
daemon + CLI, `RecordPanel.tsx`, `POST /api/sessions` (capture) and `POST /api/sessions/:id/finalize`
stub that only marks `captured`, solver `POST /cache/clear`.

Definition of done: a 60-minute real session yields `frames/` + `index.jsonl` with
< 600 MB, average CPU of the capture process < 3 % (Activity Monitor), RSS < 150 MB, zero
recognition code loaded (verified by the `recorder/` package having no dependency on
`server/`), window stays captured while Chrome is frontmost, permission loss is surfaced.
The UI shows nothing but elapsed time and frame count during the session.

### Phase 3 — Calibration, recognition, reconstruction, review (6–10 days). The hard part.

Build: `Calibrate.tsx` + `CalibrationProfile`, teach-cards wizard, Swift `ocr` subcommand,
`vision/frameState.ts`, `vision/cards.ts`, `vision/numbers.ts`, `vision/reconstruct.ts` with the
legality checker and confidence, `finalize` pipeline (reconstruct → write PS text → import path
from Phase 1), `ReviewHand.tsx`, frame cleanup.

Test strategy: (a) unit tests for the state machine using **synthetic `TableState[]` sequences**
(no images) for every action type, straddle, all-in, multi-fold-between-frames, table switch;
(b) a golden set: one recorded session where the user writes down 20 hands manually during/after
play — the reconstruction must match those 20 hand texts exactly (diff test); (c) the ClubGG
in-app hand history (if useful per the Phase 0 spike) as a cross-check for another 20 hands.

Definition of done: on a ≥ 100-hand recorded session, ≥ 90 % of hands reach confidence ≥ 0.85
and the golden 20 match exactly; the remainder appear in the review queue with their frames; a
fixed hand grades like an imported one; end-to-end time from End session to summary < 30 min
with Chrome open.

### Phase 4 — Hardening and polish (2–3 days)

`action_evs` wired into EV-loss ranking (if not done in Phase 1), `LeakDashboard` merging
session hands, session-over-session trends (score, EV loss per 100 hands), 9-max profile,
re-grade all hands of a session after range-table changes, export of a session's PokerStars text.

### Later / optional

PokerNow CSV direct import (`hh/pokernow.ts`), multi-table (one SCStream per window), menu-bar
app instead of the daemon, multi-size "deep dive" trees per hand, rake modelling, a small CNN
card classifier if templates ever prove brittle across themes.

Total: roughly 3–5 weeks part-time. Phase 1 alone is a shippable, demo-able feature
("import any hand history, get a solver-backed session review") and is the resume-worthy core.

---

## 10. Risks, unknowns, and how to de-risk early

| # | Risk | Likelihood / impact | De-risk |
|---|------|---------------------|---------|
| 1 | **Recognition brittleness**: chip/card animations, popups (time-bank, emoji, chat bubbles, "run it twice" prompts, bomb pots, straddles, disconnect overlays) corrupt reads; ClubGG client updates move pixels. | High / high | Phase 0 spikes 1–3 with 20 varied screenshots before any pipeline code; delta-based actions instead of reading labels; keyframes every 10 s; confidence + review queue (R5); profile pinned to app version; legality checker. |
| 2 | **ToS / account risk**: any third-party tool is against ClubGG's terms; anti-cheat behaviour toward screen capture is unknown. | Unknown / high (ban) | User accepted the risk (R3). Keep the design passive: window capture only, no process/network/file access, nothing in real time. Use a play-money table for all development and the first real session. |
| 3 | **Grading accuracy of the solver on real hands**: single bet size per tree, HU-only, assumed villain ranges, no rake, 6-max positions mapped onto full-ring labels. Mislabelled "mistakes" would teach the wrong lesson. | Medium / high | Label every street "solver-graded" vs "coach-only" and show assumed ranges and sizing snaps in the UI; `llm_only` fallback for any line the tables don't cover; treat < 0.3 bb EV loss as "close"; compare a handful of hands against GTO Wizard manually in Phase 1. |
| 4 | **RAM with Chrome open** (33 % trees up to 3.6 GB; stale trainer trees). | Medium / medium | Never 33 % in batch; one tree at a time; `cache/clear` at finalize; 4 threads; background QoS. Measured budget in §8. |
| 5 | **Groq rate limits / model retirement** (llama-3.3-70b was retired 2026-10-07). | Medium / medium | Triage removes ~60 % of LLM calls; backoff + persisted queue; `LLM_MODEL` env already exists. |
| 6 | **Screen Recording permission churn** (macOS 15+ periodic re-consent; permission tied to the launching binary). | Medium / low | Sign the Swift CLI ad hoc with a stable path; daemon detects "no frames" and shows a fix hint. |
| 7 | **Between-frame ambiguity** (two aggressive actions within one kept frame; hero's own quick actions). | Low / medium | 4 fps cap with change trigger; detection of double max-bet jumps → confidence penalty → review. |
| 8 | **Hero name / seat confusion in imports** (PokerNow nicknames, "name" vs "name @ id"). | Low / low | Importer asks for the hero name and shows the first 3 hands' "Dealt to" lines to confirm. |
| 9 | **Scope creep toward a HUD** (it is tempting to show opponent tendencies once the data exists). | Medium / high (ethics + ToS) | R2 is structural: no opponent tables, names not captured for ClubGG, reviews reject any per-opponent aggregate. |

---

## 11. Phase 1 quick-start checklist (for when implementation begins)

1. `server/src/lib/hh/model.ts` — define `ParsedHand`, `ParsedAction`, `ParsedSeat`.
2. Copy 12 hands from a converted PokerNow export
   into `server/src/lib/hh/__fixtures__/` (include a straddle hand, an all-in, a run-it-twice, a
   3-bet pot, a walk, a HU flop hand) and write parser tests first.
3. Positions + mapper + tests; then `evalHeroDecision` override; then the grader; then routes;
   then UI. Keep `analyzeHandWithLLM` untouched except for the multiway/opponent-line block.
4. Run the whole file end-to-end with the solver at `RAYON_NUM_THREADS=4 SOLVER_CACHE_MB=1500`.
