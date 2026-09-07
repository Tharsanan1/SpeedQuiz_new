/* Speed Quiz — host screen. The host is also a player and answers questions. */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var roomCode = (params.get('room') || '').toUpperCase();
  var fatal = document.getElementById('fatal');
  function die(msg) {
    fatal.textContent = msg + ' ';
    fatal.hidden = false;
    var a = document.createElement('a');
    a.href = 'index.html';
    a.textContent = 'Back to home';
    fatal.appendChild(a);
  }
  if (!/^[A-Z]{4}$/.test(roomCode)) { die('Missing room code.'); return; }

  var token = null, myName = '';
  try {
    token = localStorage.getItem('sq_' + roomCode + '_token');
    myName = localStorage.getItem('sq_' + roomCode + '_name') || '';
  } catch (e) { /* ignore */ }
  if (!token) { die('No host credentials for this room. Create the game first.'); return; }

  var socket = io();
  var views = ['lobby', 'question', 'reveal', 'leaderboard', 'final'];
  function show(name) {
    views.forEach(function (v) {
      document.getElementById('view-' + v).hidden = (v !== name);
    });
  }

  var connEl = document.getElementById('conn');
  socket.on('connect', function () {
    connEl.textContent = 'connected';
    connEl.classList.add('on');
    socket.emit('join-room', { room: roomCode, token: token, name: myName }, function (res) {
      if (!res || !res.ok) { die((res && res.error) || 'Could not rejoin room.'); return; }
      if (res.token && res.token !== token) {
        token = res.token;
        try { localStorage.setItem('sq_' + roomCode + '_token', token); } catch (e) {}
      }
    });
  });
  socket.on('disconnect', function () { connEl.textContent = 'reconnecting…'; connEl.classList.remove('on'); });
  socket.on('kicked', function () { die('You were kicked.'); socket.disconnect(); });

  // ---------- lobby ----------
  var startBtn = document.getElementById('start-btn');
  document.getElementById('room-code').textContent = roomCode;
  var joinUrl = location.origin + '/?room=' + roomCode;
  document.getElementById('join-url').textContent = joinUrl;
  document.getElementById('copy-btn').addEventListener('click', function () {
    var t = this;
    function done(ok) { t.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function () { t.textContent = 'Copy'; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(joinUrl).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = joinUrl; document.body.appendChild(ta); ta.select();
      try { done(document.execCommand('copy')); } catch (e) { done(false); }
      document.body.removeChild(ta);
    }
  });
  startBtn.addEventListener('click', function () {
    socket.emit('start-game', {}, function (res) {
      if (!res || !res.ok) alert((res && res.error) || 'Cannot start.');
    });
  });

  socket.on('lobby', function (state) {
    if (state.phase === 'lobby' || state.phase === 'final') renderLobby(state);
  });
  socket.on('back-to-lobby', function () { resetAnswerUI(); });

  function renderLobby(state) {
    show('lobby');
    var list = document.getElementById('player-list');
    list.innerHTML = '';
    var count = 0;
    state.players.forEach(function (p) {
      if (p.spectator) return;
      count++;
      var li = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = p.color;
      li.appendChild(dot);
      var nm = document.createElement('span');
      nm.textContent = p.name + (p.token === token ? ' (you)' : '');
      li.appendChild(nm);
      if (p.token === state.hostToken) {
        var tag = document.createElement('span');
        tag.className = 'host-tag'; tag.textContent = 'HOST';
        li.appendChild(tag);
      }
      if (!p.connected) {
        var off = document.createElement('span');
        off.className = 'off'; off.textContent = 'disconnected';
        li.appendChild(off);
      }
      if (p.token !== token) {
        var kick = document.createElement('button');
        kick.className = 'btn kick'; kick.textContent = 'Kick';
        (function (t, n) {
          kick.addEventListener('click', function () {
            if (confirm('Kick ' + n + '?')) socket.emit('kick-player', { token: t }, function () {});
          });
        })(p.token, p.name);
        li.appendChild(kick);
      }
      list.appendChild(li);
    });
    document.getElementById('player-count').textContent = count;
    var can = count >= 2;
    startBtn.disabled = !can;
    startBtn.textContent = can ? 'Start game' : 'Start (need ≥ 2 players)';
  }

  // ---------- question ----------
  var timerInt = null, deadline = 0;
  var answerInput = document.getElementById('answer-input');
  var answerMsg = document.getElementById('answer-msg');
  var locked = false;

  function resetAnswerUI() {
    answerInput.value = '';
    answerInput.disabled = false;
    answerMsg.hidden = true;
    locked = false;
  }

  socket.on('question', function (q) {
    show('question');
    resetAnswerUI();
    document.getElementById('q-num').textContent = 'Q ' + (q.index + 1) + ' / ' + q.total;
    document.getElementById('q-type').textContent = q.type;
    document.getElementById('q-last').hidden = !q.lastQuestion;
    document.getElementById('q-prompt').textContent = q.prompt;
    var offset = Date.now() - q.serverTime;
    deadline = q.endsAt;
    clearInterval(timerInt);
    var fill = document.getElementById('timer-fill');
    var cd = document.getElementById('q-countdown');
    var total = q.endsAt - q.serverTime;
    function tick() {
      var remain = Math.max(0, deadline - Date.now());
      var frac = total > 0 ? remain / total : 0;
      fill.style.width = (frac * 100).toFixed(1) + '%';
      fill.classList.toggle('low', remain < 5000);
      cd.textContent = (remain / 1000).toFixed(remain < 5000 ? 1 : 0) + 's';
      if (remain <= 0) {
        clearInterval(timerInt);
        answerInput.disabled = true;
      }
    }
    tick();
    timerInt = setInterval(tick, 100);
    setTimeout(function () { answerInput.focus(); }, 50);
  });

  socket.on('progress', function (p) {
    document.getElementById('q-progress').textContent = p.answered + ' / ' + p.total + ' answered';
    var ul = document.getElementById('q-answered');
    ul.innerHTML = '';
    p.answeredList.forEach(function (a) {
      var li = document.createElement('li');
      li.textContent = '✓ ' + a.name;
      li.style.borderColor = a.color;
      li.style.color = a.color;
      ul.appendChild(li);
    });
  });

  document.getElementById('answer-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var val = answerInput.value;
    if (!val.trim() || locked || answerInput.disabled) return;
    socket.emit('submit-answer', { answer: val }, function (res) {
      if (!res) return;
      if (res.ok && res.correct) {
        locked = true;
        answerMsg.textContent = '✓ Correct! +' + res.points + ' pts';
        answerMsg.className = 'answer-msg good';
        answerMsg.hidden = false;
        answerInput.disabled = true;
      } else if (res.reason === 'wrong' || res.reason === 'locked') {
        var s = Math.ceil((res.retryInMs || 2000) / 1000);
        answerMsg.textContent = '✗ Wrong — try again in ' + s + 's';
        answerMsg.className = 'answer-msg bad';
        answerMsg.hidden = false;
        answerInput.classList.remove('shake');
        void answerInput.offsetWidth;
        answerInput.classList.add('shake');
      }
    });
  });

  socket.on('answer-result', function (r) {
    if (r.correct) {
      locked = true;
      answerMsg.textContent = '✓ Correct! +' + r.points + ' pts';
      answerMsg.className = 'answer-msg good';
      answerMsg.hidden = false;
      answerInput.disabled = true;
    } else {
      var s = Math.ceil((r.retryInMs || 2000) / 1000);
      answerMsg.textContent = '✗ Wrong — try again in ' + s + 's';
      answerMsg.className = 'answer-msg bad';
      answerMsg.hidden = false;
      answerInput.classList.remove('shake');
      void answerInput.offsetWidth;
      answerInput.classList.add('shake');
    }
  });

  document.getElementById('skip-btn').addEventListener('click', function () {
    socket.emit('skip-question', {}, function () {});
  });
  document.getElementById('end-btn').addEventListener('click', function () {
    if (confirm('End the game and return everyone to the lobby?')) socket.emit('end-game', {}, function () {});
  });

  // ---------- reveal ----------
  socket.on('reveal', function (r) {
    clearInterval(timerInt);
    show('reveal');
    document.getElementById('r-num').textContent = 'Question ' + (r.index + 1) + ' of ' + r.total;
    document.getElementById('r-answer').textContent = r.answers.join(' / ');
    var ul = document.getElementById('r-list');
    ul.innerHTML = '';
    r.results.forEach(function (x) {
      var li = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = x.color;
      li.appendChild(dot);
      var nm = document.createElement('span');
      nm.textContent = x.name + (x.token === token ? ' (you)' : '');
      li.appendChild(nm);
      var pts = document.createElement('span');
      pts.className = 'pts';
      if (x.correct) {
        pts.textContent = '+' + x.points + '  (' + (x.elapsed / 1000).toFixed(1) + 's)';
        pts.style.color = x.color;
      } else {
        pts.textContent = '— no points';
        pts.className += ' miss';
      }
      li.appendChild(pts);
      ul.appendChild(li);
    });
  });

  // ---------- leaderboard ----------
  socket.on('leaderboard', function (d) {
    show('leaderboard');
    renderStandings(document.getElementById('l-list'), d.standings);
  });

  function renderStandings(ol, standings) {
    ol.innerHTML = '';
    standings.forEach(function (s) {
      var li = document.createElement('li');
      if (s.token === token) li.className = 'me-row';
      var rank = document.createElement('span');
      rank.className = 'rank'; rank.textContent = '#' + s.rank;
      li.appendChild(rank);
      var dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = s.color;
      li.appendChild(dot);
      var nm = document.createElement('span');
      nm.textContent = s.name + (s.token === token ? ' (you)' : '');
      li.appendChild(nm);
      if (s.rankChange) {
        var d = document.createElement('span');
        d.className = s.rankChange > 0 ? 'delta-up' : 'delta-dn';
        d.textContent = (s.rankChange > 0 ? '▲' : '▼') + Math.abs(s.rankChange);
        li.appendChild(d);
      }
      var sc = document.createElement('span');
      sc.className = 'score'; sc.textContent = s.score;
      li.appendChild(sc);
      ol.appendChild(li);
    });
  }

  // ---------- final ----------
  socket.on('final', function (d) {
    show('final');
    var pod = document.getElementById('podium');
    pod.innerHTML = '';
    var medals = ['🥇', '🥈', '🥉'];
    var order = [d.podium[1], d.podium[0], d.podium[2]].filter(Boolean);
    order.forEach(function (p) {
      var div = document.createElement('div');
      var cls = p.rank === 1 ? 'step first' : (p.rank === 2 ? 'step second' : 'step third');
      div.className = cls;
      var m = document.createElement('div'); m.className = 'medal'; m.textContent = medals[p.rank - 1] || '';
      var n = document.createElement('div'); n.className = 'pname'; n.textContent = p.name; n.style.color = p.color;
      var s = document.createElement('div'); s.className = 'pscore'; s.textContent = p.score + ' pts';
      div.appendChild(m); div.appendChild(n); div.appendChild(s);
      pod.appendChild(div);
    });
    renderStandings(document.getElementById('f-list'), d.standings);
  });

  document.getElementById('again-btn').addEventListener('click', function () {
    socket.emit('play-again', {}, function (res) {
      if (!res || !res.ok) alert((res && res.error) || 'Cannot restart.');
    });
  });
  document.getElementById('end-btn-2').addEventListener('click', function () {
    if (confirm('Back to lobby?')) socket.emit('end-game', {}, function () {});
  });

  show('lobby');
})();
