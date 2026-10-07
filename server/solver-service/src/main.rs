use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use postflop_solver::*;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// 1 bb = 100 chips — gives us 0.01bb precision without floats in the tree
const SCALE: i32 = 100;

// ── Request / Response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct SolveRequest {
    board: Vec<String>,             // ["Ah","Kd","7c"] — 3, 4, or 5 cards
    oop_range: String,              // postflop-solver range string
    ip_range: String,
    pot: f64,                       // big blinds
    effective_stack: f64,           // big blinds
    street: String,                 // "Flop" | "Turn" | "River"
    street_history: Vec<HistoryAction>, // actions taken THIS street before acting player
    acting_player_hand: String,     // "AcKs" — the player whose strategy we want
    acting_player_is_ip: bool,      // true if that player is in-position
    iterations: Option<u32>,        // CFR iterations; defaults to 50
    bet_sizes: Option<String>,      // single-size tree, e.g. "33%" / "75%"; defaults to env BET_SIZES
}

/// Same spot as `SolveRequest` without an acting player: warms the cache.
#[derive(Deserialize)]
struct PresolveRequest {
    board: Vec<String>,
    oop_range: String,
    ip_range: String,
    pot: f64,
    effective_stack: f64,
    street: String,
    bet_sizes: Option<String>,
}

#[derive(Deserialize)]
struct HistoryAction {
    action: String,          // "fold" | "check" | "call" | "bet" | "raise"
    amount: Option<f64>,     // big blinds (only for bet/raise)
}

#[derive(Serialize, Debug)]
struct ActionFreq {
    action: String,
    amount: Option<f64>, // big blinds
    frequency: f32,
}

#[derive(Serialize, Debug)]
struct SolveResponse {
    action_frequencies: Vec<ActionFreq>,
    sampled_action: String,
    sampled_amount: Option<f64>,
    ev: f64,            // big blinds
    equity: f64,        // 0–1
    exploitability: f64, // % of pot
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn action_to_str(a: &Action) -> (String, Option<f64>) {
    match a {
        Action::Fold      => ("fold".into(),  None),
        Action::Check     => ("check".into(), None),
        Action::Call      => ("call".into(),  None),
        Action::Bet(n)    => ("bet".into(),   Some(*n as f64 / SCALE as f64)),
        Action::Raise(n)  => ("raise".into(), Some(*n as f64 / SCALE as f64)),
        Action::AllIn(n)  => ("raise".into(), Some(*n as f64 / SCALE as f64)),
        _                 => ("check".into(), None),
    }
}

// Find the action in `available` that best matches the history entry.
fn match_action(available: &[Action], entry: &HistoryAction) -> usize {
    let target_chips = entry.amount.map(|a| (a * SCALE as f64) as i32);

    // Exact type match for non-bet actions
    for (i, a) in available.iter().enumerate() {
        match (&entry.action as &str, a) {
            ("check", Action::Check) | ("fold", Action::Fold) | ("call", Action::Call) => return i,
            _ => {}
        }
    }

    // For bet/raise: nearest available size
    if matches!(entry.action.as_str(), "bet" | "raise") {
        if let Some(target) = target_chips {
            let best = available
                .iter()
                .enumerate()
                .filter_map(|(i, a)| match a {
                    Action::Bet(n) | Action::Raise(n) | Action::AllIn(n) => {
                        Some((i, (n - target).abs()))
                    }
                    _ => None,
                })
                .min_by_key(|&(_, diff)| diff);
            if let Some((i, _)) = best {
                return i;
            }
        }
        // No amount given: first bet/raise available
        for (i, a) in available.iter().enumerate() {
            if matches!(a, Action::Bet(_) | Action::Raise(_) | Action::AllIn(_)) {
                return i;
            }
        }
    }

    0 // fallback
}


// ── Solved-tree cache ────────────────────────────────────────────────────────
//
// A solve covers every node of the street's tree, so one flop solve answers the
// villain's action, every later query on that street, and the post-hand grading
// of each hero decision. Games are cached by spot and reused; identical
// concurrent requests coalesce onto one solve via a per-spot async mutex.

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct SpotKey {
    board: Vec<String>,
    street: String,
    oop_range: String,
    ip_range: String,
    pot_chips: i32,
    stack_chips: i32,
    bet_sizes: String,
}

struct Solved {
    game: Mutex<PostFlopGame>,
    bytes: u64,
    exploitability_pct: f64,
    last_used: Mutex<Instant>,
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Solved>>>>;

struct Cache {
    slots: Mutex<HashMap<SpotKey, Slot>>,
    budget_bytes: u64,
    /// Entries used within this window are never evicted, even over budget: a flop
    /// tree can be bigger than the whole budget (a 33%-size BTN-vs-BB flop is ~3.6GB)
    /// and evicting it mid-hand means paying the solve again for the turn and the grading.
    grace: Duration,
}

impl Cache {
    fn slot(&self, key: &SpotKey) -> Slot {
        self.slots.lock().unwrap().entry(key.clone()).or_default().clone()
    }

