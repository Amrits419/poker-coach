# AI Poker Coach — Project Context

## What This Is
A full-stack AI poker training app. Hero plays GTO poker hands against a simulated villain. After each hand, an LLM coach analyzes every decision.

## Architecture (3 services + Postgres)

| Service | Location | Port | Stack |
|---------|----------|------|-------|
| Client | `client/` | 5173 | React + Vite + TypeScript |
| API Server | `server/` | 3001 | Express + TypeScript + Prisma |
| GTO Solver | `server/solver-service/` | 3002 | Rust (Axum + postflop-solver), cached solves, `/presolve` |

## How to Start Everything

### Docker (all 4 services: client, server, solver, postgres)

```bash
cp .env.example .env    # fill in GROQ_API_KEY
docker compose up --build
```

Client → http://localhost:5173 (nginx, proxies `/api` to the server container).
Server runs `prisma migrate deploy` automatically on container start via
`server/docker-entrypoint.sh`. Postgres data persists in the `postgres-data`
named volume.

Verified 2026-10-07: `docker compose up --build` brings all four services
healthy; `/api/trainer/start` works through nginx and the server reaches the
solver. Docker on this Mac is Colima (`colima start --cpu 8 --memory 10`), not Docker Desktop; the solver needs the cores and ~1.5GB per cached flop tree.

### Manual (no Docker)

```bash
# Terminal 1 — Rust GTO solver (build once, then just run the binary)
cd server/solver-service
source ~/.cargo/env
cargo build --release          # first time only, ~5 min
./target/release/solver-service

# Terminal 2 — Express API
cd server && npm run dev

# Terminal 3 — Vite client
cd client && npm run dev
```

## Key Files

```
server/
  src/
    lib/
      types.ts       — shared TypeScript interfaces (Setup, StartState, HandHistoryEntry, TableState, HandResult, Analysis)
      engine.ts      — the trainer's hand engine: pure replay(setup, startState, history) → pot, stacks, who acts, street starts, hand over; tableView / handResult / legalize
      handEval.ts    — best 5 of 7 evaluator (showdown results)
      solver.ts      — HTTP client to Rust solver, solverSpot() (the one place a solver request is built), pre-solve, LLM explanation
      ranges.ts      — GTO preflop opening/defending ranges for all positions
      openai.ts      — hand orchestration: startHand, getVillainAction, analyzeHand, trainerPreflopFacts
      cards.ts       — deck dealing utilities
    routes/
      trainer.ts     — Express routes (/start, /table, /villain-act, /explain, /analyze)
  solver-service/
    src/main.rs      — Rust Axum service, POST /solve endpoint
    Cargo.toml       — git dep: postflop-solver (NOT on crates.io)

client/
  src/
    components/
      HandTrainer.tsx  — main game UI
```

## Solver Design (main.rs)

