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
      types.ts       — shared TypeScript interfaces (Setup, StartState, HandHistoryEntry, VillainResponse, Analysis)
      solver.ts      — HTTP client to Rust solver + LLM explanation layer
      ranges.ts      — GTO preflop opening/defending ranges for all positions
      openai.ts      — hand orchestration: startHand, getVillainAction, analyzeHand
      cards.ts       — deck dealing utilities
    routes/
      trainer.ts     — Express routes (/start, /action, /analyze)
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
- **Tests**: `cargo test --release` (solver), `npm test` in `server/` (position logic). Timing: write a request to `/tmp/flop_req.json`, then `cargo test --release -- --ignored --nocapture time_real_flop_solve`
- **Iterations**: 50, target 10% pot exploitability
- **Latency** (native M2, 8 threads, 2026-10-07): flop ~12-15s / ~1.1GB with current defaults (compressed storage, force_allin 0.4); was 35s / 4.2GB. 4 threads is ~1.6x slower. Convergence to 10% happens between iterations 20 and 30 — the iteration cap doesn't matter, tree size does. Benchmark: `FLOP_REQ=<req.json> SOLVER_LOG=1 cargo test --release -- --ignored --nocapture time_real_flop_solve` with `SOLVER_*` env knobs.
- **Cache + presolve**: solved games cached per spot (LRU by `SOLVER_CACHE_MB`, default 3000; entries used in the last `SOLVER_CACHE_GRACE_SECS`=600 are never evicted, so one hand's trees survive even when a single flop tree exceeds the budget); identical concurrent requests coalesce. Tree size depends strongly on the bet size: 75% ≈ 1.1GB, 50% ≈ 1.0GB, 33% ≈ 2.1-3.6GB (wide BTN-vs-BB ranges) — measured 2026-10-07. The cache key is (board, ranges, pot, stack, street, bet_sizes); pot/stack are always the *street-start* values from `streetStartPotStack()` in `solver.ts`, which replays history with the client's exact arithmetic — never pass the client's mid-street pot to the solver or grading misses the cache and re-solves the flop. `POST /presolve` warms a spot; Node calls it from `/start` (predicted line) and `/villain-act` (preflop closes with a call). Cached queries ~3ms, so analysis grading of flop decisions is free.
- **Villain policy**: OOP villain never donk-bets (solver `bet` as first action → `check`); LLM fallback is sanitized (`sanitizePostflopFallback`). Solver timeout `SOLVER_TIMEOUT_MS` (120s).
- **Preflop coaching verdicts** (`analyzeHandWithLLM`): the LLM gets a "Preflop GTO context" block built from the range tables. `heroPreflopFrequencies()` checks the 3-bet (facing an open) or 4-bet + call-3-bet (facing a 3-bet) ranges FIRST; only hands with zero 3-bet frequency fall through to the `evalColdCallVsOpen` heuristic. Before 2026-10-07 every pocket pair was labeled a set-mining call, so KK 3-bets were graded as mistakes. "Facing a 3-bet" is detected from the history (hero opened, villain re-raised), not only from the deal-time context string.
- **Hero hand always in range**: hero can be dealt hands outside the modeled preflop range (that's the preflop lesson); `getRangesForSpot(..., heroHand)` appends the exact combo (`withHandInRange`) so the solver can still grade the postflop decisions instead of returning 422.
- **LLM explanations**: `gpt-oss-120b` is a reasoning model — calls with a `max_tokens` cap must pass `reasoning_effort: 'low'` or the reasoning eats the budget and the visible text is cut mid-sentence (`explainVillainAction`).
- **Strategy layout**: flat Vec<f32>, action-major: `strategy[action_idx * num_combos + combo_idx]`
- **Scale**: 1 bb = 100 chips (integer arithmetic, 0.01bb precision)
- Replays `street_history` to navigate to current node before reading strategy

## Hybrid LLM + Solver Pipeline

1. **Preflop**: LLM (`LLM_MODEL`, default `openai/gpt-oss-120b` via Groq) handles all decisions
2. **Postflop villain action**: Solver computes GTO frequencies → samples action → LLM explains the *why* in 1-2 sentences
3. **Hand analysis**: Solver evaluates every hero postflop decision in parallel → injects `SOLVER GROUND TRUTH` block into LLM analysis prompt
4. **Fallback**: If solver is down, all paths fall back to LLM

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
