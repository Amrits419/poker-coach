# AI Poker Coach

Play heads-up poker hands against a solver-driven villain and get coaching on every decision. A Rust game-theory solver computes the GTO strategy; an LLM explains *why* instead of guessing.

## How it works

1. **Preflop** — the villain plays from position-based opening, 3-bet, and defending range tables, with the LLM (an open-weight model served by Groq, `openai/gpt-oss-120b` by default) narrating the decision.
2. **Postflop villain action** — the Rust solver computes GTO action frequencies for the current spot, the villain samples an action from them, and the LLM writes a one- or two-sentence explanation of the play. An out-of-position villain never leads into the preflop aggressor (it checks, and can check-raise); an in-position villain bets when checked to or raises when the solver says so.
3. **Hand analysis** — after the hand, every hero postflop decision is graded by the solver (the spots are already cached from play, so grading is instant) and the numbers are injected into the LLM prompt as ground truth. Preflop decisions are graded against the range tables: 3-bet / 4-bet ranges are checked first, so premium pairs are never mistaken for set-mining calls.
4. **Fallback** — if the solver is unavailable, every path falls back to the LLM alone, with the LLM's sizing and legality clamped server-side.

Villain hole cards are never revealed during play; they're shown only in the post-hand analysis.

## Playing

The setup screen picks the hero's seat (all eight positions), heads-up or multiway, the effective stack (25–200bb), and the **solver bet size** (33 / 50 / 75 / 100% of pot) used for the hand. The table shows the blinds and the open or 3-bet as chips in front of each seat, the dealer button, the pot and pot odds, a pulsing ring on the seat to act, and a hand log with colored action tags. Hero bets with a slider or presets (fractions of the pot, or multiples of the bet when facing one). After the hand: a score, the coach's verdict, a decision-by-decision breakdown with the better play, what the villain was doing on each street, and drills to run next. The Stats tab aggregates leaks across saved hands.

## Architecture

| Service | Directory | Stack |
|---|---|---|
| Client | `client/` | React, TypeScript, Vite, Tailwind CSS (nginx in Docker) |
| API server | `server/` | Node.js, Express, TypeScript, Prisma |
| GTO solver | `server/solver-service/` | Rust, Axum, [postflop-solver](https://github.com/b-inary/postflop-solver) (DCFR) |
| Database | — | PostgreSQL |

All four run together with Docker Compose (`docker-compose.yml`).

### Solver notes

- Discounted CFR to a 10%-of-pot exploitability target (checked every 5 iterations after 15; converges in ~30), capped at 50
- **Solved trees are cached** by spot (board, ranges, street-start pot and stack, street, bet size) in a memory-bounded LRU, and identical concurrent requests coalesce onto one solve. A flop solve therefore answers the villain's action, every later query on that street, and the post-hand grading of each decision in milliseconds. The API server replays the hand history to derive the street-start pot and stack with the same arithmetic the client uses, so play and grading always hit the same cache entry; trees used in the last 10 minutes are never evicted, even when one tree exceeds the budget
- **Speculative pre-solving:** `POST /presolve` warms the cache; the API server calls it when a hand is dealt (for predictable preflop lines) and again the moment preflop closes, so the flop is usually solved before the user looks at it
- 16-bit compressed storage (half the memory, ~20% faster); deep raise wars collapse into all-ins (`force_allin_threshold` 0.4), which halves solve time and memory at the same exploitability
- Measured on an M2 (8 threads): a 100bb BTN-vs-BB flop at 75% solves in ~12-15 s and uses ~1.1 GB; turn/river solves take a second or less. Smaller bet sizes allow more raise rounds, so their trees are bigger (33% is 2-3.6 GB and solves proportionally slower)
- Solves run in `spawn_blocking` so the HTTP server stays responsive
- Tree is rooted at the current street with the board already dealt, then replays the street's action history to reach the decision node
- Integer chip arithmetic (1 bb = 100 chips)
- One bet size per street keeps the tree small. The size is chosen per hand on the setup screen (33 / 50 / 75 / 100% of pot) and travels with the request (`bet_sizes`), so each size is its own cached tree; `BET_SIZES` is the server default
- Knobs (env): `BET_SIZES` (default `75%`), `SOLVER_TARGET_PCT`, `SOLVER_ITERS`, `SOLVER_FORCE_ALLIN`, `SOLVER_ADD_ALLIN`, `SOLVER_COMPRESS`, `SOLVER_CACHE_MB`, `SOLVER_CACHE_GRACE_SECS` (recently used trees are never evicted, default 600 s)
- Bad inputs (wrong player to act, malformed ranges) return HTTP 422 instead of panicking. The hero can be dealt a hand outside the modeled preflop range (that is the preflop lesson); the server adds that exact combo to the hero's range so the postflop decisions can still be graded

## Running with Docker

```bash
cp .env.example .env   # set GROQ_API_KEY (and LLM_MODEL if you want a different Groq model)
docker compose up --build
```

Open http://localhost:5173. The client container proxies `/api` to the server, the server runs `prisma migrate deploy` on start, and Postgres data persists in the `postgres-data` volume. The first build compiles the Rust solver, which takes a few minutes.

## Running manually

```bash
# Terminal 1 — solver
cd server/solver-service
cargo build --release
./target/release/solver-service          # listens on 0.0.0.0:3002

# Terminal 2 — API server
cd server                                # create server/.env first (see below)
npx prisma migrate dev
npm run dev                              # http://localhost:3001

# Terminal 3 — client
cd client
npm run dev                              # http://localhost:5173, proxies /api to :3001
```

To leave RAM for other apps, cap the solver: `RAYON_NUM_THREADS=4 SOLVER_CACHE_MB=2500 ./target/release/solver-service` (a flop solve still needs the whole tree in memory, 1–3.6 GB depending on the bet size).

`server/.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5432/pokercoach
GROQ_API_KEY=...
LLM_MODEL=openai/gpt-oss-120b   # any chat model on https://console.groq.com/docs/models
SOLVER_URL=http://127.0.0.1:3002
SOLVER_TIMEOUT_MS=120000         # fall back to the LLM if a solve takes longer
PORT=3001
```

`gpt-oss` is a reasoning model: calls with a `max_tokens` cap pass `reasoning_effort: low`, otherwise the reasoning consumes the budget and the visible text is truncated.

## Tests

```bash
cd server/solver-service && cargo test --release   # tree navigation, strategy lookup
cd server && npm test                              # position logic, preflop range verdicts, street-start pot/stack replay
```

## Key files

```
server/src/lib/openai.ts     hand orchestration: startHand, getVillainAction, analyzeHand (+ preflop coaching context)
server/src/lib/solver.ts     HTTP client for the Rust solver, pre-solve, street-start pot/stack replay, LLM explanations
server/src/lib/ranges.ts     preflop opening / 3-bet / 4-bet / defending ranges by position
server/src/routes/trainer.ts /start, /villain-act, /analyze (+ speculative pre-solve)
server/solver-service/src/main.rs   Axum service: POST /solve, POST /presolve, cache
client/src/components/Setup.tsx          position, stack, bet-size setup
client/src/components/HandTrainer.tsx    table, action bar, hand log
client/src/components/AnalysisResult.tsx post-hand coaching view
client/src/components/LeakDashboard.tsx  stats tab
```
