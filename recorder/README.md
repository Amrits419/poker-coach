# Poker Recorder

> **Work in progress.** Capture works for every table below, and PokerNow sessions are
> graded end to end from the downloaded game log. Reports from screen-read sessions
> (ClubGG and the other desktop apps) are in the works: those sessions are saved but not
> graded yet.

A small macOS menu-bar app that keeps a text log of the poker table while you play and
gives you a Poker Coach report when you end the session. It captures ClubGG, PokerNow
in the browser, and other desktop poker apps (PokerStars, GGPoker, WPT Global, ACR, …).

- **Start session**: whenever the table changes (checked twice a second), it reads the
  window with Apple Vision and appends one line of text to `table.jsonl`: the text on the
  table (stacks, bets, pot, action labels) with positions, and every card region with a
  small numeric fingerprint of its corner. **No screenshots are saved**, and nothing is
  shown while you play.
- **End session and get report**: opens the session in Poker Coach.
- **PokerNow**: download the game log during the session (Log → Download). On End, the
  newest `poker_now_log_*.csv` in Downloads is copied into the session and used instead of
  screen reading, because it is exact.
- **Table** menu: Any poker table (auto) · ClubGG · PokerNow (browser) · Other poker apps.

Session folders: `~/Library/Application Support/PokerRecorder/sessions/<timestamp>/`
(`table.jsonl`, `session.json`, optionally `pokernow_log.csv`).

## Build and run

```bash
./make-app.sh                                  # builds and ad-hoc signs build/PokerRecorder.app
open build/PokerRecorder.app                   # ♠ appears in the menu bar
open build/PokerRecorder.app --args --start    # start a session as soon as it is ready
```

The first launch loads Apple Vision's models (~45 s, menu shows ♠…). The first session asks
for Screen Recording permission (System Settings › Privacy & Security › Screen Recording).
Poker Coach must be running (`localhost:5173`; override with `POKER_COACH_URL`).

Test the reader on any image: `.build/release/pokerrec read table.png`
(measured: ~0.28 s per window, ~90 text items and the card regions).

## Status

- PokerNow via its log: complete (import, hero detection, grading).
- Screen-read tables (ClubGG and others): the text log is complete. Rebuilding hands from it
  needs a one-time calibration from a real session: which seat is where, and which card
  fingerprint is which rank and suit (Vision does not read single card ranks). Until then
  those sessions show as "Recorded" with what was logged.

Use play-money tables while developing: ClubGG's terms restrict third-party software that
collects game data.