    /// Drop least-recently-used solved games until the cache fits its budget.
    fn evict(&self, keep: &SpotKey) {
        let slots = self.slots.lock().unwrap();
        let mut entries: Vec<(SpotKey, u64, Instant)> = Vec::new();
        for (k, slot) in slots.iter() {
            let Ok(g) = slot.try_lock() else { continue };
            if let Some(solved) = g.as_ref() {
                let bytes = solved.bytes;
                let used = *solved.last_used.lock().unwrap();
                entries.push((k.clone(), bytes, used));
            }
        }
        drop(slots);
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        entries.sort_by_key(|e| e.2); // oldest first
        for (k, bytes, used) in entries {
            if total <= self.budget_bytes { break; }
            if &k == keep || used.elapsed() < self.grace { continue; }
            self.slots.lock().unwrap().remove(&k);
            total -= bytes;
            eprintln!("[cache] evicted {:?} {} ({}MB)", k.board, k.street, bytes / 1_000_000);
        }
    }
}

type AppState = Arc<Cache>;

fn env_flag(name: &str, default: bool) -> bool {
    std::env::var(name).map(|v| matches!(v.as_str(), "1" | "true" | "yes")).unwrap_or(default)
}
fn env_num(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn default_bet_sizes() -> String { std::env::var("BET_SIZES").unwrap_or_else(|_| "75%".into()) }

fn spot_key(board: &[String], street: &str, oop: &str, ip: &str, pot: f64, stack: f64, bet_sizes: Option<&str>) -> SpotKey {
    SpotKey {
        board: board.to_vec(),
        street: street.to_string(),
        oop_range: oop.to_string(),
        ip_range: ip.to_string(),
        pot_chips: (pot * SCALE as f64) as i32,
        stack_chips: (stack * SCALE as f64) as i32,
        bet_sizes: bet_sizes.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(default_bet_sizes),
    }
}

/// Get the solved game for a spot, solving it (once) if nobody has yet.
async fn ensure_solved(cache: &AppState, key: SpotKey, iterations: Option<u32>) -> Result<Arc<Solved>, String> {
    let slot = cache.slot(&key);
    let mut guard = slot.lock().await;
    if let Some(solved) = guard.as_ref() {
        *solved.last_used.lock().unwrap() = Instant::now();
        return Ok(solved.clone());
    }
    let k = key.clone();
    let solved = tokio::task::spawn_blocking(move || build_and_solve(&k, iterations))
        .await
        .map_err(|e| format!("solver panicked: {e}"))??;
    let solved = Arc::new(solved);
    *guard = Some(solved.clone());
    drop(guard);
    cache.evict(&key);
    Ok(solved)
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn solve(State(cache): State<AppState>, Json(req): Json<SolveRequest>) -> Result<Json<SolveResponse>, (StatusCode, String)> {
    let key = spot_key(&req.board, &req.street, &req.oop_range, &req.ip_range, req.pot, req.effective_stack, req.bet_sizes.as_deref());
    let solved = ensure_solved(&cache, key, req.iterations).await
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    // Reading a strategy is milliseconds, but it needs &mut game: do it off the async runtime.
    tokio::task::spawn_blocking(move || {
        let mut game = solved.game.lock().unwrap();
        query(&mut game, &req, solved.exploitability_pct)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("solver panicked: {e}")))?
    .map(Json)
    .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))
}

/// Kick off a solve in the background and return immediately.
async fn presolve(State(cache): State<AppState>, Json(req): Json<PresolveRequest>) -> (StatusCode, &'static str) {
    let key = spot_key(&req.board, &req.street, &req.oop_range, &req.ip_range, req.pot, req.effective_stack, req.bet_sizes.as_deref());
    tokio::spawn(async move {
        if let Err(e) = ensure_solved(&cache, key, None).await {
            eprintln!("[presolve] failed: {e}");
        }
    });
    (StatusCode::ACCEPTED, "started")
}

// ── Solving ──────────────────────────────────────────────────────────────────

/// Discounted CFR with a convergence check every few iterations (the crate's
/// `solve()` only checks every 10, so it overshoots the target by up to 9).
fn run_solve(game: &mut PostFlopGame, max_iters: u32, target: f32) -> f32 {
    let check_every = env_num("SOLVER_CHECK_EVERY", 5.0).max(1.0) as u32;
    let min_iters   = env_num("SOLVER_MIN_ITERS", 15.0) as u32;
    let mut expl = f32::INFINITY;
    for t in 0..max_iters {
        solve_step(game, t);
        let done = t + 1;
        if done >= min_iters && (done % check_every == 0 || done == max_iters) {
            expl = compute_exploitability(game);
            if expl <= target { break; }
        }
    }
    finalize(game);
    expl
}

fn build_and_solve(key: &SpotKey, iterations: Option<u32>) -> Result<Solved, String> {
    let pot_chips   = key.pot_chips;
    let stack_chips = key.stack_chips;

    let oop_range: Range = key.oop_range.parse().map_err(|e| format!("bad oop_range: {e}"))?;
    let ip_range:  Range = key.ip_range.parse().map_err(|e| format!("bad ip_range: {e}"))?;

    let board = key.board.iter()
        .map(|s| card_from_str(s).map_err(|e| format!("bad board card {s}: {e}")))
        .collect::<Result<Vec<Card>, String>>()?;
    if !(3..=5).contains(&board.len()) {
        return Err(format!("board must have 3-5 cards, got {}", board.len()));
    }

    let flop  = [board[0], board[1], board[2]];
    let turn  = board.get(3).copied().unwrap_or(NOT_DEALT);
    let river = board.get(4).copied().unwrap_or(NOT_DEALT);

    let initial_state = match key.street.as_str() {
        "Turn"  => BoardState::Turn,
        "River" => BoardState::River,
        _       => BoardState::Flop,
    };

    // One size keeps the tree small enough for real-time solving; other sizes map to the
    // nearest one. Set BET_SIZES="33%, 75%" to match the client's presets once timed.
    let bet_sizes = key.bet_sizes.clone();
    let sizes = BetSizeOptions::try_from((bet_sizes.as_str(), "2.5x"))
        .map_err(|e| format!("bad BET_SIZES {bet_sizes:?}: {e}"))?;

    let card_config = CardConfig {
        range: [oop_range, ip_range],
        flop,
        turn,
        river,
    };

    let tree_config = TreeConfig {
        initial_state,
        starting_pot:     pot_chips,
        effective_stack:  stack_chips,
        rake_rate: 0.0,
        rake_cap:  0.0,
        flop_bet_sizes:   [sizes.clone(), sizes.clone()],
        turn_bet_sizes:   [sizes.clone(), sizes.clone()],
        river_bet_sizes:  [sizes.clone(), sizes],
        turn_donk_sizes:  None,
        river_donk_sizes: None,
        // Deep raise wars are collapsed into all-ins; raising these shrinks the tree.
        add_allin_threshold:   env_num("SOLVER_ADD_ALLIN", 1.5),
        force_allin_threshold: env_num("SOLVER_FORCE_ALLIN", 0.4),
        merging_threshold:     env_num("SOLVER_MERGE", 0.1),
    };

    let t0 = std::time::Instant::now();
    let action_tree = ActionTree::new(tree_config).map_err(|e| format!("bad tree config: {e}"))?;
    let mut game = PostFlopGame::with_config(card_config, action_tree).map_err(|e| format!("bad game config: {e}"))?;
    // 16-bit storage halves memory traffic; precision loss is far below our exploitability target.
    let compress = env_flag("SOLVER_COMPRESS", true);
    game.allocate_memory(compress);
    let (mem_u, mem_c) = game.memory_usage();
    let bytes = if compress { mem_c } else { mem_u };
    let t_build = t0.elapsed();

    let iters  = iterations.unwrap_or_else(|| env_num("SOLVER_ITERS", 50.0) as u32);
    let target_pct = env_num("SOLVER_TARGET_PCT", 10.0) as f32;
    let target = pot_chips as f32 * target_pct / 100.0;
    let t1 = std::time::Instant::now();
    let exploitability_chips = run_solve(&mut game, iters, target);
    let exploitability_pct = exploitability_chips as f64 / pot_chips as f64 * 100.0;
    if env_flag("SOLVER_LOG", true) {
        eprintln!(
            "[solve] {} {:?} sizes={} combos={}x{} build={:.2}s solve={:.2}s iters<={} target={}% got={:.1}% mem={}MB{}",
            key.street, key.board, key.bet_sizes, game.private_cards(0).len(), game.private_cards(1).len(),
            t_build.as_secs_f64(), t1.elapsed().as_secs_f64(), iters, target_pct,
            exploitability_pct, bytes / 1_000_000, if compress { " (compressed)" } else { "" },
        );
    }

    Ok(Solved { game: Mutex::new(game), bytes, exploitability_pct, last_used: Mutex::new(Instant::now()) })
}

/// Walk a solved game to the acting player's node and read their strategy.
fn query(game: &mut PostFlopGame, req: &SolveRequest, exploitability: f64) -> Result<SolveResponse, String> {
    game.back_to_root();

    // The tree is rooted at the start of the current street with its cards already
    // dealt, so there is no chance node to play — just replay this street's actions.
    for entry in &req.street_history {
        if game.is_terminal_node() || game.is_chance_node() {
            return Err("street_history runs past the end of the street".into());
        }
        let available = game.available_actions();
        let idx = match_action(&available, entry);
        game.play(idx);
    }
    if game.is_terminal_node() || game.is_chance_node() {
        return Err("no decision left for the acting player on this street".into());
    }

    game.cache_normalized_weights();

    // Whose strategy are we fetching? Determine the current player index.
    // acting_player_is_ip → player index 1; OOP → 0.
    let player_idx = if req.acting_player_is_ip { 1usize } else { 0usize };
    if game.current_player() != player_idx {
        return Err(format!(
            "street_history leaves player {} to act, but the request is for player {player_idx}",
            game.current_player()
        ));
    }

    let available  = game.available_actions();
    let num_actions = available.len();
    let strategy   = game.strategy(); // flat Vec<f32>

    // Locate the acting player's combo.
    if req.acting_player_hand.len() != 4 {
        return Err(format!("bad acting_player_hand: {}", req.acting_player_hand));
    }
    let c1 = card_from_str(&req.acting_player_hand[..2]).map_err(|e| format!("bad hand: {e}"))?;
    let c2 = card_from_str(&req.acting_player_hand[2..]).map_err(|e| format!("bad hand: {e}"))?;
    let private    = game.private_cards(player_idx);
    let num_combos = private.len();

    let combo_idx = private
        .iter()
        .position(|&(a, b)| (a == c1 && b == c2) || (a == c2 && b == c1))
        .ok_or_else(|| format!("{} is not in the acting player's range", req.acting_player_hand))?;

    // strategy layout: action-major → strategy[action_idx * num_combos + combo_idx]
    let mut freqs: Vec<f32> = (0..num_actions)
        .map(|a| {
            let i = a * num_combos + combo_idx;
            if i < strategy.len() { strategy[i] } else { 0.0 }
        })
        .collect();

    // Normalise (weights might not sum to 1 due to dead combos)
    let total: f32 = freqs.iter().sum();
    if total > 0.0 { freqs.iter_mut().for_each(|f| *f /= total); }

    let action_frequencies: Vec<ActionFreq> = available
        .iter()
        .zip(freqs.iter())
        .map(|(a, &freq)| {
            let (action, amount) = action_to_str(a);
            ActionFreq { action, amount, frequency: freq }
        })
        .collect();

    // Weighted random sample
    let mut r: f32 = rand::thread_rng().gen();
    let mut sampled_idx = action_frequencies.len() - 1;
    for (i, af) in action_frequencies.iter().enumerate() {
        if r <= af.frequency { sampled_idx = i; break; }
        r -= af.frequency;
    }
    let sampled_action = action_frequencies[sampled_idx].action.clone();
    let sampled_amount = action_frequencies[sampled_idx].amount;

    // EV and equity for this combo
    let evs      = game.expected_values(player_idx);
    let equities = game.equity(player_idx);
    let ev_bb    = evs.get(combo_idx).copied().unwrap_or(0.0) as f64 / SCALE as f64;
    let equity   = equities.get(combo_idx).copied().unwrap_or(0.5) as f64;
    Ok(SolveResponse {
        action_frequencies,
        sampled_action,
        sampled_amount,
        ev: ev_bb,
        equity,
        exploitability,
    })
}

async fn health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    // 0.0.0.0 (not 127.0.0.1) so the service is reachable from other
    // containers on the Docker network, not just from inside its own container.
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3002".to_string());
    // Solved games are big (a 100bb flop tree is ~2GB compressed); keep a bounded LRU.
    let budget_mb = env_num("SOLVER_CACHE_MB", 3000.0);
    let grace_secs = env_num("SOLVER_CACHE_GRACE_SECS", 600.0);
    let cache: AppState = Arc::new(Cache {
        slots: Mutex::new(HashMap::new()),
        budget_bytes: (budget_mb * 1e6) as u64,
        grace: Duration::from_secs_f64(grace_secs),
    });
    let app = Router::new()
        .route("/solve", post(solve))
        .route("/presolve", post(presolve))
        .route("/health", get(health))
        .with_state(cache);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    println!("Solver service listening on {bind_addr}");
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(board: &[&str], street: &str, history: Vec<HistoryAction>, hand: &str, is_ip: bool) -> SolveRequest {
        SolveRequest {
            board: board.iter().map(|s| s.to_string()).collect(),
            oop_range: "AA,KK,QQ,JJ,AKs,KQs,QJs,JTs,T9s".into(),
            ip_range: "AA,KK,QQ,TT,AKs,AQs,KJs,QJs,JTs".into(),
            pot: 20.0,
            effective_stack: 90.0,
            street: street.into(),
            street_history: history,
            acting_player_hand: hand.into(),
            acting_player_is_ip: is_ip,
            iterations: Some(30),
            bet_sizes: None,
        }
    }

