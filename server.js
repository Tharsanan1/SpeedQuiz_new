'use strict';

/**
 * Speed Quiz — server-authoritative real-time multiplayer quiz.
 * Express + Socket.IO. No database, rooms live in memory.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

// ---- Tunables (env overrides are for automated testing only) ----
const PORT = parseInt(process.env.PORT || '3000', 10);
const QUESTIONS_PER_GAME = 12;
const QUESTION_TIME_MS = parseInt(process.env.QUESTION_TIME_MS || '15000', 10);
const REVEAL_TIME_MS = parseInt(process.env.REVEAL_TIME_MS || '5000', 10);
const LEADERBOARD_TIME_MS = parseInt(process.env.LEADERBOARD_TIME_MS || '5000', 10);
const LOCKOUT_MS = 2000;
const ROOM_EMPTY_TTL_MS = 5 * 60 * 1000;
const MAX_NAME_LEN = 20;
const MAX_ANSWER_LEN = 200;
const ANSWER_RATE_LIMIT = 5; // answers per second per player

const PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
  '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
  '#000075', '#808080', '#ffffff', '#000000',
];

// 4-letter codes, no ambiguous chars (no O, I). 0/1 are digits anyway.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
  }
  return code;
}

function makeToken() {
  return crypto.randomBytes(12).toString('hex');
}

function cleanStr(s, maxLen) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (s.length === 0 || s.length > maxLen) return null;
  return s;
}

function cleanRoomCode(s) {
  if (typeof s !== 'string') return null;
  s = s.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(s)) return null;
  return s;
}

// ---------------- Answer matching ----------------

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function numericValue(s) {
  // Accept "1,000", "1 000", "1000", "3.5" etc.
  const t = s.trim().replace(/[\s,']/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function isCorrect(input, question) {
  if (typeof input !== 'string') return false;
  if (input.length > MAX_ANSWER_LEN) return false;

  if (question.exact) {
    // Exact: only trim + collapse whitespace, case-sensitive.
    const a = input.replace(/\s+/g, ' ').trim();
    return (question.answers || []).some((acc) => acc.replace(/\s+/g, ' ').trim() === a);
  }

  const normInput = normalize(input);
  if (!normInput) return false;
  const answers = question.answers || [];
  for (const acc of answers) {
    const normAcc = normalize(acc);
    if (!normAcc) continue;
    if (normInput === normAcc) return true;
    // Numeric equality ("1,000" == "1000")
    const ni = numericValue(normInput);
    const na = numericValue(normAcc);
    if (ni !== null && na !== null && ni === na) return true;
    // Fuzzy: Levenshtein <= 1 for answers >= 5 chars
    if (normAcc.length >= 5 && Math.abs(normInput.length - normAcc.length) <= 1) {
      if (levenshtein(normInput, normAcc) <= 1) return true;
    }
  }
  return false;
}

// ---------------- Question bank ----------------

let questionBank = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
  questionBank = JSON.parse(raw);
} catch (e) {
  console.error('Failed to load questions.json:', e.message);
  process.exit(1);
}

function randInt(min, max) {
  return min + crypto.randomInt(max - min + 1);
}

function generateMathQuestion(op) {
  let a, b, prompt, answers;
  switch (op) {
    case 'mul2x1': // two-digit x one-digit
      a = randInt(10, 99); b = randInt(2, 9);
      prompt = `${a} × ${b} = ?`; answers = [String(a * b)];
      break;
    case 'add2': // two-digit + two-digit
      a = randInt(10, 99); b = randInt(10, 99);
      prompt = `${a} + ${b} = ?`; answers = [String(a + b)];
      break;
    case 'sub3x2': // three-digit - two-digit
      a = randInt(100, 999); b = randInt(10, 99);
      prompt = `${a} − ${b} = ?`; answers = [String(a - b)];
      break;
    case 'mul1': // one-digit x one-digit
      a = randInt(2, 9); b = randInt(2, 9);
      prompt = `${a} × ${b} = ?`; answers = [String(a * b)];
      break;
    case 'mixed':
    default: {
      const pick = randInt(0, 2);
      if (pick === 0) {
        a = randInt(11, 29); b = randInt(11, 29);
        prompt = `${a} + ${b} = ?`; answers = [String(a + b)];
      } else if (pick === 1) {
        a = randInt(6, 15); b = randInt(3, 9);
        prompt = `${a} × ${b} = ?`; answers = [String(a * b)];
      } else {
        a = randInt(20, 120); b = randInt(2, 12);
        const prod = a * b;
        prompt = `${prod} ÷ ${b} = ?`; answers = [String(a)];
      }
    }
  }
  return { type: 'math', prompt, answers };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick 12 questions with a roughly even mix of types, no repeats. */
