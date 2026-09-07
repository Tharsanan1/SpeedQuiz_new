# AGENTS.md — Speed Quiz

> Instructions and context for AI coding agents working on this repo.

## What this is

Speed Quiz is a real-time multiplayer browser quiz game. One person runs the
server on their laptop and shares a link; 10–25 players join from their own
browsers. No installs for players, no database, no accounts. The server hosts
exactly ONE game at a time (no room codes).

- **Stack:** Node.js 20+, Express, Socket.IO (server-authoritative).
- **Frontend:** vanilla HTML/CSS/JS served statically by Express. No React,
  no build step, no CDN required (Socket.IO client is served by the server
  itself at `/socket.io/socket.io.js`).
- **Run:** `npm install && npm start` → port 3000 (`PORT` env configurable).
- **Repo:** https://github.com/Tharsanan1/SpeedQuiz_new (public).

## Layout

```
server.js              # Express + Socket.IO, ALL game logic (single file, one game)
questions.json         # question bank (array of objects, see below)
public/index.html      # landing: Create Game (count + mode) / Join Game (+ inline script)
public/host.html       # host screen (host is also a player, answers too)
public/player.html     # player screen (+ fallback host controls if promoted)
public/app.css         # dark theme, shared by all pages
public/host.js         # host client logic
public/player.js       # player client logic
public/confetti.js     # shared canvas confetti (burstConfetti, celebrateTop)
README.md
```

## Game flow (server.js is the source of truth)

1. **Lobby** — `create-room {name, numQuestions, mode}` /
   `join-room {name, token?}` / `get-status` (no join needed; powers the
   landing-page status line). Host picks question count (5/8/12/15/20,
   validated 1–20 server-side) and mode (`classic` | `mcq`). Creating a game
   replaces any existing one. Host sees the game link
   (`location.origin + '/'`), settings summary, live player list, kick
   buttons. Start unlocks at ≥ 2 **connected** non-spectator players.
2. **Question ×N** — `question {index, total, type, prompt, choices?,
   endsAt, serverTime, lastQuestion}`. `choices` is present only for mcq
   (shuffled fresh per game by `selectQuestions()`; letters map to that
   order). 15 s countdown (`QUESTION_TIME_MS`). Clients compute remaining
   time from `endsAt - Date.now()`. Ends at 0 s or when every active player
   has answered correctly. A correct answer returns ack
   `{ok, correct: true}` with NO points — the client shows a neutral
   "Locked in" state; correctness + points are revealed only at the reveal.
3. **Reveal** (5 s, `REVEAL_TIME_MS`) — correct answer + per-player points,
   fastest first, plus `top` flags + `topPoints` for the round's highest
   scorer(s). Clients fire canvas confetti (`confetti.js`): small burst for
   correct, multi-wave `celebrateTop()` + mega banner for top scorer(s).
4. **Leaderboard** (5 s, `LEADERBOARD_TIME_MS`) — totals sorted, with rank
   changes (`rankChange` > 0 means moved up).
5. **Final** — podium top 3 + full standings. Host `play-again` restarts with
   the SAME settings and new random questions (spectators become players).

**Live leaderboard:** `broadcastLiveBoard()` emits `live-leaderboard
{index, total, standings}` on every correct answer, each new question, and
kicks; `sendCatchUp()` also sends it to (re)joiners. Both `host.html` and
`player.html` render it in an always-visible fixed side panel (`#liveboard`,
hidden in lobby/final via `hideLiveBoard()`).

## Scoring (server only, `scoreFor()`)

- `elapsed = Date.now() - questionStartTime` measured on answer arrival.
- Correct: `points = max(200, 1000 - 50 * floor(elapsed / 1000))`.
  Only the first correct answer per player per question counts.
- Streak bonus: `+100 * (streakAfter - 1)` (2nd consecutive correct +100,
  3rd +200…). Any wrong answer or unanswered question resets streak to 0.
- Wrong answer → 2 s lockout (`LOCKOUT_MS`), then unlimited retries.
- Last question worth double (base + bonus, then ×2).

## Answer matching (`isCorrect()`, exported for tests)

- Normalize both sides: NFD → strip diacritics → lowercase → punctuation to
  space → collapse whitespace → trim.
- Accept if equal to any `answers[]` entry, OR Levenshtein ≤ 1 when the
  accepted answer is ≥ 5 chars, OR numeric equality (`"1,000" == "1000"`).
- `exact: true` (typing questions) disables fuzzy matching: only trim +
  collapse whitespace, case-sensitive comparison.
- MCQ uses `isCorrectMCQ()`: choice letter A–D (case-insensitive, mapped to
  the per-game shuffled `choices`) or normalized text equality with an
  accepted answer. No fuzzy matching.

