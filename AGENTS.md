# AGENTS.md — Speed Quiz

> Instructions and context for AI coding agents working on this repo.

## What this is

Speed Quiz is a real-time multiplayer browser quiz game. One person runs the
server on their laptop and shares a link; 10–25 players join from their own
browsers. No installs for players, no database, no accounts.

- **Stack:** Node.js 20+, Express, Socket.IO (server-authoritative).
- **Frontend:** vanilla HTML/CSS/JS served statically by Express. No React,
  no build step, no CDN required (Socket.IO client is served by the server
  itself at `/socket.io/socket.io.js`).
- **Run:** `npm install && npm start` → port 3000 (`PORT` env configurable).
- **Repo:** https://github.com/Tharsanan1/SpeedQuiz_new (public).

## Layout

```
server.js              # Express + Socket.IO, ALL game logic (single file)
questions.json         # question bank (array of objects, see below)
public/index.html      # landing: Create Game / Join Game (+ inline script)
public/host.html       # host screen (host is also a player, answers too)
public/player.html     # player screen (+ fallback host controls if promoted)
public/app.css         # dark theme, shared by all pages
public/host.js         # host client logic
public/player.js       # player client logic
README.md
```

## Game flow (server.js is the source of truth)

1. **Lobby** — `create-room {name}` / `join-room {room, name, token?}`.
   Host sees room code, join URL (`<origin>/?room=ABCD`, copy button), live
   player list, kick buttons. Start unlocks at ≥ 2 **connected**
   non-spectator players.
2. **Question ×12** — `question {index, total, type, prompt, endsAt,
   serverTime, lastQuestion}`. 15 s countdown (`QUESTION_TIME_MS`).
   Clients compute remaining time from `endsAt - Date.now()` (no clock-sync
   assumption beyond the one-shot `serverTime` offset). Ends at 0 s or when
   every active player has answered correctly.
3. **Reveal** (5 s, `REVEAL_TIME_MS`) — correct answer + per-player points,
   fastest first.
4. **Leaderboard** (5 s, `LEADERBOARD_TIME_MS`) — totals sorted, with rank
   changes (`rankChange` > 0 means moved up).
5. **Final** — podium top 3 + full standings. Host `play-again` restarts in
   the same room with new random questions (spectators become players).

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

## questions.json format

```json
{ "type": "trivia",     "prompt": "Capital of Australia?",             "answers": ["canberra"] }
{ "type": "math",       "prompt": "17 × 6 = ?",                        "answers": ["102"] }
{ "type": "unscramble", "prompt": "Unscramble: NPELTA",                "answers": ["planet"] }
{ "type": "emoji",      "prompt": "Which movie? 🦁👑",                 "answers": ["the lion king", "lion king"] }
{ "type": "typing",     "prompt": "Type exactly: the quick brown fox", "answers": ["the quick brown fox"], "exact": true }
{ "generated": "math", "op": "mul2x1" }
```

- `answers[0]` is shown as the canonical answer on the reveal screen.
- `generated: math` ops: `mul2x1` (two-digit × one-digit), `add2`, `sub3x2`,
  `mul1`, `mixed`. Expanded at runtime by `generateMathQuestion()`.
- `selectQuestions()` round-robins across types for an even mix, 12 total,
  no repeats. Bank currently has 67 entries (14 trivia / 12 math /
  12 unscramble / 12 emoji / 12 typing / 5 generated). Keep ≥ ~12 per type.

## Robustness rules (all in server.js)

- Room codes: 4 uppercase letters from `ABCDEFGHJKLMNPQRSTUVWXYZ`
  (no O/I). In-memory `rooms` Map; rooms deleted after 5 min empty
  (`ROOM_EMPTY_TTL_MS`, `scheduleRoomCleanup`).
- Reconnect: `playerToken` in `localStorage` (`sq_<ROOM>_token`). Rejoining
  with the same token restores name/score/streak (`reconnected: true`) and
  re-sends current phase via `sendCatchUp()`.
- Late joiners mid-game → `spectator: true` (see everything, can't answer);
  `startGame()` flips all spectators to players and zeroes scores.
- Host disconnect → longest-connected connected player promoted
  (`promoteHostIfNeeded()`); `host-changed` event; player.js reveals host
  controls when `isHost`.
- Validation: names 1–20 chars, answers capped at 200 chars, room codes
  `/^[A-Z]{4}$/`, answers ignored outside `question` phase, 5 answers/sec
  sliding-window rate limit per player.
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

No committed test suite. The full game was verified with a throwaway
Socket.IO script (host + 2 players, 12 questions, wrong-answer lockout,
reconnect, spectator, kick, play-again, host promotion) plus 12
`isCorrect()` unit cases. To re-verify quickly:

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
