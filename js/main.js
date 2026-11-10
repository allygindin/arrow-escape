// Screens, input, timer and saved stats.
import { DIFFICULTIES, DIFFICULTY_ORDER, Game, generateLevel, randomSeed } from './logic.js';
import { Renderer } from './render.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#board');
const renderer = new Renderer(canvas);

// ---------------------------------------------------------------- storage

const STORE_KEY = 'arrow-escape:v1';
const store = loadStore();

function loadStore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (!DIFFICULTIES[s.difficulty]) s.difficulty = 'easy';
  if (!s.stats || typeof s.stats !== 'object') s.stats = {};
  for (const d of DIFFICULTY_ORDER) {
    s.stats[d] = Object.assign({ played: 0, won: 0, bestMs: null, streak: 0, bestStreak: 0 }, s.stats[d]);
  }
  return s;
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* private mode etc. */ }
}

// ---------------------------------------------------------------- timer

let activeMs = 0, since = null;
const timerStart = () => { if (since === null) since = performance.now(); };
const timerStop = () => { if (since !== null) { activeMs += performance.now() - since; since = null; } };
const elapsed = () => activeMs + (since === null ? 0 : performance.now() - since);
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- game flow

let level = null, game = null, hintId = -1;

function startGame(lv) {
  level = lv;
  game = new Game(lv);
  hintId = -1;
  activeMs = 0; since = null;
  timerStart();
  hideOverlay();
  buildHearts();
  renderer.setGame(game);
  updateHud();
}

function newLevel(diff = store.difficulty) {
  store.difficulty = diff;
  saveStore();
  startGame(generateLevel(diff, randomSeed()));
}

function retry() { startGame(level); }

function play(id) {
  if (renderer.isAnimating(id)) return;
  const g = game;
  const res = g.tap(id);
  if (!res) return;
  if (res.type === 'exit') {
    if (id === hintId) hintId = -1;
    if (g.status === 'won') { timerStop(); recordResult(true); }
    renderer.exit(id, () => { if (g === game && g.status === 'won') showWin(); });
  } else {
    if (g.status === 'lost') { timerStop(); recordResult(false); }
    popHeart(g.hearts);
    renderer.bump(id, res.steps, res.blocker, () => { if (g === game && g.status === 'lost') showLose(); });
  }
  updateHud();
}

let lastResult = null;
function recordResult(won) {
  const s = store.stats[store.difficulty];
  const ms = Math.round(elapsed());
  s.played++;
  let newBest = false;
  if (won) {
    s.won++;
    s.streak++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    if (s.bestMs === null || ms < s.bestMs) { s.bestMs = ms; newBest = true; }
  } else {
    s.streak = 0;
  }
  saveStore();
  lastResult = { ms, newBest };
}

function useHint() {
  if (!game || game.status !== 'playing') return;
  if (hintId >= 0 && game.alive.has(hintId)) { renderer.setHint(hintId); return; } // still showing: free
  const id = game.hint();
  if (id < 0) return;
  hintId = id;
  renderer.setHint(id);
  updateHud();
}

// ---------------------------------------------------------------- HUD

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.4-4.5-9.6-9.1C.9 8.6 3 4.6 6.8 4.6c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.8 0 5.9 4 4.4 7.3C19.4 16.5 12 21 12 21z"/></svg>';

function buildHearts() {
  $('#hearts').innerHTML = Array.from({ length: game.maxHearts }, () => `<span class="heart">${HEART}</span>`).join('');
}

function popHeart(index) {
  const el = $('#hearts').children[index];
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth; // restart the animation
  el.classList.add('pop');
}

function updateHud() {
  document.querySelectorAll('.seg button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.diff === store.difficulty));
  });
  [...$('#hearts').children].forEach((el, i) => el.classList.toggle('lost', i >= game.hearts));
  $('#hearts').setAttribute('aria-label', `${game.hearts} of ${game.maxHearts} hearts left`);
  $('#left').textContent = `${game.remaining} ${game.remaining === 1 ? 'arrow' : 'arrows'} left`;
  $('#hint-count').textContent = String(game.hints);
  $('#hint').disabled = game.status !== 'playing' || (game.hints === 0 && !(hintId >= 0 && game.alive.has(hintId)));
  $('#timer').textContent = fmt(elapsed());
}

setInterval(() => {
  if (game && game.status === 'playing') $('#timer').textContent = fmt(elapsed());
}, 250);

// ---------------------------------------------------------------- overlays