    fn solve_inner(r: SolveRequest) -> Result<SolveResponse, String> {
        let key = spot_key(&r.board, &r.street, &r.oop_range, &r.ip_range, r.pot, r.effective_stack, r.bet_sizes.as_deref());
        let solved = build_and_solve(&key, r.iterations)?;
        let mut game = solved.game.lock().unwrap();
        query(&mut game, &r, solved.exploitability_pct)
    }

    #[test]
    fn river_first_to_act_gets_a_strategy() {
        let r = req(&["Jc", "Ts", "9d", "2h", "3c"], "River", vec![], "AsAh", false);
        let res = solve_inner(r).unwrap();
        assert!(!res.action_frequencies.is_empty());
        assert!(res.action_frequencies.iter().any(|a| a.action == "check"));
    }

    #[test]
    fn turn_ip_after_check_reads_ip_node() {
        let check = HistoryAction { action: "check".into(), amount: None };
        let r = req(&["Jc", "Ts", "9d", "2h"], "Turn", vec![check], "TdTh", true);
        let res = solve_inner(r).unwrap();
        let total: f32 = res.action_frequencies.iter().map(|a| a.frequency).sum();
        assert!((total - 1.0).abs() < 1e-3);
        // IP facing a check can check or bet, never call or fold
        assert!(res.action_frequencies.iter().all(|a| a.action == "check" || a.action == "bet" || a.action == "raise"));
    }

