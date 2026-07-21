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
  hold: [[880, 140], [880, 140, 220]],                  // two high beeps → GO, hold now (or LEFT)
  holdB: [[587, 140], [587, 140, 220]],                 // two mid beeps → switch: RIGHT side
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
      <div class="rmeta">${r.alt
        ? `<span>${r.hold}s each side</span><span>left ↔ right</span><span>≤ ${fmtClock(r.ceiling)} total</span>`
        : `<span>${r.hold}s hold</span><span>${r.rest}s rest</span><span>≤ ${fmtClock(r.ceiling)} total</span>`}</div>
      ${r.cue ? `<div class="rcue">${esc(r.cue)}</div>` : ''}
      <div class="rstat">
        ${last == null ? '<span class="ok">Not done yet. Start any time.</span>'
          : readyAgain ? `<span class="ok">READY</span> <span class="small">last: ${fmtAgo(sinceMs)} · ${todayMine.length} today</span>`
          : `<span class="wait">Done ${fmtAgo(sinceMs)}. Best to wait ${settings.gapHours}h between sessions.</span>`}
      </div>
      <button class="btn btn-start ${readyAgain ? '' : 'amber'}" data-act="start" data-id="${r.id}">
        ${readyAgain ? (r.alt ? 'START · LEFT FIRST' : 'START') : 'START ANYWAY'}
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

// Quick Start: the absolute basics, shown above the exercises.
const QUICK_START = [
  ['What is an isometric?',
   'Push or pull against something that does not move, and hold still.\n\nNo reps. No motion. Just gentle tension.'],
  ['How hard do I hold?',
   '2 out of 10. It should feel almost too easy.\n\nWhen in doubt: do the movement that hurts, at 1 out of 10. You should barely feel it.'],
  ['What should I NOT do?',
   'Do not push into sharp pain.\n\nDo not bounce or move during a hold.\n\nDo not go past the 10 minutes. More is not better.'],
  ['Then what?',
   'That’s it. Tap START and follow the colors and beeps.\n\nThe app does the rest.'],
];

// One simple exercise idea per tendon, with a built-in diagram (SVG, offline,
// no copyright). Figure style: white stick figure, amber = the sore spot,
// blue arrow = where the gentle push goes.
const FIG = {
  open: '<svg viewBox="0 0 200 160" class="idea-fig" fill="none" stroke="#e5e7eb" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">',
  close: '</svg>',
  hl: 'stroke="#f59e0b" stroke-width="6"',
  ar: 'stroke="#38bdf8" stroke-width="4"',
};

