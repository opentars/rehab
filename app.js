'use strict';
/*
 * Rehab Lite — stripped, standalone rehab timer for family.
 * Everything lives in THIS device's localStorage — no accounts, no server
 * data, nothing shared. The server only hands out these static files.
 *
 * Timer mechanics mirror the main workout app: all timing derives from
 * wall-clock timestamps (iOS suspends JS in the background — on return the
 * elapsed time recomputes exactly, and NONSTOP mode catches up missed
 * transitions). The 200ms interval only repaints.
 *
 * Sound plays through <audio> elements (media playback) — iPhones play media
 * even with the ringer switch on silent. Web Audio would be muted. iPhones
 * cannot vibrate from a web app at all, so there is no buzz toggle here.
 */

/* ---------- storage ---------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('rl.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem('rl.' + key, JSON.stringify(value)); },
  del(key) { localStorage.removeItem('rl.' + key); },
};

const uid = () => Math.random().toString(36).slice(2, 10);
const todayStr = (t) => {
  const d = t ? new Date(t) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// No preset exercise — everyone names their own on first use (Boss 2026-07-21).
function seedIfEmpty() {
  if (store.get('routines') == null) store.set('routines', []);
  if (store.get('sessions') == null) store.set('sessions', []);
  if (store.get('checkins') == null) store.set('checkins', []);
  if (store.get('settings') == null) store.set('settings', { goalPerDay: 2, gapHours: 6 });
}

/* ---------- sound cues (media playback — works on a silenced iPhone) ---------- */

const SR = 22050;
function buildWav(beeps, gain = 0.8) {
  const totalMs = Math.max(...beeps.map(([, ms, at]) => (at || 0) + ms)) + 60;
  const n = Math.ceil((totalMs / 1000) * SR);
  const buf = new Float32Array(n);
  for (const [freq, ms, atMs] of beeps) {
    const start = Math.floor(((atMs || 0) / 1000) * SR);
    const len = Math.floor((ms / 1000) * SR);
    const attack = Math.min(len, Math.floor(SR * 0.005));
    for (let i = 0; i < len && start + i < n; i++) {
      const env = (i < attack ? i / attack : 1) * Math.exp(-3 * (i / len));
      buf[start + i] += Math.sin((2 * Math.PI * freq * i) / SR) * env * gain;
    }
  }
  const pcm = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) pcm.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); pcm.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true);
  pcm.setUint32(24, SR, true); pcm.setUint32(28, SR * 2, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true);
  str(36, 'data'); pcm.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) pcm.setInt16(44 + i * 2, Math.max(-1, Math.min(1, buf[i])) * 0x7fff, true);
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'data:audio/wav;base64,' + btoa(bin);
}

const PATTERNS = {
  hold: [[880, 140], [880, 140, 220]],                  // two high beeps → GO, hold now
  rest: [[392, 420]],                                   // one low note → let go, rest
  done: [[660, 180], [550, 180, 220], [440, 340, 440]], // descending → finished
  ceiling: [[990, 110], [990, 110, 160], [990, 110, 320], [990, 110, 480]],
};
const audioEls = {};

function unlockAudio() {
  for (const kind of Object.keys(PATTERNS)) {
    if (!audioEls[kind]) {
      const el = new Audio(buildWav(PATTERNS[kind]));
      el.preload = 'auto';
      el.playsInline = true;
      audioEls[kind] = el;
    }
    const el = audioEls[kind];
    el.muted = true;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.muted = false; })
      .catch(() => { el.muted = false; });
  }
}
function playCue(kind) {
  const el = audioEls[kind];
  if (!el) return;
  el.currentTime = 0;
  el.play().catch(() => {});
}

let wakeLock = null;
async function grabWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function dropWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

/* ---------- streak ---------- */

// A day hits the goal when `goalPerDay` sessions were done, each at least
// `gapHours` after the previously counted one ("twice a day, six hours apart").
// Today never breaks the streak while it's still in progress.
function qualifyingCount(daySessions, gapHours) {
  const sorted = [...daySessions].sort((a, b) => a.startedAt - b.startedAt);
  let count = 0, lastCounted = -Infinity;
  for (const s of sorted) {
    if (s.startedAt - lastCounted >= gapHours * 3_600_000 - 60_000) { // 1 min grace
      count++;
      lastCounted = s.startedAt;
    }
  }
  return count;
}

