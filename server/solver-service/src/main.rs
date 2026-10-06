use axum::{http::StatusCode, routing::{get, post}, Json, Router};
use postflop_solver::*;
use rand::Rng;
use serde::{Deserialize, Serialize};

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

// ── Handler ──────────────────────────────────────────────────────────────────

async fn solve(Json(req): Json<SolveRequest>) -> Result<Json<SolveResponse>, (StatusCode, String)> {
    // Run the CPU-heavy solve on a blocking thread so we don't stall the async runtime.
    tokio::task::spawn_blocking(move || solve_inner(req))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("solver panicked: {e}")))?
        .map(Json)
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))
}

fn solve_inner(req: SolveRequest) -> Result<SolveResponse, String> {
    let pot_chips   = (req.pot            * SCALE as f64) as i32;
    let stack_chips = (req.effective_stack * SCALE as f64) as i32;

    let oop_range: Range = req.oop_range.parse().map_err(|e| format!("bad oop_range: {e}"))?;
    let ip_range:  Range = req.ip_range.parse().map_err(|e| format!("bad ip_range: {e}"))?;

    let board = req.board.iter()
        .map(|s| card_from_str(s).map_err(|e| format!("bad board card {s}: {e}")))
        .collect::<Result<Vec<Card>, String>>()?;
    if !(3..=5).contains(&board.len()) {
        return Err(format!("board must have 3-5 cards, got {}", board.len()));
    }

    let flop  = [board[0], board[1], board[2]];
    let turn  = board.get(3).copied().unwrap_or(NOT_DEALT);
    let river = board.get(4).copied().unwrap_or(NOT_DEALT);

    let initial_state = match req.street.as_str() {
        "Turn"  => BoardState::Turn,
        "River" => BoardState::River,
        _       => BoardState::Flop,
    };

    // One size keeps the tree small enough for real-time solving; other sizes map to the
    // nearest one. Set BET_SIZES="33%, 75%" to match the client's presets once timed.
    let bet_sizes = std::env::var("BET_SIZES").unwrap_or_else(|_| "75%".into());
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
        add_allin_threshold:   1.5,
        force_allin_threshold: 0.15,
        merging_threshold:     0.1,
    };

    let action_tree = ActionTree::new(tree_config).map_err(|e| format!("bad tree config: {e}"))?;
    let mut game = PostFlopGame::with_config(card_config, action_tree).map_err(|e| format!("bad game config: {e}"))?;
    game.allocate_memory(false);

    let iters = req.iterations.unwrap_or(50);
    let target = pot_chips as f32 * 0.10;
    let exploitability_chips = postflop_solver::solve(&mut game, iters, target, false);

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
    let exploitability = exploitability_chips as f64 / pot_chips as f64 * 100.0;

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
    let app = Router::new()
        .route("/solve", post(solve))
        .route("/health", get(health));
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
        }
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
        let body = std::fs::read_to_string("/tmp/flop_req.json").expect("write /tmp/flop_req.json first");
        let r: SolveRequest = serde_json::from_str(&body).unwrap();
        let t = std::time::Instant::now();
        let res = solve_inner(r).unwrap();
        eprintln!("BET_SIZES={:?} solved in {:.1}s, exploitability {:.1}% pot",
            std::env::var("BET_SIZES").unwrap_or_default(), t.elapsed().as_secs_f64(), res.exploitability);
    }
}