function selectQuestions() {
  const byType = new Map(); // type -> array of concrete questions
  for (const q of questionBank) {
    let concrete = null;
    if (q.generated === 'math') {
      concrete = generateMathQuestion(q.op || 'mixed');
    } else if (q.prompt && Array.isArray(q.answers) && q.type) {
      concrete = { type: q.type, prompt: q.prompt, answers: q.answers.slice() };
      if (q.exact) concrete.exact = true;
    }
    if (!concrete) continue;
    if (!byType.has(concrete.type)) byType.set(concrete.type, []);
    byType.get(concrete.type).push(concrete);
  }
  const types = [...byType.keys()];
  for (const t of types) shuffle(byType.get(t));

  const picked = [];
  const idx = new Map(types.map((t) => [t, 0]));
  // Round-robin across types for an even mix.
  let guard = 0;
  while (picked.length < QUESTIONS_PER_GAME && guard++ < 1000) {
    let progressed = false;
    for (const t of types) {
      if (picked.length >= QUESTIONS_PER_GAME) break;
      const list = byType.get(t);
      const i = idx.get(t);
      if (i < list.length) {
        picked.push(list[i]);
        idx.set(t, i + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  // If bank is small, fill remaining from everything shuffled (may repeat types but not same object).
  if (picked.length < QUESTIONS_PER_GAME) {
    const all = shuffle([...byType.values()].flat().filter((q) => !picked.includes(q)));
    while (picked.length < QUESTIONS_PER_GAME && all.length) picked.push(all.pop());
  }
  return shuffle(picked).slice(0, QUESTIONS_PER_GAME);
}

// ---------------- Rooms ----------------

/** rooms: code -> room */
const rooms = new Map();

function createRoom() {
  let code = makeRoomCode();
  let guard = 0;
  while (rooms.has(code) && guard++ < 100) code = makeRoomCode();
  const room = {
    code,
    phase: 'lobby', // lobby | question | reveal | leaderboard | final
    players: new Map(), // token -> player
    sockets: new Map(), // socketId -> token
    hostToken: null,
    questions: [],
    qIndex: -1,
    questionStartTime: 0,
    questionEndsAt: 0,
    questionResults: new Map(), // token -> { correct, elapsed, points, base, bonus }
    timer: null,
    prevRanks: new Map(),
    colorCursor: 0,
    emptySince: null,
    cleanupTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code) || null;
}

function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) return;
  room.emptySince = Date.now();
  room.cleanupTimer = setTimeout(() => {
    if (connectedSocketCount(room) === 0) {
      clearRoomTimer(room);
      rooms.delete(room.code);
      console.log(`Room ${room.code} deleted (empty 5 min)`);
    }
    room.cleanupTimer = null;
    room.emptySince = null;
  }, ROOM_EMPTY_TTL_MS);
  if (room.cleanupTimer.unref) room.cleanupTimer.unref();
}

function cancelRoomCleanup(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  room.emptySince = null;
}

function connectedSocketCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.connected) n++;
  return n;
}

function assignColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  for (let i = 0; i < PALETTE.length; i++) {
    const c = PALETTE[(room.colorCursor + i) % PALETTE.length];
    if (!used.has(c)) {
      room.colorCursor = (room.colorCursor + i + 1) % PALETTE.length;
      return c;
    }
  }
  return PALETTE[room.colorCursor++ % PALETTE.length];
}

function activePlayers(room) {
  // Non-spectator, currently connected players (can answer / count toward quorum).
  return [...room.players.values()].filter((p) => !p.spectator && p.connected);
}

function rosterPlayers(room) {
  // All non-spectators, including disconnected (shown in reveal/leaderboard/final).
  return [...room.players.values()].filter((p) => !p.spectator);
}