function streakInfo() {
  const { goalPerDay, gapHours } = store.get('settings', { goalPerDay: 2, gapHours: 6 });
  const sessions = store.get('sessions', []);
  const byDay = new Map();
  for (const s of sessions) {
    const d = s.date;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  const hit = (d) => qualifyingCount(byDay.get(d) || [], gapHours) >= goalPerDay;
  const today = todayStr();
  const todayCount = qualifyingCount(byDay.get(today) || [], gapHours);
  const dayMs = 86_400_000;
  const noon = new Date(); noon.setHours(12, 0, 0, 0); // noon anchor avoids DST edges
  const dstr = (i) => todayStr(noon.getTime() - i * dayMs);
  let streak = 0;
  for (let i = hit(today) ? 0 : 1; hit(dstr(i)); i++) streak++;
  return { streak, todayCount, todayHit: hit(today), goalPerDay, gapHours };
}

/* ---------- app state + render ---------- */

const app = document.getElementById('app');
let tab = 'home';
let editing = null;      // routine being edited ({} = new)
let runner = null;       // live timer state
let doneInfo = null;     // post-session summary
let repaintTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtClock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function fmtAgo(ms) {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
}

function render() {
  if (repaintTimer) { clearInterval(repaintTimer); repaintTimer = null; }
  if (runner) return renderTimer();
  if (doneInfo) return renderDone();
  if (editing) return renderEditor();
  app.innerHTML = `
    <div class="header"><h1>TENDON REHAB &amp; STRENGTHEN</h1><span class="small">${todayStr()}</span></div>
    <div class="main stack">${tab === 'home' ? homeHtml() : trendsHtml()}</div>
    <div class="tabs"><div class="row">
      <button class="${tab === 'home' ? 'on' : ''}" data-act="tab" data-tab="home">Timer</button>
      <button class="${tab === 'trends' ? 'on' : ''}" data-act="tab" data-tab="trends">Trends</button>
    </div></div>`;
}

/* ---------- home ---------- */

function homeHtml() {
  const s = streakInfo();
  const routines = store.get('routines', []);
  const sessions = store.get('sessions', []);
  const checkins = store.get('checkins', []);
  const today = todayStr();

  const streakCard = `
    <div class="card ${s.streak > 0 ? 'streak-lit' : ''}">
      <div class="streak">
        <span class="fire">🔥</span>
        <div>
          <div class="big ${s.streak > 0 ? '' : 'off'}">${s.streak > 0 ? `${s.streak}-DAY STREAK` : 'NO STREAK YET'}</div>
          <div class="sub">Goal: ${s.goalPerDay}× a day, ${s.gapHours}+ hours apart · ${s.todayCount}/${s.goalPerDay} today${s.todayHit ? ' ✓' : ''}</div>
        </div>
      </div>
    </div>`;

  const cards = routines.map((r) => {
    const mine = sessions.filter((x) => x.routineId === r.id);
    const todayMine = mine.filter((x) => x.date === today);
    const last = mine.length ? Math.max(...mine.map((x) => x.startedAt)) : null;
    const sinceMs = last ? Date.now() - last : null;
    const settings = store.get('settings', { goalPerDay: 2, gapHours: 6 });
    const readyAgain = sinceMs == null || sinceMs >= settings.gapHours * 3_600_000;
    const ck = checkins.find((c) => c.date === today && c.routineId === r.id);
    return `
    <div class="card">
      <div class="rname">${esc(r.name)}</div>
      <div class="rmeta"><span>${r.hold}s hold</span><span>${r.rest}s rest</span><span>≤ ${fmtClock(r.ceiling)} total</span></div>
      ${r.cue ? `<div class="rcue">${esc(r.cue)}</div>` : ''}
      <div class="rstat">
        ${last == null ? '<span class="ok">Not done yet. Start any time.</span>'
          : readyAgain ? `<span class="ok">READY</span> <span class="small">last: ${fmtAgo(sinceMs)} · ${todayMine.length} today</span>`
          : `<span class="wait">Done ${fmtAgo(sinceMs)}. Best to wait ${settings.gapHours}h between sessions.</span>`}
      </div>
      <button class="btn btn-start ${readyAgain ? '' : 'amber'}" data-act="start" data-id="${r.id}">
        ${readyAgain ? 'START' : 'START ANYWAY'}
      </button>
      ${ck == null ? `
        <div class="field" style="margin-top:14px">
          <div class="label">How does it feel today? 0 = perfect, 10 = worst</div>
          <div class="chips">${Array.from({ length: 11 }, (_, i) =>
            `<button class="chip" data-act="checkin" data-id="${r.id}" data-score="${i}">${i}</button>`).join('')}</div>
        </div>`
        : `<div class="small" style="margin-top:10px">Today's check-in: ${ck.score}/10 ✓</div>`}
      <button class="btn btn-ghost" style="margin-top:10px" data-act="edit" data-id="${r.id}">Edit</button>
    </div>`;
  }).join('');

  const emptyState = routines.length === 0 ? `
    <div class="card">
      <div class="rname">What are you working on?</div>
      <p style="font-size:15px; color: rgba(255,255,255,.7); margin: 8px 0 4px">
        Name the body part that's bothering you. Wrist, elbow, knee, ankle, anything.
      </p>
      <p style="font-size:15px; color: rgba(255,255,255,.7); margin: 0 0 4px">
        The timer takes care of the rest.
      </p>
      <button class="btn btn-start" data-act="new">NAME MY EXERCISE</button>
    </div>` : '';

  return `${streakCard}${emptyState}${cards}
    ${routines.length ? '<button class="btn btn-ghost" data-act="new">+ Add another exercise</button>' : ''}
    ${helpHtml()}
    <p class="small center" style="padding: 8px 12px 20px">
      The timer beeps even if your phone is on silent.<br>
      Keep it gentle. It should never hurt while you do it.
    </p>`;
}

/* ---------- how-to + FAQ (plain English — family has never heard of any of this) ---------- */

// Copy rules (Boss): no em-dashes, short paragraphs split by blank lines,
// as few words as possible. helpHtml() renders each blank line as a break.
const HOW_TO = [
  ['How do I start?',
   'Tap NAME MY EXERCISE and type the body part. Wrist, elbow, knee, anything.\n\nTap START. Green means gently tense that spot. Blue means relax.\n\nThe beeps say the same thing, so you don’t have to watch the screen.'],
  ['What do HOLD and REST mean?',
   'HOLD (green): gently tense the area for 30 seconds. Like pressing lightly against something that doesn’t move.\n\nREST (blue): let go completely for 60 seconds.\n\nThe app repeats this until 10 minutes are up.'],
  ['What is the NONSTOP button?',
   'On: the timer moves to the next hold or rest by itself.\n\nOff: it beeps and waits for your tap. Good if you need a second to get in position.'],
  ['What is the 0–10 question?',
   'Once a day, tap how that spot feels. 0 is perfect, 10 is the worst.\n\nIt builds your chart on the Trends page, so you can see it getting better over the weeks.'],
  ['What is the fire 🔥 thing?',
   'Your streak. The goal is 2 short sessions a day, at least 6 hours apart.\n\nEvery day you hit that, the streak grows. With tendons, showing up is the whole game.'],
  ['Does it work on silent? Offline?',
   'Yes to both. The beeps play even on silent.\n\nAfter the first open, it works with no internet.\n\nEverything stays on your phone. Nobody else can see it.'],
];

const FAQ = [
  ['How hard should I push?',
   'Barely. About 2 out of 10.\n\nHealing a tendon is a light switch, not a workout. Gentle tension already flips the switch. Pushing harder does not heal faster, and it can set you back.\n\nIf it hurts while you do it, ease off until it doesn’t.'],
  ['Why does the timer keep running if I pause?',
   'Your cells don’t pause.\n\nThe first hold starts a response in the tendon that runs about 10 minutes, whether you’re exercising or answering the phone.\n\nSo the big clock never stops. Pause only pauses the countdown.'],
  ['Why only 10 minutes?',
   'Tendon cells stop listening after about 10 minutes.\n\nMinute 11 adds no healing, just wear.\n\nWhen the app cuts you off, that’s it working.'],
  ['Why twice a day, 6 hours apart?',
   'After one 10 minute dose, the cells need about 6 hours to reset.\n\nTwo spaced doses a day beat one long session.'],
  ['How long until it feels better?',
   'Weeks to a few months. That’s normal for tendons.\n\nDon’t judge by one bad morning. Watch the Trends chart.\n\nThe line drifting down over weeks is the win.'],
  ['What if it hurts while I do it?',
   'Sharp pain means wrong angle or too much effort.\n\nChange the position and lighten up. Stay just under the pain.'],
  ['Do I need weights or equipment?',
   'No. Gently pushing against anything that doesn’t move is enough.\n\nA table, a wall, your other hand.'],
  ['Where does this come from?',
   'Tendon research from Dr. Keith Baar’s lab at UC Davis.\n\nThe gentle holds, the 10 minute cap, and the spaced doses all come from how tendon cells respond to load.\n\nThe app just does the counting.'],
];

function helpHtml() {
  const paras = (a) => a.split('\n\n').map((p) => `<p>${p}</p>`).join('');
  const items = (list) => list.map(([q, a]) => `
    <details class="faq-item"><summary>${q}</summary>${paras(a)}</details>`).join('');
  return `
    <div class="card">
      <div class="rname">How do I use the app?</div>
      ${items(HOW_TO)}
    </div>
    <div class="card">
      <div class="rname">FAQ: the why behind it</div>
      <p class="small" style="margin:6px 0 2px">These rules come from tendon science. Tap a question.</p>
      ${items(FAQ)}
    </div>`;
}

/* ---------- routine editor ---------- */

function renderEditor() {
  const r = editing;
  const isNew = !r.id;
  app.innerHTML = `
    <div class="header"><h1>${isNew ? 'NEW EXERCISE' : 'EDIT'}</h1>
      <button class="small" data-act="cancel-edit">✕ cancel</button></div>
    <div class="main stack">
      <div class="card">
        <div class="field"><label>Name (what body part / movement)</label>
          <input id="f-name" value="${esc(r.name || '')}" placeholder="e.g. Wrist, Elbow, Achilles"></div>
        <div class="field"><label>Hold: seconds of gentle effort</label>
          <input id="f-hold" type="number" inputmode="numeric" value="${r.hold ?? 30}"></div>
        <div class="field"><label>Rest: seconds between holds</label>
          <input id="f-rest" type="number" inputmode="numeric" value="${r.rest ?? 60}"></div>
        <div class="field"><label>Reminder to yourself (optional)</label>
          <textarea id="f-cue" rows="3" placeholder="e.g. keep it pain-free, small angle">${esc(r.cue || '')}</textarea></div>
        <button class="btn btn-start" data-act="save-edit">SAVE</button>
        ${isNew ? '' : '<button class="btn btn-danger" style="margin-top:10px" data-act="delete-routine">Delete this exercise</button>'}
      </div>
    </div>`;
}

/* ---------- timer ---------- */

const SNAP_KEY = 'timer';

function startRun(routine, resume) {
  const now = Date.now();
  runner = resume || {
    routineId: routine.id,
    phase: 'hold',
    phaseStart: now,
    sessionStart: now,
    rounds: 0,
    overtime: 0,
    pausedAt: null,
    cued: false,
  };
  runner.routine = routine;
  runner.nonstop = store.get('nonstop', false);
  runner.sound = true;
  if (!resume) {
    unlockAudio();
    grabWakeLock();
    store.set(SNAP_KEY, snapOf(runner));
    if (runner.sound) playCue('hold');
  }
  render();
}

const snapOf = (r) => ({
  routineId: r.routineId, phase: r.phase, phaseStart: r.phaseStart,
  sessionStart: r.sessionStart, rounds: r.rounds, overtime: r.overtime, pausedAt: r.pausedAt,
});

function durOf(r) { return r.phase === 'hold' ? r.routine.hold : r.routine.rest; }

function stepPhase(r, at, countOvertime) {
  if (r.phase === 'hold') {
    r.rounds += 1;
    if (countOvertime) {
      const over = (at - r.phaseStart) / 1000 - r.routine.hold;
      if (over > 0.5) r.overtime += Math.round(over);
    }
    r.phase = 'rest';
  } else {
    r.phase = 'hold';
  }
}

function advanceTap() {
  const r = runner;
  if (!r || r.pausedAt) return;
  const now = Date.now();
  stepPhase(r, now, true);
  r.phaseStart = now;
  r.cued = false;
  if (r.sound) playCue(r.phase);
  store.set(SNAP_KEY, snapOf(r));
  render();
}

function endRun(ceilingHit) {
  const r = runner;
  if (!r) return;
  const now = Date.now();
  // count the in-progress hold if it reached full duration (never while paused)
  let rounds = r.rounds;
  if (!r.pausedAt && r.phase === 'hold' && (now - r.phaseStart) / 1000 >= r.routine.hold) rounds += 1;
  const total = Math.round((now - r.sessionStart) / 1000);
  dropWakeLock();
  store.del(SNAP_KEY);
  // Save immediately — never gate the log on another tap.
  if (rounds > 0 || total >= 30) {
    const sessions = store.get('sessions', []);
    sessions.push({
      id: uid(), routineId: r.routineId, date: todayStr(r.sessionStart),
      startedAt: r.sessionStart, totalSec: total, rounds, overtimeSec: r.overtime,
    });
    store.set('sessions', sessions);
  }
  if (r.sound) playCue('done');
  doneInfo = { name: r.routine.name, rounds, total, ceilingHit, saved: rounds > 0 || total >= 30 };
  runner = null;
  render();
}

function timerTick() {
  const r = runner;
  if (!r) return;
  const now = Date.now();
  // The 10-min window is biological — it never pauses once the session starts,
  // so the ceiling fires even mid-pause.
  if ((now - r.sessionStart) / 1000 >= r.routine.ceiling) {
    if (r.sound) playCue('ceiling');
    endRun(true);
    return;
  }
  if (r.pausedAt) return;
  const phaseElapsed = (now - r.phaseStart) / 1000;
  if (phaseElapsed >= durOf(r)) {
    if (r.nonstop) {
      let guard = 0;
      while (runner && guard++ < 60) {
        const d = durOf(r) * 1000;
        const behind = Date.now() - r.phaseStart - d;
        if (behind < 0) break;
        stepPhase(r, r.phaseStart + d, false);
        r.phaseStart = r.phaseStart + d;
        if (behind < 2000 && r.sound) playCue(r.phase); // live transition, not backlog
        if ((Date.now() - r.sessionStart) / 1000 >= r.routine.ceiling) { if (r.sound) playCue('ceiling'); endRun(true); return; }
      }
      store.set(SNAP_KEY, snapOf(r));
    } else if (!r.cued) {
      r.cued = true;
      if (r.sound) playCue(r.phase === 'hold' ? 'rest' : 'hold'); // bell = act now, tap it in
    }
  }
}

function renderTimer() {
  const r = runner;
  const now = Date.now();
  const paused = !!r.pausedAt;
  const anchor = paused ? r.pausedAt : now;
  const dur = durOf(r);
  const phaseElapsed = (anchor - r.phaseStart) / 1000;
  const remaining = Math.ceil(dur - phaseElapsed);
  const over = Math.max(0, Math.floor(phaseElapsed - dur));
  const sessionElapsed = (now - r.sessionStart) / 1000; // total clock never pauses
  const nearCeiling = sessionElapsed >= r.routine.ceiling - 90;
  const overdue = remaining <= 0 && !r.nonstop;
  const bgClass = overdue ? 'overdue' : r.phase === 'hold' ? 'hold' : 'rest';

  app.innerHTML = `
    <div class="full ${bgClass}">
      <div class="timer-top">
        <span class="tname">${esc(r.routine.name)}</span>
        <div style="display:flex;gap:8px">
          <button class="mini ${r.sound ? '' : 'off'}" data-act="t-sound">🔊</button>
          <button class="mini ${r.nonstop ? '' : 'off'}" data-act="t-nonstop">NONSTOP</button>
        </div>
      </div>
      <button class="timer-mid" data-act="t-tap">
        <div class="phase-word">${paused ? 'PAUSED' : r.phase === 'hold' ? 'HOLD' : 'REST'}</div>
        <div class="count">${overdue ? `+${over}` : Math.max(0, remaining)}</div>
        ${overdue && !paused ? `<div class="tapnow">${r.phase === 'hold' ? 'TIME — LET GO & TAP' : 'GO — TAP WHEN HOLDING'}</div>` : ''}
        <div class="round">ROUND ${r.rounds + (r.phase === 'hold' ? 1 : 0)}</div>
        <div class="elapsed ${nearCeiling ? 'warn' : ''}">${fmtClock(sessionElapsed)} / ${fmtClock(r.routine.ceiling)}</div>
        ${nearCeiling ? '<div class="ceiling-warn">ALMOST DONE — 10 MIN IS THE LIMIT</div>' : ''}
      </button>
      <div class="timer-actions">
        <button data-act="t-pause">${paused ? 'RESUME' : 'PAUSE'}</button>
        <button class="end" data-act="t-end">END</button>
      </div>
    </div>`;

  repaintTimer = setInterval(() => {
    timerTick();
    if (runner) updateTimerNumbers();
  }, 200);
}

// light DOM update between full renders (no flicker on the big number)
function updateTimerNumbers() {
  const r = runner;
  if (!r) return;
  const paused = !!r.pausedAt;
  const anchor = paused ? r.pausedAt : Date.now();
  const dur = durOf(r);
  const phaseElapsed = (anchor - r.phaseStart) / 1000;
  const remaining = Math.ceil(dur - phaseElapsed);
  const over = Math.max(0, Math.floor(phaseElapsed - dur));
  const overdue = remaining <= 0 && !r.nonstop;
  const full = app.querySelector('.full');
  const want = overdue ? 'overdue' : r.phase === 'hold' ? 'hold' : 'rest';
  if (!full.classList.contains(want)) { render(); return; }
  const count = app.querySelector('.count');
  const word = app.querySelector('.phase-word');
  if (count) count.textContent = overdue ? `+${over}` : String(Math.max(0, remaining));
  if (word) word.textContent = paused ? 'PAUSED' : r.phase === 'hold' ? 'HOLD' : 'REST';
  const el = app.querySelector('.elapsed');
  if (el) el.textContent = `${fmtClock((Date.now() - r.sessionStart) / 1000)} / ${fmtClock(r.routine.ceiling)}`;
  const tap = app.querySelector('.tapnow');
  if (overdue && !paused && !tap) { render(); return; }
  if ((!overdue || paused) && tap) { render(); return; }
}

function renderDone() {
  const d = doneInfo;
  app.innerHTML = `
    <div class="full">
      <div class="timer-mid" style="text-align:center;padding:24px">
        <div class="phase-word" style="color:#6ee7b7">DONE ✓</div>
        <div class="round">${esc(d.name)}</div>
        <div class="elapsed">${d.rounds} rounds · ${fmtClock(d.total)}</div>
        ${d.ceilingHit ? '<div class="ceiling-warn" style="margin-top:12px">Hit the 10 minute limit. That\'s the plan working, not a problem.</div>' : ''}
        ${d.saved ? '<div class="small" style="margin-top:12px">Saved automatically.</div>'
                   : '<div class="small" style="margin-top:12px">Too short to count. Not saved.</div>'}
      </div>
      <div class="timer-actions" style="grid-template-columns:1fr">
        <button style="background:#059669" data-act="t-close">OK</button>
      </div>
    </div>`;
}

/* ---------- trends ---------- */

function trendsHtml() {
  const routines = store.get('routines', []);
  const checkins = store.get('checkins', []);
  const sessions = store.get('sessions', []);
  if (!routines.length) return '<div class="card small">No exercises yet.</div>';
  return routines.map((r) => {
    const series = checkins.filter((c) => c.routineId === r.id).sort((a, b) => a.date < b.date ? -1 : 1).slice(-30);
    const count = sessions.filter((s) => s.routineId === r.id).length;
    return `
    <div class="card">
      <div class="rname">${esc(r.name)}</div>
      <div class="small" style="margin:4px 0 10px">${count} sessions total · check-ins: lower = better</div>
      ${series.length >= 2 ? chartSvg(series) : '<div class="small">Chart appears after 2+ daily check-ins.</div>'}
    </div>`;
  }).join('');
}

function chartSvg(series) {
  const W = 340, H = 120, P = 14;
  const xs = (i) => P + (i * (W - 2 * P)) / Math.max(1, series.length - 1);
  const ys = (v) => H - P - (v * (H - 2 * P)) / 10;
  const pts = series.map((c, i) => `${xs(i)},${ys(c.score)}`).join(' ');
  const dots = series.map((c, i) => `<circle cx="${xs(i)}" cy="${ys(c.score)}" r="3" fill="#38bdf8"/>`).join('');
  const grid = [0, 5, 10].map((v) => `<line x1="${P}" y1="${ys(v)}" x2="${W - P}" y2="${ys(v)}" stroke="rgba(255,255,255,.08)"/>
    <text x="2" y="${ys(v) + 4}" font-size="9" fill="rgba(255,255,255,.3)">${v}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${grid}
    <polyline points="${pts}" fill="none" stroke="#38bdf8" stroke-width="2"/>${dots}
    <text x="${P}" y="${H - 1}" font-size="9" fill="rgba(255,255,255,.3)">${series[0].date}</text>
    <text x="${W - P}" y="${H - 1}" font-size="9" text-anchor="end" fill="rgba(255,255,255,.3)">${series[series.length - 1].date}</text>
  </svg>`;
}

/* ---------- events ---------- */

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const routines = store.get('routines', []);

  if (act === 'tab') { tab = btn.dataset.tab; render(); }
  else if (act === 'start') {
    const r = routines.find((x) => x.id === btn.dataset.id);
    if (r) startRun(r, null);
  }
  else if (act === 'checkin') {
    const checkins = store.get('checkins', []);
    checkins.push({ date: todayStr(), routineId: btn.dataset.id, score: Number(btn.dataset.score) });
    store.set('checkins', checkins);
    render();
  }
  else if (act === 'new') { editing = {}; render(); }
  else if (act === 'edit') { editing = { ...routines.find((x) => x.id === btn.dataset.id) }; render(); }
  else if (act === 'cancel-edit') { editing = null; render(); }
  else if (act === 'save-edit') {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return;
    const r = {
      id: editing.id || uid(),
      name,
      hold: Math.max(5, Number(document.getElementById('f-hold').value) || 30),
      rest: Math.max(5, Number(document.getElementById('f-rest').value) || 60),
      ceiling: editing.ceiling || 600,
      cue: document.getElementById('f-cue').value.trim(),
    };
    const next = editing.id ? routines.map((x) => (x.id === r.id ? r : x)) : [...routines, r];
    store.set('routines', next);
    editing = null;
    render();
  }
  else if (act === 'delete-routine') {
    if (!confirm('Delete this exercise? Its history stays saved.')) return;
    store.set('routines', routines.filter((x) => x.id !== editing.id));
    editing = null;
    render();
  }
  else if (act === 't-sound') { runner.sound = !runner.sound; render(); }
  else if (act === 't-nonstop') {
    runner.nonstop = !runner.nonstop;
    store.set('nonstop', runner.nonstop);
    render();
  }
  else if (act === 't-tap') {
    const r = runner;
    if (!r || r.pausedAt || r.nonstop) return;
    const phaseElapsed = (Date.now() - r.phaseStart) / 1000;
    if (phaseElapsed >= durOf(r)) advanceTap();
  }
  else if (act === 't-pause') {
    const r = runner;
    const now = Date.now();
    if (r.pausedAt) {
      // only the phase countdown freezes — the total 10-min clock never pauses
      r.phaseStart += now - r.pausedAt;
      r.pausedAt = null;
    } else r.pausedAt = now;
    store.set(SNAP_KEY, snapOf(r));
    render();
  }
  else if (act === 't-end') { endRun(false); }
  else if (act === 't-close') { doneInfo = null; render(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && runner) { grabWakeLock(); timerTick(); }
});

/* ---------- boot ---------- */

seedIfEmpty();
// resume a timer that survived a reload/kill (within its ceiling window)
(() => {
  const snap = store.get(SNAP_KEY, null);
  if (!snap) return;
  const routine = store.get('routines', []).find((r) => r.id === snap.routineId);
  const alive = routine && (Date.now() - snap.sessionStart) / 1000 < (routine.ceiling || 600);
  if (alive) startRun(routine, { ...snap, cued: false });
  else store.del(SNAP_KEY);
})();
render();
