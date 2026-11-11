// Arrow Escape (cube): level generation, rules and solver.
// No DOM access in this file, so the test page can use it on its own.
//
// The board is the surface of a cube: 6 faces of size x size cells. Cells are
// numbered face * size² + v * size + u. An arrow can bend over the cube's
// edges onto other faces. Tapped, it slides the way its head points to the
// edge of the face its head is on, then flies off into space.
//
// A level is { difficulty, seed, size, arrows, solution }.
// Each arrow is { id, cells, color }: cells (cell numbers) run from the tail
// to the head. `id` is the arrow's index.

export const DIFFICULTIES = {
  // size: cells along each face's side; minLen/maxLen: cells per arrow; bend:
  // chance of turning at each cell; density: share of cells to fill; aim:
  // preference for heads with long exit paths; headTries: empty cells compared
  // when choosing each head; candidates: boards generated, keeping the hardest
  // (fewest arrows free at the start, or with pick: 'mix', most solving
  // rounds minus freeWeight x arrows free at the start).
  easy:   { label: 'Easy',   size: 4,  minLen: 3, maxLen: 8,  bend: 0.6,  density: 0.9,  aim: 3, candidates: 40 },
  medium: { label: 'Medium', size: 5,  minLen: 4, maxLen: 12, bend: 0.65, density: 0.92, aim: 5, headTries: 8,
            candidates: 100, pick: 'mix', freeWeight: 2 },
  hard:   { label: 'Hard',   size: 7,  minLen: 3, maxLen: 10, bend: 0.65, density: 0.95, aim: 8, headTries: 20,
            candidates: 120, pick: 'mix', freeWeight: 1 },
  expert: { label: 'Expert', size: 9,  minLen: 4, maxLen: 16, bend: 0.7,  density: 0.95, aim: 8, headTries: 24,
            candidates: 70, pick: 'mix', freeWeight: 1 },
  master: { label: 'Master', size: 11, minLen: 4, maxLen: 14, bend: 0.75, density: 0.96, aim: 10, headTries: 32,
            candidates: 50, pick: 'mix', freeWeight: 1 },
};
export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'expert', 'master'];
export const PALETTE_SIZE = 8;

// ---------------------------------------------------------------- cube geometry
//
// Directions are numbered 0..5: +X, -X, +Y, -Y, +Z, -Z. A face is numbered by
// the direction its outside points, so face 4 is the +Z face. Positions use
// doubled coordinates: the cube spans 0..2N on each axis, cell centers sit at
// odd values on their face's other two axes, and midpoints between cells
// (including points on the cube's edges) are whole steps of 1.

export const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// In-face axes for each face, chosen so that U x V = the face's normal.
const FACE_UV = [[2, 4], [4, 2], [4, 0], [0, 4], [0, 2], [2, 0]];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

const cubes = new Map();

// Geometry for a cube with `size` cells along each side (cached).
export function getCube(size) {
  let c = cubes.get(size);
  if (c) return c;
  const N = size, NN = N * N, count = 6 * NN;
  const faces = AXES.map((n, f) => {
    const U = AXES[FACE_UV[f][0]], V = AXES[FACE_UV[f][1]];
    // Corner where u = v = 0, in doubled coordinates.
    const corner = add(add(add([N, N, N], n, N), U, -N), V, -N);
    return { n, U, V, corner, uDir: FACE_UV[f][0], vDir: FACE_UV[f][1] };
  });
  const pos = new Array(count);
  for (let f = 0; f < 6; f++) {
    const { corner, U, V } = faces[f];
    for (let v = 0; v < N; v++) for (let u = 0; u < N; u++) {
      pos[f * NN + v * N + u] = add(add(corner, U, 2 * u + 1), V, 2 * v + 1);
    }
  }
  const indexAt = (f, p) => {
    const { corner, U, V } = faces[f];
    const d = add(p, corner, -1);
    return f * NN + ((dot(d, V) - 1) / 2) * N + (dot(d, U) - 1) / 2;
  };
  // Directions that lie flat on each face.
  const tangents = faces.map((_, f) => [0, 1, 2, 3, 4, 5].filter((d) => (d >> 1) !== (f >> 1)));

  // One cell over in direction d. Off the edge of a face, the step wraps onto
  // the next face and the direction turns to point along that face.
  // Returns { cell, dir, wrap }.
  const step = (cell, d) => {
    const f = (cell / NN) | 0, p = pos[cell];
    const q = add(p, AXES[d], 2);
    const a = d >> 1;
    if (q[a] >= 1 && q[a] <= 2 * N - 1) return { cell: indexAt(f, q), dir: d, wrap: false };
    return { cell: indexAt(d, add(add(p, AXES[d]), AXES[f], -1)), dir: f ^ 1, wrap: true };
  };

  c = { size: N, count, faces, pos, tangents, step, faceOf: (cell) => (cell / NN) | 0 };
  cubes.set(size, c);
  return c;
}