- **Algorithm**: DCFR (Discounted CFR) via `postflop-solver` crate
- **Bet abstraction**: one size per street. Chosen per hand in the client (`setup.betSize` = '33'|'50'|'75'|'100') → Node `solverBetSizes()` → request `bet_sizes` → part of the solver cache key. Env `BET_SIZES` is only the fallback default (75%). Multi-size trees (e.g. "33%, 75%") work but roughly double solve time/memory.
- **Navigation**: tree is rooted at the current street with its cards dealt — no chance node to play; errors (hand not in range, wrong player to act) return HTTP 422 instead of panicking
- **Tests**: `cargo test --release` (solver), `npm test` in `server/` (hand engine, evaluator, villain preflop policy, importer, position logic). Timing: write a request to `/tmp/flop_req.json`, then `cargo test --release -- --ignored --nocapture time_real_flop_solve`
- **Iterations**: 50, target 10% pot exploitability
- **Latency** (native M2, 8 threads, 2026-10-07): flop ~12-15s / ~1.1GB with current defaults (compressed storage, force_allin 0.4); was 35s / 4.2GB. 4 threads is ~1.6x slower. Convergence to 10% happens between iterations 20 and 30 — the iteration cap doesn't matter, tree size does. Benchmark: `FLOP_REQ=<req.json> SOLVER_LOG=1 cargo test --release -- --ignored --nocapture time_real_flop_solve` with `SOLVER_*` env knobs.
- **Cache + presolve**: solved games cached per spot (LRU by `SOLVER_CACHE_MB`, default 3000; entries used in the last `SOLVER_CACHE_GRACE_SECS`=600 are never evicted, so one hand's trees survive even when a single flop tree exceeds the budget); identical concurrent requests coalesce. Tree size depends strongly on the bet size: 75% ≈ 1.1GB, 50% ≈ 1.0GB, 33% ≈ 2.1-3.6GB (wide BTN-vs-BB ranges) — measured 2026-10-07. The cache key is (board, ranges, pot, stack, street, bet_sizes). Every solver request (villain action, pre-solve, grading) is built by `solverSpot()` in `solver.ts` from the engine's replay, so the pot/stack are always the *street-start* values and the ranges come from how preflop actually ended (single-raised / 3-bet / 4-bet, last raiser) — never build a request any other way or grading misses the cache and re-solves the flop. `POST /presolve` warms a spot; Node calls it from `/start` (predicted line, replayed through the same engine) and whenever `/table` or `/villain-act` lands on a freshly dealt flop. Cached queries ~3ms, so analysis grading of flop decisions is free.
- **Hand engine (added 2026-11-10)**: `engine.ts` `replay()` is the single source of truth for a trainer hand; the client keeps only the history and draws the `TableState` the server returns (`/start` → `{startState, table}`, `/table` after a hero action, `/villain-act` once per villain while `table.toAct` is a villain index). Amounts: bet/raise = total in front on that street, call = total called to. `startState.pot` is everything on the table including hero's own blind. Before this there were four copies of the pot arithmetic (client, `calcPot`, `streetStartPotStack`, `calcNewPot`) that disagreed whenever someone raised over their own earlier bet, and the villain acted again after hero called a 3-bet.
- **Villain policy**: preflop from range tables for any raise level (`villainPreflopAction` in `ranges.ts`: defend vs open, opener vs 3-bet, vs 4-bet, vs jam). Postflop from the solver when the street is heads-up and the pot was raised preflop; multiway streets and limped pots (SPR 40 trees take 60s+) use the LLM, whose answer is clamped by `legalize()`. An OOP villain never donk-bets into hero's initiative (`heroHasInitiative`: hero raised last preflop, or bet the previous street) but does bet when it has the initiative itself. Solver timeout `SOLVER_TIMEOUT_MS` (120s). The LLM explanation of a solver action is fetched by the client in the background (`/explain`) and only shown after the hand, so it no longer delays play.
- **Preflop coaching verdicts**: `trainerPreflopFacts()` writes one "Preflop GTO context" line per hero preflop decision, by replaying to that decision: unopened (in/out of the opening range), facing an open (3-bet range FIRST via `heroPreflopFrequencies()`, only zero-frequency hands fall through to the `evalColdCallVsOpen` heuristic — before 2026-10-07 every pocket pair was labeled a set-mining call, so KK 3-bets were graded as mistakes), facing a 3-bet (4-bet / call ranges), facing a 4-bet+. The coach's JSON goes through `normalizeAnalysis()`; `analysis.result` (who won, net bb) is added from the engine for trainer hands.
- **Hero hand always in range**: hero can be dealt hands outside the modeled preflop range (that's the preflop lesson); `getRangesForSpot({..., heroHand, villainHand})` appends each player's exact combo (`withHandInRange`) when the tables don't contain it, so the solver can always answer for the hands in play instead of returning 422.
- **LLM explanations**: `gpt-oss-120b` is a reasoning model — calls with a `max_tokens` cap must pass `reasoning_effort: 'low'` or the reasoning eats the budget and the visible text is cut mid-sentence (`explainVillainAction`).
- **Strategy layout**: flat Vec<f32>, action-major: `strategy[action_idx * num_combos + combo_idx]`
- **Scale**: 1 bb = 100 chips (integer arithmetic, 0.01bb precision)
- Replays `street_history` to navigate to current node before reading strategy

## Hybrid LLM + Solver Pipeline

1. **Preflop**: LLM (`LLM_MODEL`, default `openai/gpt-oss-120b` via Groq) handles all decisions
2. **Postflop villain action**: Solver computes GTO frequencies → samples action → LLM explains the *why* in 1-2 sentences
3. **Hand analysis**: Solver evaluates every hero postflop decision in parallel → injects `SOLVER GROUND TRUTH` block into LLM analysis prompt
4. **Fallback**: If solver is down, all paths fall back to LLM

## Sessions (imported real hands) — added 2026-10-08

Phase 1 of `docs/SESSION_RECORDER_PLAN.md`. Flow: `POST /api/sessions/import {userId, text, heroName?, name?}` → `hh/pokerstars.ts` parses every hand to a `ParsedHand` (amounts in bb) → `hh/mapper.ts` `mapHand()` assigns positions (`hh/positions.ts`), grades preflop decisions from range tables (`hh/preflop.ts`), and triages: `skipped` (hero not dealt) / `preflop_rule` (no LLM) / `solver_llm` (heads-up postflop with modelled ranges) / `llm_only` (multiway or unmodelled line) → rows in `Session` / `RecordedHand` → `session/grader.ts` grades in the background, cheap hands first, one hand at a time, retrying Groq 429s, and `resumeGrading()` restarts unfinished sessions on boot.
- Imported hands bypass the trainer engine and `solverSpot()`: the mapper computes exact street-start pot (incl. dead money) and effective stack, ranges from the preflop line (`rangesFromLine`), and a tree size per street (nearest of 50/75/100% to the first bet; >35% pot off → that street is coach-only). The grader calls `callSolver` directly, then `analyzeHandWithLLM(..., { preflopFacts, notes })`, with the importer's own preflop verdicts as the preflop block.
- History `call` amounts are the total called to on that street (trainer convention), not the chips added.
- Re-grade a session (or only some modes): `POST /api/sessions/:id/regrade?modes=solver_llm,llm_only`.
- Test fixtures are real PokerNow hands in `server/src/lib/hh/__fixtures__/`.
- Groq free tier rate-limits a full session (~30 coach calls); expect a few minutes of 429 retries.

## Poker Recorder (recorder/) — added 2026-10-08

Swift package, menu-bar app (`./make-app.sh` → `build/PokerRecorder.app`; `--args --start` starts a session once Vision is warm). **Saves text only, never screenshots** (the user asked for this). Each tick (2 fps) captures the target window with ScreenCaptureKit; if a 48×48 thumbnail changed (or every 10 s), `TableReader` reads it in memory and appends one line to `table.jsonl`: Vision text boxes (text, confidence, 0..1 box, ink RGB) + white card regions with a 10×14 corner fingerprint (`sig`, hex) and ink RGB; the image is then dropped. Targets: auto / ClubGG / PokerNow (browser window title) / other poker apps (name list in `Capture.swift`). On End, the newest `~/Downloads/poker_now_log_*.csv` modified during the session is copied in as `pokernow_log.csv`; then it opens `localhost:5173/?capture=<dir>` → `POST /api/sessions/capture` → `vision/capture.ts reconstruct()`.
- PokerNow: `hh/pokernow.ts` converts the raw CSV (calls are "total called to" there, converted to chips added) to PokerStars text; hero = whoever showed exactly the "Your hand is" cards, else seated in every dealt hand. The import panel also accepts the CSV directly. Verified: same results as a third-party converter on all 124 of the user's hands.
- Measured on the M2: Vision first call ~45 s (warmed at app launch), then ~0.13–0.28 s per window. Vision does NOT read single card-rank glyphs → card fingerprints must be mapped to ranks/suits by calibration.
- Screen-read sessions return no hands yet (status `needs_calibration`, `captureInfo`). Next: a real play-money ClubGG session's `table.jsonl` → seat/board regions + fingerprint→card mapping + frame→hand state machine (plan §5).

## Important Rules / Bugs Fixed

- **Villain hole cards**: NEVER reveal villain cards during play. The LLM prompt explicitly says "NEVER mention hole cards" in the description field. Villain cards are shown face-down in UI until analysis.
- **Circular dependency**: `types.ts` was extracted to break the openai.ts ↔ solver.ts circular import.
- **postflop-solver Cargo.toml**: Must use `git` dep + `default-features = false, features = ["rayon"]` to avoid bincode 2.x incompatibility.
- **Solver bind address**: binds to `0.0.0.0` (env `BIND_ADDR`, default `0.0.0.0:3002`), not `127.0.0.1`. It used to be hardcoded to `127.0.0.1`, which works when everything runs on localhost but silently refuses connections from other Docker containers — had to fix this for the solver to be reachable from the `server` container.
- **Client API base URL**: `client/src/api.ts` uses a relative `/api` baseURL, not a hardcoded `http://localhost:3001/api`. nginx (Docker) and the Vite dev proxy (`vite.config.ts`, local dev) both forward `/api` to the server, so the same code works in both setups.

## Environment Variables (`server/.env` — never commit)

```
DATABASE_URL=<Railway PostgreSQL connection string>
GROQ_API_KEY=<Groq API key>
LLM_MODEL=openai/gpt-oss-120b   # optional; Groq retired llama-3.3-70b-versatile on 2026-10-07
SOLVER_URL=http://127.0.0.1:3002
PORT=3001
```

## GitHub

`github.com/Amrits419/poker-coach` — last commit `dafd4d5` (Docker + README)

## LLM Details

- Provider: Groq (OpenAI-compatible endpoint)
- Model: `process.env.LLM_MODEL ?? 'openai/gpt-oss-120b'` (llama-3.3-70b-versatile returned 404 model_not_found on 2026-10-07; account lists gpt-oss-120b/20b and qwen3.8-27b)
- Used for: preflop villain decisions, villain action explanations, full hand analysis
- baseURL: `https://api.groq.com/openai/v1`
- Client: `openai` npm package pointed at Groq's base URL via `GROQ_API_KEY`