function lobbyState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      token: p.token,
      name: p.name,
      color: p.color,
      score: p.score,
      connected: p.connected,
      spectator: !!p.spectator,
      isHost: p.token === room.hostToken,
    })),
    hostToken: room.hostToken,
    canStart: activePlayers(room).length >= 2,
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', lobbyState(room));
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function standings(room, withRankChange) {
  const sorted = [...room.players.values()]
    .filter((p) => !p.spectator)
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  return sorted.map((p, i) => {
    const rank = i + 1;
    const prev = room.prevRanks.get(p.token);
    let rankChange = null;
    if (withRankChange && prev != null) rankChange = prev - rank; // + means moved up
    return {
      token: p.token, name: p.name, color: p.color,
      score: p.score, streak: p.streak, rank, rankChange,
    };
  });
}

function snapshotRanks(room) {
  room.prevRanks = new Map(
    standings(room, false).map((s) => [s.token, s.rank])
  );
}

// ---------------- Game flow ----------------

function startGame(room) {
  if (room.phase !== 'lobby' && room.phase !== 'final') return false;
  if (activePlayers(room).length < 2) return false;
  // Everyone becomes a player on (re)start; reset scores.
  for (const p of room.players.values()) {
    p.spectator = false;
    p.score = 0;
    p.streak = 0;
  }
  room.questions = selectQuestions();
  room.qIndex = -1;
  snapshotRanks(room);
  // prevRanks cleared so first leaderboard shows no changes
  room.prevRanks = new Map();
  nextQuestion(room);
  return true;
}

function nextQuestion(room) {
  room.qIndex += 1;
  if (room.qIndex >= room.questions.length) {
    endToFinal(room);
    return;
  }
  const q = room.questions[room.qIndex];
  room.phase = 'question';
  room.questionResults = new Map();
  room.questionStartTime = Date.now();
  room.questionEndsAt = room.questionStartTime + QUESTION_TIME_MS;
  for (const p of room.players.values()) p.lockoutUntil = 0;

  io.to(room.code).emit('question', {
    index: room.qIndex,
    total: room.questions.length,
    type: q.type,
    prompt: q.prompt,
    endsAt: room.questionEndsAt,
    serverTime: Date.now(),
    lastQuestion: room.qIndex === room.questions.length - 1,
  });
  sendProgress(room);

  clearRoomTimer(room);
  room.timer = setTimeout(() => endQuestion(room, false), QUESTION_TIME_MS);
}

function sendProgress(room) {
  const total = activePlayers(room).length;
  const answered = [...room.questionResults.values()].filter((r) => r.correct).length;
  const answeredList = [...room.questionResults.entries()]
    .filter(([, r]) => r.correct)
    .map(([token]) => {
      const p = room.players.get(token);
      return p ? { token, name: p.name, color: p.color } : null;
    })
    .filter(Boolean);
  io.to(room.code).emit('progress', { answered, total, answeredList });
}

function scoreFor(elapsed, streakAfter, isLast) {
  const base = Math.max(200, 1000 - 50 * Math.floor(elapsed / 1000));
  const bonus = 100 * Math.max(0, streakAfter - 1);
  let points = base + bonus;
  if (isLast) points *= 2;
  return { base, bonus: isLast ? bonus * 2 : bonus, points, doubled: isLast };
}