// Direction (0..5) from cell a to the next cell b along an arrow.
export function stepDir(cube, a, b) {
  const fa = cube.faceOf(a), fb = cube.faceOf(b);
  if (fa !== fb) return fa ^ 1; // crossed an edge: now heading away from a's face
  const pa = cube.pos[a], pb = cube.pos[b];
  for (let k = 0; k < 3; k++) if (pa[k] !== pb[k]) return 2 * k + (pb[k] > pa[k] ? 0 : 1);
  return -1;
}

// Direction the head points.
export function headDirection(cube, cells) {
  return stepDir(cube, cells[cells.length - 2], cells[cells.length - 1]);
}

// Cells from just past the head to the edge of the head's face, in order.
export function exitPath(cube, cells) {
  const d = headDirection(cube, cells);
  const out = [];
  for (let r = cube.step(cells[cells.length - 1], d); !r.wrap; r = cube.step(r.cell, d)) out.push(r.cell);
  return out;
}

// Map of cell -> arrow id (-1 = empty).
export function buildGrid(cube, arrows) {
  const grid = new Int16Array(cube.count).fill(-1);
  for (const a of arrows) for (const c of a.cells) grid[c] = a.id;
  return grid;
}

// Walks the exit path. `steps` is how many empty cells the head can move
// before reaching the edge (free) or the first blocking arrow.
export function scanExit(grid, cube, cells) {
  const d = headDirection(cube, cells);
  let steps = 0;
  for (let r = cube.step(cells[cells.length - 1], d); !r.wrap; r = cube.step(r.cell, d)) {
    const v = grid[r.cell];
    if (v >= 0) return { free: false, steps, blocker: v };
    steps++;
  }
  return { free: true, steps, blocker: -1 };
}

// ---------------------------------------------------------------- random

// Small seeded random generator (mulberry32), so a seed always rebuilds the same board.
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---------------------------------------------------------------- generator

// Each level is built backwards. An arrow's head goes on a random empty cell,
// pointing in a direction whose path to the edge of its face is empty, and
// its body grows backwards from the head (over cube edges too) without
// touching filled cells or that exit path. Because every earlier arrow stays
// clear of this one's exit path, removing arrows in the reverse of placement
// order always works.

// Directions a head could point: the cell behind it and its whole exit path
// must be empty. Long exit paths are likely to be crossed by later arrows,
// which makes the board harder; `aim` sets how strongly they are preferred.
// Returned in weighted random order.
function headOptions(grid, cube, head, aim, rng) {
  const options = [];
  for (const d of cube.tangents[cube.faceOf(head)]) {
    const behind = cube.step(head, d ^ 1); // the cell behind the head fixes its direction
    if (grid[behind.cell] >= 0) continue;
    const path = [];
    let clear = true;
    for (let r = cube.step(head, d); !r.wrap; r = cube.step(r.cell, d)) {
      if (grid[r.cell] >= 0) { clear = false; break; }
      path.push(r.cell);
    }
    const len = path.length;
    if (clear) options.push({ behind, path, len, key: Math.pow(rng(), 1 / Math.pow(len + 1, aim)) });
  }
  return options.sort((a, b) => b.key - a.key);
}

function placeArrow(grid, cube, p, minLen, rng) {
  const { maxLen, bend, aim } = p;
  const empties = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] < 0) empties.push(i);
  if (!empties.length) return null;

  // Look at `headTries` random empty cells and keep the one with the longest
  // possible exit path (more chances for later arrows to block it).
  let head = -1, options = null, bestLen = -1;
  for (let t = 0; t < (p.headTries || 1); t++) {
    const i = empties[Math.floor(rng() * empties.length)];
    const opts = headOptions(grid, cube, i, aim, rng);
    const longest = opts.reduce((m, o) => Math.max(m, o.len), -1);
    if (head < 0 || longest > bestLen) { head = i; options = opts; bestLen = longest; }
  }

  for (const { behind, path } of options) {
    const used = new Set([head, behind.cell, ...path]);
    const target = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    const body = [head, behind.cell]; // head first while growing
    let cur = behind.cell, s = behind.dir; // walking direction, head -> tail
    while (body.length < target) {
      const f = cube.faceOf(cur);
      const turns = shuffle(cube.tangents[f].filter((d) => (d >> 1) !== (s >> 1)), rng);
      const order = rng() < bend ? turns.concat([s]) : [s].concat(turns);
      let moved = false;
      for (const d of order) {
        const r = cube.step(cur, d);
        if (grid[r.cell] >= 0 || used.has(r.cell)) continue;
        used.add(r.cell);
        body.push(r.cell);
        cur = r.cell; s = r.dir;
        moved = true;
        break;
      }
      if (!moved) break;
    }
    if (body.length < minLen) continue;
    return body.reverse(); // tail -> head
  }
  return null;
}