    #[test]
    fn hand_outside_range_is_an_error() {
        let r = req(&["Jc", "Ts", "9d", "2h", "3c"], "River", vec![], "7c2d", false);
        assert!(solve_inner(r).unwrap_err().contains("not in the acting player's range"));
    }

    #[test]
    fn wrong_player_to_act_is_an_error() {
        // OOP acts first on the river, so asking for IP with no history is a mismatch
        let r = req(&["Jc", "Ts", "9d", "2h", "3c"], "River", vec![], "TdTh", true);
        assert!(solve_inner(r).unwrap_err().contains("to act"));
    }

    // Timing check on a real BTN-vs-BB flop: cargo test --release -- --ignored --nocapture
    #[test]
    #[ignore]
    fn time_real_flop_solve() {
        let path = std::env::var("FLOP_REQ").unwrap_or_else(|_| "/tmp/flop_req.json".into());
        let body = std::fs::read_to_string(&path).expect("set FLOP_REQ to a request json");
        let mut r: SolveRequest = serde_json::from_str(&body).unwrap();
        r.iterations = None; // let SOLVER_ITERS drive it
        let t = std::time::Instant::now();
        let res = solve_inner(r).unwrap();
        eprintln!("TOTAL {:.2}s exploitability {:.1}% threads={}",
            t.elapsed().as_secs_f64(), res.exploitability, rayon::current_num_threads());
        // Second query on the same solved game must be instant.
        let r2: SolveRequest = serde_json::from_str(&body).unwrap();
        let key = spot_key(&r2.board, &r2.street, &r2.oop_range, &r2.ip_range, r2.pot, r2.effective_stack, r2.bet_sizes.as_deref());
        let solved = build_and_solve(&key, Some(1)).unwrap();
        let t = std::time::Instant::now();
        for _ in 0..3 { let mut g = solved.game.lock().unwrap(); query(&mut g, &r2, solved.exploitability_pct).unwrap(); }
        eprintln!("3 cached queries in {:.3}s", t.elapsed().as_secs_f64());
    }
}
