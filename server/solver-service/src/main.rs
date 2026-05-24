use axum::{routing::post, Json, Router};
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
}

#[derive(Deserialize)]
struct HistoryAction {
    action: String,          // "fold" | "check" | "call" | "bet" | "raise"
    amount: Option<f64>,     // big blinds (only for bet/raise)
}

#[derive(Serialize)]
struct ActionFreq {
    action: String,
    amount: Option<f64>, // big blinds
    frequency: f32,
}

#[derive(Serialize)]
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

// Navigate a chance node (turn or river card deal) using the board string.
fn play_chance_card(game: &mut PostFlopGame, card_str: &str) {
    let card = card_from_str(card_str).expect("invalid card in board");
    let available = game.available_actions();
    let idx = available
        .iter()
        .position(|a| matches!(a, Action::Chance(c) if *c == card))
        .unwrap_or(0);
    game.play(idx);
}

// ── Handler ──────────────────────────────────────────────────────────────────

async fn solve(Json(req): Json<SolveRequest>) -> Json<SolveResponse> {
    // Run the CPU-heavy solve on a blocking thread so we don't stall the async runtime.
    tokio::task::spawn_blocking(move || solve_inner(req))
        .await
        .expect("solver panicked")
}

fn solve_inner(req: SolveRequest) -> Json<SolveResponse> {
    let pot_chips   = (req.pot            * SCALE as f64) as i32;
    let stack_chips = (req.effective_stack * SCALE as f64) as i32;

    let oop_range: Range = req.oop_range.parse().unwrap_or_default();
    let ip_range:  Range = req.ip_range.parse().unwrap_or_default();

    let board: Vec<Card> = req.board.iter()
        .map(|s| card_from_str(s).expect("invalid card"))
        .collect();

    let flop  = [board[0], board[1], board[2]];
    let turn  = board.get(3).copied().unwrap_or(NOT_DEALT);
    let river = board.get(4).copied().unwrap_or(NOT_DEALT);

    let initial_state = match req.street.as_str() {
        "Turn"  => BoardState::Turn,
        "River" => BoardState::River,
        _       => BoardState::Flop,
    };

    // 1 bet size (75 % pot) keeps the tree small enough for real-time solving (~2-3 s).
    let sizes = BetSizeOptions::try_from(("75%", "2.5x")).unwrap();

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

    let action_tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, action_tree).unwrap();
    game.allocate_memory(false);

    // 50 iterations / 10 % pot target — fast enough for real-time, accurate enough for coaching
    let target = pot_chips as f32 * 0.10;
    let exploitability_chips = postflop_solver::solve(&mut game, 50, target, false);

    // Navigate to current node by replaying street_history.
    // Turn and river boards need a chance node played between streets.
    if req.street == "Turn" && turn != NOT_DEALT {
        play_chance_card(&mut game, &req.board[3]);
    } else if req.street == "River" && river != NOT_DEALT {
        play_chance_card(&mut game, &req.board[3]);
        play_chance_card(&mut game, &req.board[4]);
    }

    for entry in &req.street_history {
        let available = game.available_actions();
        let idx = match_action(&available, entry);
        game.play(idx);
    }

    game.cache_normalized_weights();

    // Whose strategy are we fetching? Determine the current player index.
    // acting_player_is_ip → player index 1; OOP → 0.
    let player_idx = if req.acting_player_is_ip { 1usize } else { 0usize };

    let available  = game.available_actions();
    let num_actions = available.len();
    let strategy   = game.strategy(); // flat Vec<f32>

    // Locate the acting player's combo.
    let c1 = card_from_str(&req.acting_player_hand[..2]).unwrap();
    let c2 = card_from_str(&req.acting_player_hand[2..]).unwrap();
    let private    = game.private_cards(player_idx);
    let num_combos = private.len();

    let combo_idx = private
        .iter()
        .position(|&(a, b)| (a == c1 && b == c2) || (a == c2 && b == c1))
        .unwrap_or(0);

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

    Json(SolveResponse {
        action_frequencies,
        sampled_action,
        sampled_amount,
        ev: ev_bb,
        equity,
        exploitability,
    })
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/solve", post(solve));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3002").await.unwrap();
    println!("Solver service listening on 127.0.0.1:3002");
    axum::serve(listener, app).await.unwrap();
}