function buildCandidate(p, cube, rng) {
  const grid = new Int16Array(cube.count).fill(-1);
  const placed = [];
  const goal = Math.round(p.density * cube.count);
  let filled = 0, fails = 0;
  while (filled < goal && fails < 250) {
    // When the cube gets crowded, allow short arrows to fill the gaps.
    const minLen = fails > 60 ? 2 : p.minLen;
    const cells = placeArrow(grid, cube, p, minLen, rng);
    if (!cells) { fails++; continue; }
    const id = placed.length;
    for (const c of cells) grid[c] = id;
    placed.push(cells);
    filled += cells.length;
    fails = 0;
  }
  return { placed, filled };
}

// Color index per arrow, avoiding the colors of touching arrows where possible.
function assignColors(cellsList, cube, rng) {
  const grid = new Int16Array(cube.count).fill(-1);
  cellsList.forEach((cells, id) => { for (const c of cells) grid[c] = id; });
  const neighbors = cellsList.map(() => new Set());
  cellsList.forEach((cells, id) => {
    for (const c of cells) {
      for (const d of cube.tangents[cube.faceOf(c)]) {
        const o = grid[cube.step(c, d).cell];
        if (o >= 0 && o !== id) neighbors[id].add(o);
      }
    }
  });
  const colors = new Array(cellsList.length).fill(-1);
  const usage = new Array(PALETTE_SIZE).fill(0);
  const ids = shuffle(cellsList.map((_, i) => i), rng);
  for (const id of ids) {
    const taken = new Set();
    for (const n of neighbors[id]) if (colors[n] >= 0) taken.add(colors[n]);
    let best = 0, bestScore = Infinity;
    for (const c of shuffle(Array.from({ length: PALETTE_SIZE }, (_, i) => i), rng)) {
      const score = (taken.has(c) ? 1000 : 0) + usage[c];
      if (score < bestScore) { bestScore = score; best = c; }
    }
    colors[id] = best;
    usage[best]++;
  }
  return colors;
}

export function countFree(level) {
  const cube = getCube(level.size);
  const grid = buildGrid(cube, level.arrows);
  let n = 0;
  for (const a of level.arrows) if (scanExit(grid, cube, a.cells).free) n++;
  return n;
}

// How many rounds a solve takes if every free arrow is removed each round.
// More rounds means longer chains of arrows waiting on other arrows.
// Returns -1 if the board can't be cleared.
export function solveDepth(level) {
  const cube = getCube(level.size);
  const grid = buildGrid(cube, level.arrows);
  let left = level.arrows.map((a) => a.id);
  let rounds = 0;
  while (left.length) {
    const free = left.filter((id) => scanExit(grid, cube, level.arrows[id].cells).free);
    if (!free.length) return -1;
    for (const id of free) for (const c of level.arrows[id].cells) grid[c] = -1;
    const gone = new Set(free);
    left = left.filter((id) => !gone.has(id));
    rounds++;
  }
  return rounds;
}

export function generateLevel(difficulty = 'easy', seed = randomSeed()) {
  const p = DIFFICULTIES[difficulty];
  if (!p) throw new Error(`Unknown difficulty: ${difficulty}`);
  const cube = getCube(p.size);
  const rng = createRng(seed);
  // Score each candidate (higher is harder): fewer arrows free at the start,
  // and with pick: 'mix', more solving rounds too.
  const score = (arrows, filled) => {
    const lv = { size: p.size, arrows };
    const free = countFree(lv);
    const mix = p.pick === 'mix' ? solveDepth(lv) - p.freeWeight * free : 0;
    return [mix, -free, filled];
  };
  const beats = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best = null, bestScore = null;
  for (let c = 0; c < p.candidates; c++) {
    const cand = buildCandidate(p, cube, rng);
    const arrows = cand.placed.map((cells, id) => ({ id, cells, color: 0 }));
    const sc = score(arrows, cand.filled);
    if (!best || beats(sc, bestScore)) { best = arrows; bestScore = sc; }
  }
  const colors = assignColors(best.map((a) => a.cells), cube, rng);
  best.forEach((a, i) => { a.color = colors[i]; });
  return {
    difficulty,
    seed,
    size: p.size,
    arrows: best,
    solution: best.map((a) => a.id).reverse(), // reverse placement order
  };
}

// ---------------------------------------------------------------- checks

