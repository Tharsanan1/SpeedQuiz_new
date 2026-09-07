# ⚡ Speed Quiz

A real-time multiplayer quiz game that runs in the browser. One person runs the
server on their laptop and shares a link; 10–25 players join from their own
computers. No installs for players, no database, no accounts. The server hosts
exactly **one game at a time** — no room codes, players just enter a name.

**Stack:** Node.js 20+, Express, Socket.IO (server-authoritative).
Frontend is vanilla HTML/CSS/JS served statically by Express — no build step.

## Install & run

```bash
npm install && npm start
```

The server listens on port 3000 by default, configurable via `PORT`:

```bash
PORT=8080 npm start
```

Then open `http://localhost:3000`:

- **Create Game** — you become the host (and also a player who answers).
  Pick the number of questions (5/8/12/15/20) and the mode: **Classic**
  (type answers) or **Multiple choice** (tap A–D).
- **Join Game** — enter a display name, that's it. The landing page shows
  whether the lobby is open or a game is in progress.

## Exposing the game to other devices (internet play)

Players need to reach your laptop over HTTP. The app uses only relative URLs
for Socket.IO and assets, so it works unchanged behind an HTTPS reverse proxy
or tunnel. Easiest option: Cloudflare Tunnel.

```bash
# 1. Start the game
npm start

# 2. In another terminal, expose it (no account needed for a quick tunnel)
cloudflared tunnel --url localhost:3000
```

Cloudflare prints a public URL like `https://random-words.trycloudflare.com`.
Share it as-is (the host screen shows a ready-to-copy game link — no code
needed). Alternatives that also work: `ngrok http 3000`.

> Everyone must use the **same** public URL (host screen included), otherwise
> the host and players end up on different servers.

## How to play

1. Host clicks **Create Game**, chooses question count + mode, and shares
   the game link.
2. Players join with just a name; the host screen shows a live player list.
   **Start** unlocks with ≥ 2 players.
3. Each question lasts 15 s. Classic: type an answer, press Enter. Multiple
   choice: tap A–D (or press the letter key). A correct answer locks in with
   a neutral "Locked in" — you only find out you were right at the reveal,
   when confetti drops. The round's top scorer gets a bigger celebration.
   The screen shows live progress (`7 / 12 answered`) and who has answered —
   never the answer. The round ends at 0 s or when everyone answers correctly.
4. Reveal (5 s): correct answer + per-question points, fastest first, with
   a ⚡ TOP badge for the highest scorer.
5. Leaderboard (5 s): total scores with rank changes (▲/▼). A live
   leaderboard sidebar is also visible on every screen throughout the game
   and updates the instant anyone scores.
6. Final screen: podium (top 3), full leaderboard, **Play again** for the host
   (same settings, new random questions).

Host controls: **Start**, **Skip question**, **Kick player**, **End game**.
Late joiners during a game become spectators and join as players on
"Play again". If the host disconnects, the longest-connected player is
promoted to host. Refreshing keeps your name/score/streak via a token stored
in `localStorage`.

## Scoring (computed on the server only)

- Timing uses server time: `elapsed = Date.now() - questionStartTime` when
  your answer arrives.
- Correct answer: `points = max(200, 1000 − 50 × floor(elapsed / 1000))`.
  Only your first correct answer per question counts.
- Streak bonus: `+100 × (consecutive correct − 1)` — your 2nd correct answer
  in a row earns +100 extra, 3rd earns +200, etc. Any wrong answer or a
  question with no correct answer resets the streak to 0.
- Wrong answer: locked out for 2 s ("wrong, try again"), then retry as often
  as you like until the timer ends.
- The last question is worth **double** (base + streak bonus, then ×2).

## Answer matching

Both sides are normalized (lowercase, trim, collapse whitespace, strip
punctuation and diacritics) and compared against every accepted answer:

- exact match, **or**
- Levenshtein distance ≤ 1 for accepted answers ≥ 5 characters
  (so `canbera` still matches `canberra`), **or**
- numeric equality (`"1,000"` == `"1000"`).

Questions with `"exact": true` (the typing round) disable fuzzy matching —
you must type the text character-for-character (whitespace runs normalized).

Multiple-choice questions (`"type": "mcq"`) carry a `choices` array; players
answer with the letter (A–D) or the choice text. No fuzzy matching applies —
only the letter mapping and normalized text equality.

## Adding questions (`questions.json`)

An array of objects:

```json
{ "type": "trivia",     "prompt": "Capital of Australia?",             "answers": ["canberra"] }
{ "type": "math",       "prompt": "17 × 6 = ?",                        "answers": ["102"] }
{ "type": "unscramble", "prompt": "Unscramble: NPELTA",                "answers": ["planet"] }
{ "type": "emoji",      "prompt": "Which movie? 🦁👑",                 "answers": ["the lion king", "lion king"] }
{ "type": "typing",     "prompt": "Type exactly: the quick brown fox", "answers": ["the quick brown fox"], "exact": true }
{ "type": "mcq",        "prompt": "Red planet?",                       "choices": ["Venus", "Mars", "Jupiter", "Mercury"], "answers": ["Mars"] }
```

- `type` is one of `trivia`, `math`, `unscramble`, `emoji`, `typing`, `mcq`
  (used for the on-screen badge and for balancing the mix).
- `answers[0]` is shown as the correct answer on the reveal screen, so put
  the canonical spelling first and add common variants after it.
- `{ "generated": "math", "op": "mul2x1" }` entries make the server invent a
  fresh random arithmetic question at runtime. Available ops: `mul2x1`
  (two-digit × one-digit), `add2`, `sub3x2`, `mul1`, `mixed`.
- Each game picks N questions (host chooses 5/8/12/15/20): classic mode takes
  a roughly even mix of non-mcq types with no repeats; mcq mode takes only
  mcq questions (choice order is shuffled fresh every game). Ship at least
  ~12 per type if you want every type in every game.

Restart the server after editing `questions.json`.

## Project layout

```
server.js              # Express + Socket.IO, all game logic (single game)
questions.json         # question bank
public/index.html      # landing: Create Game (count + mode) / Join Game
public/host.html       # host screen (also plays)
public/player.html     # player screen
public/app.css, public/host.js, public/player.js, public/confetti.js
README.md
```

## Robustness notes

- One game per server, held in memory. Creating a game replaces any
  existing one.
- Every socket event is validated (game exists, correct phase, string
  lengths capped); answers outside the question phase are ignored; answers
  are rate-limited to 5/second per player.