const WORKOUT_IDEAS = [
  ['Achilles: standing calf hold',
   `${FIG.open}
    <path d="M20 150 H180"/><path d="M170 20 V150" stroke-width="4"/>
    <circle cx="95" cy="30" r="9"/><path d="M95 39 V95"/>
    <path d="M95 55 L165 62"/>
    <path d="M95 95 L100 120 L102 138"/>
    <path d="M102 138 L92 147"/><path d="M102 138 L116 150"/>
    <path d="M102 122 L94 144" ${FIG.hl}/>
    <path d="M82 142 V122 M82 122 L78 128 M82 122 L86 128" ${FIG.ar}/>
    ${FIG.close}`,
   'Stand on the sore leg and lift the heel off the floor. Hold the wall for balance.\n\nHold still. 2 out of 10.'],
  ['Knee: split squat hold',
   `${FIG.open}
    <path d="M15 150 H185"/>
    <circle cx="85" cy="28" r="9"/><path d="M85 37 L90 88"/>
    <path d="M86 52 L100 75"/>
    <path d="M90 88 L122 100 L126 145"/><path d="M114 150 H142"/>
    <path d="M90 88 L65 115 L58 145 L48 150"/>
    <circle cx="122" cy="100" r="9" ${FIG.hl}/>
    ${FIG.close}`,
   'Sore leg in front, knee bent. Sink until you feel light effort.\n\nHold still. Works for the knee, and for the Achilles too.\n\nSet the exercise to SWITCH SIDES to do both knees.'],
  ['Wrist: table press hold',
   `${FIG.open}
    <path d="M30 150 H195"/><path d="M95 105 H185"/><path d="M103 105 V150 M177 105 V150" stroke-width="4"/>
    <circle cx="52" cy="30" r="9"/><path d="M56 38 L72 90"/>
    <path d="M72 90 L80 120 L78 148"/><path d="M72 90 L62 120 L58 148"/>
    <path d="M58 45 L90 72 L118 98"/><path d="M118 98 L140 104"/>
    <circle cx="122" cy="100" r="7" ${FIG.hl}/>
    <path d="M158 72 V92 M158 92 L154 86 M158 92 L162 86" ${FIG.ar}/>
    ${FIG.close}`,
   'Palm flat on a table, arm set up like a push up. Lean in until you barely feel it.\n\nIf a push up position is what hurts, this is the one. Do it at 1 out of 10.\n\nBoth wrists at the same time is fine. Keep BOTH AT ONCE.'],
  ['Hip flexor: seated knee press',
   `${FIG.open}
    <path d="M20 150 H180"/>
    <path d="M60 105 H115 M62 105 V55 M112 105 V150 M64 105 V150" stroke-width="4"/>
    <circle cx="98" cy="32" r="9"/><path d="M98 41 V103"/>
    <path d="M98 103 L132 90 V138"/><path d="M126 142 H140"/>
    <path d="M98 55 L128 86"/>
    <circle cx="104" cy="99" r="7" ${FIG.hl}/>
    <path d="M155 108 V92 M155 92 L151 97 M155 92 L159 97" ${FIG.ar}/>
    ${FIG.close}`,
   'Sit down. Lift the sore side knee a little. Press your hand down on top of it.\n\nLeg pushes up, hand pushes down. Nothing moves.\n\nSet it to SWITCH SIDES. Left, then right, one at a time.'],
  ['Glutes / side of hip: bridge hold',
   `${FIG.open}
    <path d="M15 145 H185"/>
    <circle cx="40" cy="132" r="9"/>
    <path d="M52 138 L110 105"/><path d="M110 105 L138 112 L142 143"/><path d="M132 145 H150"/>
    <path d="M60 140 H95"/>
    <circle cx="112" cy="108" r="8" ${FIG.hl}/>
    <path d="M118 95 V78 M118 78 L114 84 M118 78 L122 84" ${FIG.ar}/>
    ${FIG.close}`,
   'Lie on your back, knees bent. Lift your hips a little and hold.\n\nSore on the outside of the hip is usually a glute tendon. This is real and this helps.\n\nNew hip? Keep it tiny, and clear it with your doctor.'],
  ['Elbow / triceps: table push down',
   `${FIG.open}
    <path d="M20 150 H180"/><path d="M105 90 H180"/><path d="M113 90 V150 M172 90 V150" stroke-width="4"/>
    <circle cx="72" cy="25" r="9"/><path d="M72 34 V95"/>
    <path d="M72 95 L65 148 M72 95 L80 148"/>
    <path d="M72 48 L88 80 L132 88"/>
    <path d="M66 52 L81 82" ${FIG.hl}/>
    <path d="M148 60 V80 M148 80 L144 74 M148 80 L152 74" ${FIG.ar}/>
    ${FIG.close}`,
   'Elbow bent 90 degrees. Press your fist down into a table.\n\nHold still. You should barely feel the back of your arm.'],
  ['Forearm: all fours press',
   `${FIG.open}
    <path d="M20 150 H180"/>
    <circle cx="52" cy="68" r="9"/>
    <path d="M64 78 L125 85"/>
    <path d="M68 79 L66 148"/><path d="M56 148 H82"/>
    <path d="M125 85 L142 146"/><path d="M142 146 L172 148"/>
    <path d="M67 112 L66 144" ${FIG.hl}/>
    <path d="M98 115 V135 M98 135 L94 129 M98 135 L102 129" ${FIG.ar}/>
    ${FIG.close}`,
   'On all fours, like the start of cat cow. Knees down, arms straight.\n\nPress your hands into the ground. Spread the pressure evenly through your fingers.\n\nLean in a touch until you barely feel the forearms. Hold still.'],
  ['Grip 🥋: the no hang (beast mode)',
   `${FIG.open}
    <path d="M20 150 H180"/>
    <path d="M118 25 V150 M162 25 V150 M108 25 H172" stroke-width="4"/>
    <circle cx="95" cy="58" r="9"/><path d="M95 67 V110"/>
    <path d="M95 110 L87 130 L90 148 M95 110 L104 130 L101 148"/>
    <path d="M95 72 L116 30 M95 72 L128 30"/>
    <circle cx="116" cy="28" r="6" ${FIG.hl}/><circle cx="128" cy="28" r="6" ${FIG.hl}/>
    <path d="M145 42 V60 M145 60 L141 54 M145 60 L149 54" ${FIG.ar}/>
    ${FIG.close}`,
   'This one is not rehab. This one is for grip.\n\nGrab a door frame, a ledge, or a pull up bar. Pull down with your fingers, but your feet never leave the floor. A pull up where you never go up.\n\nPull firm, nowhere near max. Light is the trick.\n\nA pro climber tested this exact routine, 10 minutes twice a day. His grip went up 19 kilos in 30 days. About 40 percent more load.\n\nJiu jitsu people: this is grip fighting fuel. Same timer, same 2 a day. Beast mode, gently.'],
];
const HOW_TO = [
  ['How do I start?',
   'Tap NAME MY EXERCISE and type the body part. Wrist, elbow, knee, anything.\n\nTap START. Green means gently tense that spot. Blue means relax.\n\nThe beeps say the same thing, so you don’t have to watch the screen.'],
  ['What do HOLD and REST mean?',
   'HOLD (green): gently tense the area for 30 seconds. Like pressing lightly against something that doesn’t move.\n\nREST (blue): let go completely for 60 seconds.\n\nThe app repeats this until 10 minutes are up.'],
  ['What is the NONSTOP button?',
   'On: the timer moves to the next hold or rest by itself.\n\nOff: it beeps and waits for your tap. Good if you need a second to get in position.'],
  ['What does SWITCH SIDES mean?',
   'For body parts you have two of. Wrists, knees, hips.\n\nIf you can do both at once, keep BOTH AT ONCE. Normal timer.\n\nIf both at once is too hard, pick SWITCH SIDES when you edit the exercise. The screen says HOLD LEFT, then HOLD RIGHT, then rest. One side always rests while the other works.'],
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
  ['Can I use this to get STRONGER, not just heal?',
   'Yes. Tendons grow from short spaced doses either way, hurt or not.\n\nSee the no hang in Workout ideas. That one is pure strength. Grip for jiu jitsu, climbing, opening jars, everything.\n\nSame timer. Same 2 a day.'],
  ['Where does this come from?',
   'Tendon research from Dr. Keith Baar’s lab at UC Davis.\n\nThe gentle holds, the 10 minute cap, and the spaced doses all come from how tendon cells respond to load.\n\nThe app just does the counting.'],
];