function handleAnswer(room, player, rawAnswer) {
  const now = Date.now();
  if (room.phase !== 'question') return { ok: false, reason: 'not-in-question' };
  if (player.spectator) return { ok: false, reason: 'spectator' };
  // Rate limit: 5/sec sliding window
  player.answerTimes = (player.answerTimes || []).filter((t) => now - t < 1000);
  if (player.answerTimes.length >= ANSWER_RATE_LIMIT) {
    return { ok: false, reason: 'rate-limited' };
  }
  player.answerTimes.push(now);
  // Lockout after wrong answer
  if (player.lockoutUntil && now < player.lockoutUntil) {
    return { ok: false, reason: 'locked', retryInMs: player.lockoutUntil - now };
  }
  // Already correct — only first correct counts
  const existing = room.questionResults.get(player.token);
  if (existing && existing.correct) return { ok: false, reason: 'already-correct' };

  const q = room.questions[room.qIndex];
  const answer = typeof rawAnswer === 'string' ? rawAnswer.slice(0, MAX_ANSWER_LEN) : '';
  const elapsed = now - room.questionStartTime;
  if (isCorrect(answer, q)) {
    const streakAfter = player.streak + 1;
    const isLast = room.qIndex === room.questions.length - 1;
    const { base, bonus, points } = scoreFor(elapsed, streakAfter, isLast);
    player.streak = streakAfter;
    player.score += points;
    room.questionResults.set(player.token, {
      correct: true, elapsed, points, base, bonus,
    });
    sendProgress(room);
    // End early when everyone answered correctly
    const total = activePlayers(room).length;
    const correctCount = [...room.questionResults.values()].filter((r) => r.correct).length;
    if (total > 0 && correctCount >= total) {
      endQuestion(room, true);
    }
    return { ok: true, correct: true, points, elapsed };
  }
  // Wrong: lock out 2s, may retry. Streak resets only at question end? Spec: resets on a wrong/no answer.
  // Reset streak immediately on a wrong answer (subsequent correct in same question still counts as new streak start).
  player.streak = 0;
  player.lockoutUntil = now + LOCKOUT_MS;
  return { ok: false, correct: false, reason: 'wrong', retryInMs: LOCKOUT_MS };
}

function endQuestion(room, early) {
  if (room.phase !== 'question') return;
  clearRoomTimer(room);
  room.phase = 'reveal';
  const q = room.questions[room.qIndex];
  // Anyone without a correct answer gets streak reset (wrong/no answer).
  for (const p of rosterPlayers(room)) {
    const r = room.questionResults.get(p.token);
    if (!r || !r.correct) p.streak = 0;
  }
  const results = rosterPlayers(room).map((p) => {
    const r = room.questionResults.get(p.token);
    return {
      token: p.token, name: p.name, color: p.color,
      correct: !!(r && r.correct),
      points: r && r.correct ? r.points : 0,
      base: r && r.correct ? r.base : 0,
      bonus: r && r.correct ? r.bonus : 0,
      elapsed: r && r.correct ? r.elapsed : null,
      connected: p.connected,
    };
  }).sort((a, b) => {
    if (a.correct !== b.correct) return a.correct ? -1 : 1;
    return (a.elapsed ?? Infinity) - (b.elapsed ?? Infinity);
  });
  io.to(room.code).emit('reveal', {
    index: room.qIndex,
    total: room.questions.length,
    answers: q.answers.slice(0, 5),
    results,
    early,
  });
  room.timer = setTimeout(() => showLeaderboard(room), REVEAL_TIME_MS);
}

function showLeaderboard(room) {
  if (room.phase !== 'reveal') return;
  clearRoomTimer(room);
  room.phase = 'leaderboard';
  const table = standings(room, true);
  io.to(room.code).emit('leaderboard', {
    index: room.qIndex,
    total: room.questions.length,
    standings: table,
    last: room.qIndex >= room.questions.length - 1,
  });
  snapshotRanks(room);
  room.timer = setTimeout(() => nextQuestion(room), LEADERBOARD_TIME_MS);
}

function endToFinal(room) {
  clearRoomTimer(room);
  room.phase = 'final';
  const table = standings(room, true);
  io.to(room.code).emit('final', {
    standings: table,
    podium: table.slice(0, 3),
  });
}

// ---------------- Express + Socket.IO ----------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  // Works behind reverse proxies with default path; clients use relative URLs.
});

function getPlayerBySocket(room, socketId) {
  const token = room.sockets.get(socketId);
  if (!token) return null;
  return room.players.get(token) || null;
}