## questions.json format

```json
{ "type": "trivia",     "prompt": "Capital of Australia?",             "answers": ["canberra"] }
{ "type": "math",       "prompt": "17 × 6 = ?",                        "answers": ["102"] }
{ "type": "unscramble", "prompt": "Unscramble: NPELTA",                "answers": ["planet"] }
{ "type": "emoji",      "prompt": "Which movie? 🦁👑",                 "answers": ["the lion king", "lion king"] }
{ "type": "typing",     "prompt": "Type exactly: the quick brown fox", "answers": ["the quick brown fox"], "exact": true }
{ "type": "mcq",        "prompt": "Red planet?",                       "choices": ["Venus", "Mars", "Jupiter", "Mercury"], "answers": ["Mars"] }
{ "generated": "math", "op": "mul2x1" }
```

- `answers[0]` is shown as the canonical answer on the reveal screen.
- `generated: math` ops: `mul2x1` (two-digit × one-digit), `add2`, `sub3x2`,
  `mul1`, `mixed`. Expanded at runtime by `generateMathQuestion()`.
- `selectQuestions(count, mode)` round-robins across types for an even mix
  (classic excludes mcq; mcq mode takes only mcq). Bank has 87 entries
  (14 trivia / 12 math / 12 unscramble / 12 emoji / 12 typing / 20 mcq /
  5 generated). If the bank is smaller than requested it cycles (repeats
  possible) so a game always has `count` questions. Keep ≥ ~12 per type.

## Robustness rules (all in server.js)

- Single game in memory (`let room = null`, channel `'game'`); creating a
  game replaces the old one (timer cleared). No codes, no cleanup timers.
- Reconnect: single `playerToken` in `localStorage` (`sq_token`). Rejoining
  with the same token restores name/score/streak (`reconnected: true`) and
  re-sends current phase via `sendCatchUp()` (including `choices` for mcq).
- Late joiners mid-game → `spectator: true` (see everything, can't answer);
  `startGame()` flips all spectators to players and zeroes scores.
- Host disconnect → longest-connected connected player promoted
  (`promoteHostIfNeeded()`); `host-changed` event; player.js reveals host
  controls when `isHost`.
- Validation: game must exist for join; names 1–20 chars, question count
  clamped 1–20, mode must be `classic`/`mcq`; answers capped at 200 chars,
  ignored outside `question` phase, 5 answers/sec sliding-window rate limit
  per player.
- Host controls: `start-game`, `skip-question`, `kick-player {token}`,
  `end-game`, `play-again`. All host-only, acked `{ok, error?}`.

## Key gotchas learned while building

- `activePlayers()` = connected non-spectators (quorum, progress totals,
  early-end). `rosterPlayers()` = all non-spectators incl. disconnected
  (reveal lists, streak resets). `standings()` includes disconnected players
  so refreshers don't vanish from the board. Don't conflate these.
- Early-end check has a `total > 0` guard so a question with zero connected
  players still ends via timer.
- Scoring granularity is whole seconds — sub-second arrival differences all
  score the same base. This is by design, not a bug.
- Player name collisions are auto-suffixed (`Ravi` → `Ravi 2`).
- Frontend uses only relative URLs (`io()`, `app.css`, `host.js`) so the app
  works behind tunnels/proxies. Never hardcode `localhost` in `public/`.
- Test-only env overrides exist: `QUESTION_TIME_MS`, `REVEAL_TIME_MS`,
  `LEADERBOARD_TIME_MS`. Defaults are 15000/5000/5000.

## Testing

No committed test suite. Verified with throwaway Socket.IO scripts: full
classic + mcq games (counts, letter answers, withheld points in acks, reveal
`top` flags), single-game overwrite, `get-status`, reconnect, spectator,
kick, play-again, host promotion — plus `isCorrect`/`isCorrectMCQ` unit
cases. To re-verify quickly:

```bash
PORT=3001 QUESTION_TIME_MS=15000 REVEAL_TIME_MS=500 LEADERBOARD_TIME_MS=500 node server.js &
# connect clients, answer using questions.json prompt→answers lookup
node -e "const {isCorrect} = require('./server.js'); console.log(isCorrect('canbera', {answers:['canberra']}))"
```

Note: `require('./server.js')` binds the default port 3000 as a side effect.

## Playing with others (local hosting)

```bash
npm start
cloudflared tunnel --url localhost:3000
```

Share the printed `https://*.trycloudflare.com/?room=ABCD` URL — host must
use the same public URL, not localhost. Same-Wi-Fi alternative:
`http://<host-lan-ip>:3000`.
