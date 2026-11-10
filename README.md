# AI Poker Coach

Play poker hands, heads-up or multiway, against a solver-driven villain and get coaching on every decision, or import a real session and have every hand graded. A Rust game-theory solver computes the GTO strategy; an LLM explains *why* instead of guessing.

## How it works

1. **Preflop** — the villain plays from position-based opening, defending, 3-bet, 4-bet and call-a-jam range tables, so 3-bet and 4-bet pots play out properly and carry the right ranges to the flop.
2. **Postflop villain action** — the Rust solver computes GTO action frequencies for the current spot and the villain samples an action from them. An LLM (an open-weight model served by Groq, `openai/gpt-oss-120b` by default) writes a one- or two-sentence explanation of each play in the background, shown after the hand. An out-of-position villain never donk-bets into your initiative (it checks, and can check-raise); with the initiative itself, or in position, it bets and raises as the solver says. Multiway streets and limped pots are outside the two-player solver, so the LLM plays the villain there with its action clamped to a legal one.
3. **Hand analysis** — after the hand, every hero postflop decision is graded by the solver (the spots are already cached from play, so grading is instant) and the numbers are injected into the LLM prompt as ground truth. Preflop decisions are graded against the range tables: 3-bet / 4-bet ranges are checked first, so premium pairs are never mistaken for set-mining calls.
4. **Fallback** — if the solver is unavailable, every path falls back to the LLM alone, with the LLM's sizing and legality clamped server-side.

Villain hole cards are never revealed during play; they're shown only in the post-hand analysis.

## Playing

The setup screen picks the hero's seat (all eight positions), heads-up or multiway, the effective stack (25–200bb), and the **solver bet size** (33 / 50 / 75 / 100% of pot) used for the hand. The table shows the blinds and the open or 3-bet as chips in front of each seat, the dealer button, the pot and pot odds, a pulsing ring on the seat to act, and a hand log with colored action tags. Hero bets with a slider or presets (fractions of the pot, or multiples of the bet when facing one), or from the keyboard (F fold, C check/call, R bet/raise). The server's hand engine is the single source of truth for the pot, stacks, legal bet sizes and whose turn it is; an all-in and a call runs the board out. After the hand: who won and for how much, a score, the coach's verdict, a decision-by-decision breakdown with the better play, what the villain was doing on each street, and drills to run next. The Stats tab aggregates leaks across saved hands.

## Sessions: grade your real hands

The **Sessions** tab imports a hand-history file in PokerStars format (PokerStars, GGPoker exports, or a PokerNow log run through a converter) and grades every hand you were dealt:

- **Hands that end preflop for you** are graded instantly from the range tables (open, defend, 3-bet, 4-bet), with no LLM call. Spots the tables only approximate, like limped pots, cold calls and straddles, are labelled.
- **Heads-up postflop hands** go to the solver. The importer works out positions for 2–10 players, assumes each player's range from their preflop line (open vs defend, 3-bet vs call, 4-bet vs call), computes the exact street-start pot including dead money, and snaps real bet sizes to the nearest 50/75/100% tree. The coach then explains the solver's numbers.
- **Multiway pots and unmodelled lines** are graded by the coach alone and badged "Coach only".

The rundown shows hands played, VPIP/PFR, result in bb and bb/100, an average score over the hands you played, your biggest mistakes, leaks grouped by spot (e.g. "Preflop · facing an open · call", "Turn · call"), results by position, and a filterable hand list. Each hand opens the same coaching view as the trainer plus the solver's action mix, the assumed ranges, the sizing note and the raw hand text. Grading runs in the background, persists per hand, and resumes after a server restart; Groq rate limits are retried with backoff.

PokerNow logs (the .csv from Log → Download) import directly.

### Poker Recorder (work in progress)

For sites without an export, like ClubGG, [`recorder/`](recorder/README.md) is a small menu-bar app (Swift, ScreenCaptureKit + Apple Vision) that keeps a **text-only** log of the table while you play (no screenshots) and opens the report when you end the session. Nothing is shown during play.

- **Working today:** capturing the table to a text log, and PokerNow sessions, where the recorder picks up the game log you downloaded and the hands are graded.
- **In the works:** turning a screen-read log (ClubGG and other desktop apps) into hands. That needs card recognition calibrated from a real session, so those sessions are saved but not graded yet (plan: [`docs/SESSION_RECORDER_PLAN.md`](docs/SESSION_RECORDER_PLAN.md)).

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
- **Solved trees are cached** by spot (board, ranges, street-start pot and stack, street, bet size) in a memory-bounded LRU, and identical concurrent requests coalesce onto one solve. A flop solve therefore answers the villain's action, every later query on that street, and the post-hand grading of each decision in milliseconds. Every solver request (villain action, pre-solve, grading) is built in one place from the hand engine's replay of the action history, so play and grading always hit the same cache entry; trees used in the last 10 minutes are never evicted, even when one tree exceeds the budget
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

## How a trainer hand runs

The hand engine (`server/src/lib/engine.ts`) is a pure function: `replay(setup, startState, history)` turns the list of actions so far into the pot, every stack, the legal bet sizes, whose turn it is, and, once the hand is over, who won. The client keeps only that action list and draws the table state the server sends back:

| Route | When | Returns |
|---|---|---|
| `POST /api/trainer/start` | deal a hand | cards, blinds and the first table state |
| `POST /api/trainer/table` | after each hero action | the new table state |
| `POST /api/trainer/villain-act` | while a villain is to act (one villain per call) | the villain's action and the new table state |
| `POST /api/trainer/explain` | in the background | the coach's wording for a villain action |
| `POST /api/trainer/analyze` | hand over | grades, coaching and the result |

Bets and raises are recorded as the total in front of the player on that street ("raise to"), calls as the total called to, in big blinds to 0.01.

Known limits: the solver covers heads-up streets in raised pots only, so multiway streets and limped pots are played and graded by the LLM; the solver tree has one bet size per street, so the villain's sizing does not vary within a hand.

## Tests

```bash
cd server/solver-service && cargo test --release   # tree navigation, strategy lookup
cd server && npm test                              # hand engine, hand evaluator, villain preflop policy, position logic, hand-history import
```

The server tests need neither the database nor the solver. The hand-history fixtures in `server/src/lib/hh/__fixtures__/` are real hands with every player name, id and date replaced.

## Key files

```
server/src/lib/openai.ts     hand orchestration: startHand, getVillainAction, analyzeHand (+ preflop coaching context)
server/src/lib/engine.ts     the hand engine: replays a hand's actions into pot, stacks, whose turn it is and the result
server/src/lib/handEval.ts   best five of seven cards, for showdowns
server/src/lib/solver.ts     HTTP client for the Rust solver, the solver spot for a street, pre-solve, LLM explanations
server/src/lib/ranges.ts     preflop opening / 3-bet / 4-bet / defending ranges by position
server/src/routes/trainer.ts /start, /table, /villain-act, /explain, /analyze (+ speculative pre-solve)
server/src/routes/sessions.ts  /preview, /import, session + hand reads, /:id/regrade
server/src/lib/hh/           PokerStars parser, positions, preflop range verdicts, hand → solver spots
server/src/lib/session/      background grader (triage, retries) and session summary
server/solver-service/src/main.rs   Axum service: POST /solve, POST /presolve, cache
client/src/components/Setup.tsx          position, stack, bet-size setup
client/src/components/HandTrainer.tsx    table, action bar, hand log
client/src/components/AnalysisResult.tsx post-hand coaching view
client/src/components/LeakDashboard.tsx  stats tab
client/src/components/sessions/          import, session rundown, hand drill-down
```