function promoteHostIfNeeded(room) {
  const host = room.hostToken ? room.players.get(room.hostToken) : null;
  if (host && host.connected) return;
  // Promote longest-connected (smallest joinedAt) connected non-spectator; else any connected.
  const candidates = [...room.players.values()].filter((p) => p.connected);
  if (candidates.length === 0) return;
  candidates.sort((a, b) => {
    const sa = a.spectator ? 1 : 0, sb = b.spectator ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return a.joinedAt - b.joinedAt;
  });
  room.hostToken = candidates[0].token;
  io.to(room.code).emit('host-changed', { hostToken: room.hostToken, name: candidates[0].name });
  broadcastLobby(room);
}

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('create-room', (data, ack) => {
    try {
      const name = cleanStr(data && data.name, MAX_NAME_LEN);
      if (!name) return ack && ack({ ok: false, error: 'Enter a display name (1-20 chars).' });
      const room = createRoom();
      const token = makeToken();
      const player = {
        token, name, color: assignColor(room), score: 0, streak: 0,
        connected: true, socketId: socket.id, joinedAt: Date.now(),
        spectator: false, lockoutUntil: 0, answerTimes: [],
      };
      room.players.set(token, player);
      room.sockets.set(socket.id, token);
      room.hostToken = token;
      socket.join(room.code);
      joinedRoom = room;
      cancelRoomCleanup(room);
      ack && ack({ ok: true, room: room.code, token });
      broadcastLobby(room);
    } catch (e) {
      ack && ack({ ok: false, error: 'Could not create room.' });
    }
  });

  socket.on('join-room', (data, ack) => {
    try {
      const code = cleanRoomCode(data && data.room);
      const name = cleanStr(data && data.name, MAX_NAME_LEN);
      const incomingToken = typeof (data && data.token) === 'string' ? data.token.slice(0, 64) : null;
      if (!code) return ack && ack({ ok: false, error: 'Room code must be 4 letters.' });
      const room = getRoom(code);
      if (!room) return ack && ack({ ok: false, error: 'Room not found.' });

      // Reconnect with token?
      if (incomingToken && room.players.has(incomingToken)) {
        const p = room.players.get(incomingToken);
        p.connected = true;
        p.socketId = socket.id;
        room.sockets.set(socket.id, incomingToken);
        socket.join(room.code);
        joinedRoom = room;
        cancelRoomCleanup(room);
        promoteHostIfNeeded(room);
        ack && ack({ ok: true, room: room.code, token: incomingToken, reconnected: true, spectator: !!p.spectator, isHost: room.hostToken === incomingToken });
        broadcastLobby(room);
        // Re-send current phase state so a refreshed client catches up.
        sendCatchUp(room, p, socket);
        return;
      }

      if (!name) return ack && ack({ ok: false, error: 'Enter a display name (1-20 chars).' });
      // Unique-ish names: suffix if taken
      let finalName = name;
      const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
      if (taken.has(finalName.toLowerCase())) {
        let i = 2;
        while (taken.has(`${name} ${i}`.toLowerCase()) && i < 100) i++;
        finalName = `${name} ${i}`.slice(0, MAX_NAME_LEN);
      }
      const token = makeToken();
      const isMidGame = room.phase !== 'lobby' && room.phase !== 'final';
      const player = {
        token, name: finalName, color: assignColor(room), score: 0, streak: 0,
        connected: true, socketId: socket.id, joinedAt: Date.now(),
        spectator: isMidGame, lockoutUntil: 0, answerTimes: [],
      };
      room.players.set(token, player);
      room.sockets.set(socket.id, token);
      socket.join(room.code);
      joinedRoom = room;
      cancelRoomCleanup(room);
      ack && ack({ ok: true, room: room.code, token, reconnected: false, spectator: player.spectator, isHost: false });
      broadcastLobby(room);
      if (isMidGame) sendCatchUp(room, player, socket);
    } catch (e) {
      ack && ack({ ok: false, error: 'Could not join room.' });
    }
  });

  socket.on('start-game', (data, ack) => {
    const room = joinedRoom;
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = getPlayerBySocket(room, socket.id);
    if (!player || player.token !== room.hostToken) {
      return ack && ack({ ok: false, error: 'Only the host can start.' });
    }
    if (room.phase !== 'lobby' && room.phase !== 'final') {
      return ack && ack({ ok: false, error: 'Game already in progress.' });
    }
    if (activePlayers(room).length < 2) {
      return ack && ack({ ok: false, error: 'Need at least 2 players to start.' });
    }
    startGame(room);
    ack && ack({ ok: true });
  });

  socket.on('submit-answer', (data, ack) => {
    const room = joinedRoom;
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = getPlayerBySocket(room, socket.id);
    if (!player) return ack && ack({ ok: false, error: 'Unknown player.' });
    const answer = typeof (data && data.answer) === 'string' ? data.answer : '';
    const res = handleAnswer(room, player, answer);
    ack && ack(res);
    if (res.ok && res.correct) {
      socket.emit('answer-result', { correct: true, points: res.points, elapsed: res.elapsed });
    } else if (res.reason === 'wrong') {
      socket.emit('answer-result', { correct: false, retryInMs: res.retryInMs });
    } else if (res.reason === 'locked') {
      socket.emit('answer-result', { correct: false, retryInMs: res.retryInMs, locked: true });
    }
  });

  socket.on('skip-question', (data, ack) => {
    const room = joinedRoom;
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = getPlayerBySocket(room, socket.id);
    if (!player || player.token !== room.hostToken) {
      return ack && ack({ ok: false, error: 'Only the host can skip.' });
    }
    if (room.phase !== 'question') return ack && ack({ ok: false, error: 'No question running.' });
    endQuestion(room, false);
    ack && ack({ ok: true });
  });

  socket.on('kick-player', (data, ack) => {
    const room = joinedRoom;
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = getPlayerBySocket(room, socket.id);
    if (!player || player.token !== room.hostToken) {
      return ack && ack({ ok: false, error: 'Only the host can kick.' });
    }
    const target = typeof (data && data.token) === 'string' ? data.token : null;
    if (!target || !room.players.has(target)) return ack && ack({ ok: false, error: 'Player not found.' });
    if (target === room.hostToken) return ack && ack({ ok: false, error: 'Cannot kick the host.' });
    const victim = room.players.get(target);
    room.players.delete(target);
    room.questionResults.delete(target);
    // Disconnect victim socket(s)
    for (const [sid, tok] of [...room.sockets.entries()]) {
      if (tok === target) {
        room.sockets.delete(sid);
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('kicked', { message: 'You were kicked by the host.' });
          s.leave(room.code);
        }
      }
    }
    ack && ack({ ok: true });
    broadcastLobby(room);
    sendProgress(room);
  });

  socket.on('end-game', (data, ack) => {
    const room = joinedRoom;
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = getPlayerBySocket(room, socket.id);
    if (!player || player.token !== room.hostToken) {
      return ack && ack({ ok: false, error: 'Only the host can end the game.' });
    }
    clearRoomTimer(room);
    room.phase = 'lobby';
    room.questions = [];
    room.qIndex = -1;
    io.to(room.code).emit('back-to-lobby', {});
    broadcastLobby(room);
    ack && ack({ ok: true });
  });

  socket.on('play-again', (data, ack) => {
    const room = joinedRoom;
    if (!room) return ack && ack({ ok: false, error: 'Not in a room.' });
    const player = getPlayerBySocket(room, socket.id);
    if (!player || player.token !== room.hostToken) {
      return ack && ack({ ok: false, error: 'Only the host can restart.' });
    }
    if (room.phase !== 'final') return ack && ack({ ok: false, error: 'Game is not over yet.' });
    startGame(room);
    ack && ack({ ok: true });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = joinedRoom;
    const token = room.sockets.get(socket.id);
    room.sockets.delete(socket.id);
    if (token && room.players.has(token)) {
      const p = room.players.get(token);
      // Still connected via another socket?
      const stillThere = [...room.sockets.values()].includes(token);
      if (!stillThere) p.connected = false;
    }
    promoteHostIfNeeded(room);
    broadcastLobby(room);
    if ([...room.players.values()].every((p) => !p.connected)) {
      scheduleRoomCleanup(room);
    }
    joinedRoom = null;
  });
});

function sendCatchUp(room, player, socket) {
  // Bring a (re)joining or spectating client up to speed on the current phase.
  socket.emit('lobby', lobbyState(room));
  if (room.phase === 'question' && room.qIndex >= 0) {
    const q = room.questions[room.qIndex];
    socket.emit('question', {
      index: room.qIndex,
      total: room.questions.length,
      type: q.type,
      prompt: q.prompt,
      endsAt: room.questionEndsAt,
      serverTime: Date.now(),
      lastQuestion: room.qIndex === room.questions.length - 1,
    });
    const total = activePlayers(room).length;
    const answered = [...room.questionResults.values()].filter((r) => r.correct).length;
    socket.emit('progress', { answered, total, answeredList: [] });
  }
}

server.listen(PORT, () => {
  console.log(`SpeedQuiz listening on port ${PORT}`);
});

module.exports = { app, server, isCorrect, normalize, selectQuestions };