const overlay = $('#overlay');
function showOverlay(html) {
  $('#card').innerHTML = html;
  overlay.hidden = false;
  const primary = overlay.querySelector('.primary');
  if (primary) primary.focus({ preventScroll: true });
}
function hideOverlay() { overlay.hidden = true; }

function showWin() {
  const s = store.stats[store.difficulty];
  const r = lastResult || { ms: elapsed(), newBest: false };
  showOverlay(`
    <p class="kicker">${DIFFICULTIES[store.difficulty].label}</p>
    <h2>Board cleared!</h2>
    <div class="stats">
      <div><b>${game.mistakes}</b><span>${game.mistakes === 1 ? 'Mistake' : 'Mistakes'}</span></div>
      <div><b>${game.hintsUsed}</b><span>Hints used</span></div>
      <div><b>${fmt(r.ms)}</b><span>Time</span></div>
    </div>
    <p class="sub">${r.newBest ? '<strong>New best time!</strong> · ' : ''}Best ${fmt(s.bestMs)} · ${s.won} won · Streak ${s.streak}</p>
    <div class="buttons"><button class="btn primary" data-act="new">Next level</button></div>`);
}

function showLose() {
  showOverlay(`
    <p class="kicker">${DIFFICULTIES[store.difficulty].label}</p>
    <h2>Out of hearts</h2>
    <p class="sub">${game.remaining} ${game.remaining === 1 ? 'arrow' : 'arrows'} left on the board.</p>
    <div class="buttons">
      <button class="btn primary" data-act="retry">Try again</button>
      <button class="btn" data-act="new">New level</button>
    </div>`);
}


// ---------------------------------------------------------------- input

let down = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!game || game.status !== 'playing') return;
  e.preventDefault();
  down = { pointer: e.pointerId, x: e.clientX, y: e.clientY, arrow: renderer.hitTest(e.clientX, e.clientY) };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || down.pointer !== e.pointerId) return;
  const d = down;
  down = null;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > Math.max(24, renderer.cell * 0.6)) return; // a drag, not a tap
  if (d.arrow >= 0) play(d.arrow);
});
canvas.addEventListener('pointercancel', () => { down = null; });

// Apple Pencil hover (and mouse, for testing on a computer): highlight + exit preview.
canvas.addEventListener('pointermove', (e) => {
  if ((e.pointerType === 'pen' || e.pointerType === 'mouse') && e.buttons === 0) {
    renderer.setHover(game && game.status === 'playing' ? renderer.hitTest(e.clientX, e.clientY) : -1);
  }
});
canvas.addEventListener('pointerleave', () => renderer.setHover(-1));

// Buttons. They act on pointerup rather than click: Safari can drop the click
// for an Apple Pencil tap (the Pencil reports tiny movements, and touchmove is
// cancelled below to stop scrolling), but pointer events always arrive.
// click is still handled for keyboards, skipped right after a pointer press.
function pressButton(b) {
  if (b.id === 'hint') useHint();
  else if (b.id === 'new') newLevel();
  else if (b.id === 'reload') location.reload();
  else if (b.dataset.diff) newLevel(b.dataset.diff);
  else if (b.dataset.act === 'retry') retry();
  else if (b.dataset.act === 'new') newLevel();
}

const BUTTONS = '#hint, #new, #reload, .seg button, #overlay button[data-act]';
let pressed = null, lastPress = 0;
document.addEventListener('pointerdown', (e) => {
  pressed = e.target.closest ? e.target.closest(BUTTONS) : null;
});
document.addEventListener('pointerup', (e) => {
  const start = pressed;
  pressed = null;
  if (!start || start.disabled) return;
  // Only if the press ends on the button it started on.
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (!under || under.closest(BUTTONS) !== start) return;
  lastPress = performance.now();
  pressButton(start);
});
document.addEventListener('pointercancel', () => { pressed = null; });
document.addEventListener('click', (e) => {
  const b = e.target.closest ? e.target.closest(BUTTONS) : null;
  if (!b || b.disabled || performance.now() - lastPress < 800) return;
  pressButton(b);
});

// No scrolling, pinch zoom, double-tap zoom or callouts on the game screen.
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- lifecycle

const resize = () => renderer.resize();
if (window.ResizeObserver) new ResizeObserver(resize).observe($('.stage'));
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));

let swReg = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { timerStop(); return; }
  if (game && game.status === 'playing') timerStart();
  if (swReg) swReg.update().catch(() => {});
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => { swReg = reg; })
    .catch((err) => console.warn('Offline mode unavailable', err));
  // A new release took over: offer a reload instead of interrupting the game.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('#toast').hidden = false; });
}

renderer.resize();
newLevel(store.difficulty);