// Removing an arrow never blocks another one, so taking any free arrow, again
// and again, finds a solution whenever one exists. Returns the order, or null.
export function solve(level) {
  const cube = getCube(level.size);
  const grid = buildGrid(cube, level.arrows);
  const left = new Set(level.arrows.map((a) => a.id));
  const order = [];
  while (left.size) {
    let found = -1;
    for (const id of left) {
      if (scanExit(grid, cube, level.arrows[id].cells).free) { found = id; break; }
    }
    if (found < 0) return null;
    for (const c of level.arrows[found].cells) grid[c] = -1;
    left.delete(found);
    order.push(found);
  }
  return order;
}

// True if cells a and b touch (side by side, on one face or across an edge).
function adjacent(cube, a, b) {
  return cube.tangents[cube.faceOf(a)].some((d) => cube.step(a, d).cell === b);
}

// Structural checks. Returns a list of problems (empty = valid).
export function validateLevel(level) {
  const errs = [];
  const { size, arrows } = level;
  if (!Number.isInteger(size) || size < 2) return ['bad size'];
  const cube = getCube(size);
  const seen = new Map();
  arrows.forEach((a, i) => {
    if (a.id !== i) errs.push(`arrow ${i}: id ${a.id} does not match index`);
    if (!Array.isArray(a.cells) || a.cells.length < 2) { errs.push(`arrow ${i}: fewer than 2 cells`); return; }
    let ok = true;
    a.cells.forEach((c, k) => {
      if (!Number.isInteger(c) || c < 0 || c >= cube.count) { errs.push(`arrow ${i}: cell ${c} off the cube`); ok = false; return; }
      if (seen.has(c)) errs.push(`arrow ${i}: cell ${c} overlaps arrow ${seen.get(c)}`);
      seen.set(c, i);
      if (k > 0 && ok && !adjacent(cube, a.cells[k - 1], c)) errs.push(`arrow ${i}: cells ${k - 1} and ${k} not adjacent`);
    });
    if (!ok) return;
    const own = new Set(a.cells);
    for (const c of exitPath(cube, a.cells)) {
      if (own.has(c)) { errs.push(`arrow ${i}: exit path crosses its own body`); break; }
    }
    if (!Number.isInteger(a.color) || a.color < 0 || a.color >= PALETTE_SIZE) errs.push(`arrow ${i}: bad color`);
  });
  if (level.solution) {
    const ids = level.solution.slice().sort((p, q) => p - q);
    if (ids.length !== arrows.length || ids.some((v, i) => v !== i)) errs.push('solution is not a permutation of arrow ids');
  }
  return errs;
}

// ---------------------------------------------------------------- play state

export class Game {
  constructor(level, { hearts = 3, hints = 3 } = {}) {
    this.level = level;
    this.size = level.size;
    this.cube = getCube(level.size);
    this.grid = buildGrid(this.cube, level.arrows);
    this.alive = new Set(level.arrows.map((a) => a.id));
    this.maxHearts = hearts;
    this.hearts = hearts;
    this.hints = hints;
    this.hintsUsed = 0;
    this.mistakes = 0;
    this.moves = 0;
    this.status = 'playing'; // 'playing' | 'won' | 'lost'
  }

  get remaining() { return this.alive.size; }

  arrow(id) { return this.level.arrows[id]; }

  arrowAt(cell) {
    if (!(cell >= 0 && cell < this.cube.count)) return -1;
    return this.grid[cell];
  }

  check(id) { return scanExit(this.grid, this.cube, this.arrow(id).cells); }

  freeArrows() {
    const out = [];
    for (const id of this.alive) if (this.check(id).free) out.push(id);
    return out;
  }

  // Returns { type: 'exit', id, steps } or { type: 'bump', id, steps, blocker }, or null if ignored.
  tap(id) {
    if (this.status !== 'playing' || !this.alive.has(id)) return null;
    this.moves++;
    const r = this.check(id);
    if (r.free) {
      for (const c of this.arrow(id).cells) this.grid[c] = -1;
      this.alive.delete(id);
      if (!this.alive.size) this.status = 'won';
      return { type: 'exit', id, steps: r.steps };
    }
    this.hearts--;
    this.mistakes++;
    if (this.hearts <= 0) this.status = 'lost';
    return { type: 'bump', id, steps: r.steps, blocker: r.blocker };
  }

  // Spends a hint and returns an arrow that can exit now, or -1.
  hint(rng = Math.random) {
    if (this.status !== 'playing' || this.hints <= 0) return -1;
    const free = this.freeArrows();
    if (!free.length) return -1;
    this.hints--;
    this.hintsUsed++;
    return free[Math.floor(rng() * free.length)];
  }
}
