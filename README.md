# AI Poker Coach

Play heads-up poker hands against a solver-driven villain and get coaching on every decision. A Rust game-theory solver computes the GTO strategy; an LLM explains *why* instead of guessing.

## How it works

1. **Preflop** — the LLM (LLaMA 3.3 70B via Groq) plays the villain using position-based opening and defending ranges.
2. **Postflop villain action** — the Rust solver computes GTO action frequencies for the current spot, the villain samples an action from them, and the LLM writes a one- or two-sentence explanation of the play.
3. **Hand analysis** — after the hand, the solver evaluates every hero postflop decision in parallel and the results are injected into the LLM prompt as ground truth, so the coaching is grounded in the solver's numbers.
4. **Fallback** — if the solver is unavailable, every path falls back to the LLM alone.

Villain hole cards are never revealed during play; they're shown only in the post-hand analysis.

## Architecture

| Service | Directory | Stack |
|---|---|---|
| Client | `client/` | React, TypeScript, Vite, Tailwind CSS (nginx in Docker) |
| API server | `server/` | Node.js, Express, TypeScript, Prisma |
| GTO solver | `server/solver-service/` | Rust, Axum, [postflop-solver](https://github.com/b-inary/postflop-solver) (DCFR) |
| Database | — | PostgreSQL |

All four run together with Docker Compose (`docker-compose.yml`).

### Solver notes

- Discounted CFR, 50 iterations, 10%-of-pot exploitability target
- Solves run in `spawn_blocking` so the HTTP server stays responsive; river solves are near-instant, flop solves take the longest (tens of seconds on a 4-core Docker VM)
- Tree is rooted at the current street with the board already dealt, then replays the street's action history to reach the decision node
- Integer chip arithmetic (1 bb = 100 chips)
- Bet sizing abstraction defaults to 75% pot; override with `BET_SIZES` (e.g. `"33%, 75%"`)
- Bad inputs (hand outside the modeled range, wrong player to act) return HTTP 422 instead of panicking

## Running with Docker

```bash
cp .env.example .env   # set GROQ_API_KEY
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

`server/.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5432/pokercoach
GROQ_API_KEY=...
SOLVER_URL=http://127.0.0.1:3002
PORT=3001
```

## Tests

```bash
cd server/solver-service && cargo test --release   # tree navigation, strategy lookup
cd server && npm test                              # position / range logic
```

## Key files

```
server/src/lib/openai.ts     hand orchestration: startHand, getVillainAction, analyzeHand
server/src/lib/solver.ts     HTTP client for the Rust solver + LLM explanation layer
server/src/lib/ranges.ts     preflop opening/defending ranges by position
server/src/routes/trainer.ts /start, /action, /analyze
server/solver-service/src/main.rs   Axum service, POST /solve
client/src/components/HandTrainer.tsx   game UI
```
