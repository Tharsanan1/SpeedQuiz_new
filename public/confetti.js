/* Shared canvas confetti — no external assets. Loaded by host.html and player.html. */
(function () {
  'use strict';

  var COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#ffffff', '#ffd700'];
  var canvas = null, ctx = null, parts = [], raf = null;

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'confetti-canvas';
    var st = canvas.style;
    st.position = 'fixed'; st.left = '0'; st.top = '0';
    st.width = '100vw'; st.height = '100vh';
    st.pointerEvents = 'none'; st.zIndex = '999';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function spawn(n, mega) {
    var W = canvas.width, H = canvas.height;
    for (var i = 0; i < n; i++) {
      parts.push({
        x: mega ? Math.random() * W : W / 2 + (Math.random() - 0.5) * W * 0.4,
        y: mega ? -20 - Math.random() * H * 0.3 : H * (0.75 + Math.random() * 0.25),
        vx: (Math.random() - 0.5) * (mega ? 6 : 10),
        vy: mega ? 2 + Math.random() * 4 : -(6 + Math.random() * (mega ? 6 : 9)),
        w: 6 + Math.random() * 8,
        h: 8 + Math.random() * 10,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 1,
        decay: 0.004 + Math.random() * 0.006,
      });
    }
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var H = canvas.height;
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.vy += 0.22; // gravity
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
      if (p.y > H + 30 || p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (parts.length) {
      raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(raf); raf = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // Single celebratory burst (correct answer at reveal).
  window.burstConfetti = function (opts) {
    ensure();
    spawn((opts && opts.count) || 90, false);
    kick();
  };

  // Energized multi-wave celebration for the top scorer.
  window.celebrateTop = function () {
    ensure();
    spawn(140, false);
    kick();
    setTimeout(function () { spawn(120, true); kick(); }, 350);
    setTimeout(function () { spawn(160, false); kick(); }, 800);
  };
})();