const paras = (a) => a.split('\n\n').map((p) => `<p>${p}</p>`).join('');
const accordion = (list) => list.map(([q, a]) => `
  <details class="faq-item"><summary>${q}</summary>${paras(a)}</details>`).join('');

function quickStartHtml() {
  return `
    <div class="card">
      <div class="rname">Quick Start</div>
      <p class="small" style="margin:6px 0 2px">New here? These four. Then the app does the rest.</p>
      ${accordion(QUICK_START)}
    </div>`;
}

function ideasHtml() {
  const items = WORKOUT_IDEAS.map(([title, svg, text]) => `
    <details class="faq-item"><summary>${title}</summary>${svg}${paras(text)}</details>`).join('');
  return `
    <div class="card">
      <div class="rname">Workout ideas: one per spot</div>
      <p class="small" style="margin:6px 0 2px">Tap yours to see the picture. Amber = the sore spot. Blue arrow = the gentle push.</p>
      ${items}
    </div>`;
}

function helpHtml() {
  return `
    ${quickStartHtml()}
    ${ideasHtml()}
    <div class="card">
      <div class="rname">FAQ: the why behind it</div>
      <p class="small" style="margin:6px 0 2px">These rules come from tendon science. Tap a question.</p>
      ${accordion(FAQ)}
    </div>
    <div class="card">
      <div class="rname">How do I use the app?</div>
      ${accordion(HOW_TO)}
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
        <div class="field"><label>One side or both?</label>
          <div class="seg">
            <button class="segbtn ${r.alt ? '' : 'on'}" data-act="pick-alt" data-alt="0">BOTH AT ONCE</button>
            <button class="segbtn ${r.alt ? 'on' : ''}" data-act="pick-alt" data-alt="1">SWITCH SIDES</button>
          </div>
          <p class="small" style="margin-top:6px">
            Both at once: normal timer. Two wrists together counts.<br>
            Switch sides: the timer says LEFT, then RIGHT, then rest.
            Use it when doing both at once is too hard, like hips or split squats.
          </p>
        </div>
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
    roundsB: 0,
    overtime: 0,
    pausedAt: null,
    cued: false,
  };
  runner.roundsB = runner.roundsB || 0;
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
  sessionStart: r.sessionStart, rounds: r.rounds, roundsB: r.roundsB,
  overtime: r.overtime, pausedAt: r.pausedAt,
});

// SWITCH SIDES (routine.alt): LEFT hold → RIGHT hold → shared rest → LEFT…
// Shared rest = rest minus hold, so each side still gets the full rest off
// while the block keeps moving (same math as the main workout app).
function durOf(r) {
  if (r.phase === 'rest') {
    return r.routine.alt ? Math.max(0, r.routine.rest - r.routine.hold) : r.routine.rest;
  }
  return r.routine.hold;
}

function nextPhaseOf(r) {
  if (!r.routine.alt) return r.phase === 'hold' ? 'rest' : 'hold';
  if (r.phase === 'hold') return 'holdB';
  if (r.phase === 'holdB') return (r.routine.rest - r.routine.hold > 0) ? 'rest' : 'hold';
  return 'hold';
}

function stepPhase(r, at, countOvertime) {
  if (r.phase === 'hold' || r.phase === 'holdB') {
    if (r.phase === 'hold') r.rounds += 1; else r.roundsB += 1;
    if (countOvertime) {
      const over = (at - r.phaseStart) / 1000 - r.routine.hold;
      if (over > 0.5) r.overtime += Math.round(over);
    }
  }
  r.phase = nextPhaseOf(r);
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
  let rounds = r.rounds, roundsB = r.roundsB;
  const held = !r.pausedAt && (now - r.phaseStart) / 1000 >= r.routine.hold;
  if (held && r.phase === 'hold') rounds += 1;
  if (held && r.phase === 'holdB') roundsB += 1;
  const total = Math.round((now - r.sessionStart) / 1000);
  dropWakeLock();
  store.del(SNAP_KEY);
  // Save immediately — never gate the log on another tap.
  const saved = rounds + roundsB > 0 || total >= 30;
  if (saved) {
    const sessions = store.get('sessions', []);
    sessions.push({
      id: uid(), routineId: r.routineId, date: todayStr(r.sessionStart),
      startedAt: r.sessionStart, totalSec: total, rounds, roundsB, overtimeSec: r.overtime,
    });
    store.set('sessions', sessions);
  }
  if (r.sound) playCue('done');
  doneInfo = { name: r.routine.name, alt: !!r.routine.alt, rounds, roundsB, total, ceilingHit, saved };
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
      if (r.sound) playCue(nextPhaseOf(r)); // bell = act now, tap it in
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
  const isHold = r.phase !== 'rest';
  const bgClass = overdue ? 'overdue' : r.phase === 'hold' ? 'hold' : r.phase === 'holdB' ? 'holdB' : 'rest';
  const phaseWord = r.phase === 'rest' ? 'REST'
    : r.routine.alt ? (r.phase === 'hold' ? 'HOLD LEFT' : 'HOLD RIGHT') : 'HOLD';
  const roundNow = r.routine.alt
    ? `L ${r.rounds + (r.phase === 'hold' ? 1 : 0)} · R ${r.roundsB + (r.phase === 'holdB' ? 1 : 0)}`
    : `ROUND ${r.rounds + (r.phase === 'hold' ? 1 : 0)}`;

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
        <div class="phase-word">${paused ? 'PAUSED' : phaseWord}</div>
        <div class="count">${overdue ? `+${over}` : Math.max(0, remaining)}</div>
        ${overdue && !paused ? `<div class="tapnow">${isHold ? 'TIME — LET GO & TAP' : 'GO — TAP WHEN HOLDING'}</div>` : ''}
        <div class="round">${roundNow}</div>
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
  const want = overdue ? 'overdue' : r.phase === 'hold' ? 'hold' : r.phase === 'holdB' ? 'holdB' : 'rest';
  if (!full.classList.contains(want)) { render(); return; }
  const count = app.querySelector('.count');
  const word = app.querySelector('.phase-word');
  if (count) count.textContent = overdue ? `+${over}` : String(Math.max(0, remaining));
  if (word) word.textContent = paused ? 'PAUSED'
    : r.phase === 'rest' ? 'REST'
    : r.routine.alt ? (r.phase === 'hold' ? 'HOLD LEFT' : 'HOLD RIGHT') : 'HOLD';
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
        <div class="elapsed">${d.alt ? `L ${d.rounds} · R ${d.roundsB} holds` : `${d.rounds} rounds`} · ${fmtClock(d.total)}</div>
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
  else if (act === 'pick-alt') {
    editing.alt = btn.dataset.alt === '1' ? 1 : 0;
    editing.name = document.getElementById('f-name').value;
    editing.hold = Number(document.getElementById('f-hold').value) || 30;
    editing.rest = Number(document.getElementById('f-rest').value) || 60;
    editing.cue = document.getElementById('f-cue').value;
    render();
  }
  else if (act === 'save-edit') {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return;
    const r = {
      id: editing.id || uid(),
      name,
      hold: Math.max(5, Number(document.getElementById('f-hold').value) || 30),
      rest: Math.max(5, Number(document.getElementById('f-rest').value) || 60),
      ceiling: editing.ceiling || 600,
      alt: editing.alt ? 1 : 0,
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
