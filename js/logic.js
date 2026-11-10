// Arrow Escape: level generation, rules and solver.
// No DOM access in this file, so the test page can use it on its own.
//
// A level is { difficulty, seed, size, arrows, solution }.
// Each arrow is { id, cells, color }: cells run from the tail to the head, and
// the head points away from the cell before it. `id` is the arrow's index.

export const DIFFICULTIES = {
  // size: grid width; minLen/maxLen: cells per arrow; bend: chance of turning
  // at each cell; density: share of cells to fill; aim: preference for heads
  // with long exit paths; candidates: boards generated, keeping the one with
  // the fewest arrows free at the start.
  easy:   { label: 'Easy',   size: 6,  minLen: 2, maxLen: 4, bend: 0.2, density: 0.72, aim: 0.5, candidates: 1 },
  medium: { label: 'Medium', size: 8,  minLen: 2, maxLen: 6, bend: 0.4, density: 0.82, aim: 1.5, candidates: 8 },
  hard:   { label: 'Hard',   size: 10, minLen: 3, maxLen: 8, bend: 0.6, density: 0.9,  aim: 3,   candidates: 40 },
};
export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];
export const PALETTE_SIZE = 8;

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

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

const inside = (size, x, y) => x >= 0 && y >= 0 && x < size && y < size;

export function headDirection(cells) {
  const h = cells[cells.length - 1], p = cells[cells.length - 2];
  return [h[0] - p[0], h[1] - p[1]];
}

// Cells from just past the head to the board edge, in order.
export function exitPath(size, cells) {
  const [dx, dy] = headDirection(cells);
  const out = [];
  let [x, y] = cells[cells.length - 1];
  for (x += dx, y += dy; inside(size, x, y); x += dx, y += dy) out.push([x, y]);
  return out;
}

// Grid of arrow ids (-1 = empty).
export function buildGrid(size, arrows) {
  const grid = new Int16Array(size * size).fill(-1);
  for (const a of arrows) for (const [x, y] of a.cells) grid[y * size + x] = a.id;
  return grid;
}

// Walks the exit path. `steps` is how many empty cells the head can move
// before reaching the edge (free) or the first blocking arrow.
export function scanExit(grid, size, cells) {
  const [dx, dy] = headDirection(cells);
  let [x, y] = cells[cells.length - 1];
  let steps = 0;
  for (x += dx, y += dy; inside(size, x, y); x += dx, y += dy) {
    const v = grid[y * size + x];
    if (v >= 0) return { free: false, steps, blocker: v };
    steps++;
  }
  return { free: true, steps, blocker: -1 };
}

// ---------------------------------------------------------------- generator

// Tries to add one arrow. Its head goes on a random empty cell, pointing in a
// direction whose straight path to the edge is empty, and its body grows
// backwards from the head without touching filled cells or that exit path.
// Because every earlier arrow stays clear of this one's exit path, removing
// arrows in the reverse of placement order always works.
function placeArrow(grid, size, minLen, maxLen, bend, aim, rng) {
  const empties = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] < 0) empties.push(i);
  if (!empties.length) return null;
  const hi = empties[Math.floor(rng() * empties.length)];
  const hx = hi % size, hy = (hi / size) | 0;

  // Directions whose cell behind the head and whole exit path are empty.
  const options = [];
  for (const [dx, dy] of DIRS) {
    const bx = hx - dx, by = hy - dy; // the cell behind the head fixes its direction
    if (!inside(size, bx, by) || grid[by * size + bx] >= 0) continue;
    let len = 0, clear = true;
    for (let x = hx + dx, y = hy + dy; inside(size, x, y); x += dx, y += dy, len++) {
      if (grid[y * size + x] >= 0) { clear = false; break; }
    }
    // Long exit paths are likely to be crossed by later arrows, which makes the
    // board harder. `aim` sets how strongly they are preferred.
    if (clear) options.push({ dx, dy, bx, by, key: Math.pow(rng(), 1 / Math.pow(len + 1, aim)) });
  }
  options.sort((a, b) => b.key - a.key); // weighted random order

  for (const { dx, dy, bx, by } of options) {
    const used = new Set([hi, by * size + bx]);
    for (let x = hx + dx, y = hy + dy; inside(size, x, y); x += dx, y += dy) used.add(y * size + x);

    const target = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    const body = [[hx, hy], [bx, by]]; // head first while growing
    let sx = -dx, sy = -dy;            // walking direction, head -> tail
    let cx = bx, cy = by;
    while (body.length < target) {
      const turns = shuffle([[sy, -sx], [-sy, sx]], rng);
      const order = rng() < bend ? turns.concat([[sx, sy]]) : [[sx, sy]].concat(turns);
      let moved = false;
      for (const [ex, ey] of order) {
        const nx = cx + ex, ny = cy + ey, ni = ny * size + nx;
        if (!inside(size, nx, ny) || grid[ni] >= 0 || used.has(ni)) continue;
        used.add(ni);
        body.push([nx, ny]);
        cx = nx; cy = ny; sx = ex; sy = ey;
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

function buildCandidate(p, rng) {
  const { size } = p;
  const grid = new Int16Array(size * size).fill(-1);
  const placed = [];
  const goal = Math.round(p.density * size * size);
  let filled = 0, fails = 0;
  while (filled < goal && fails < 250) {
    // When the board gets crowded, allow short arrows to fill the gaps.
    const minLen = fails > 60 ? 2 : p.minLen;
    const cells = placeArrow(grid, size, minLen, p.maxLen, p.bend, p.aim, rng);
    if (!cells) { fails++; continue; }
    const id = placed.length;
    for (const [x, y] of cells) grid[y * size + x] = id;
    placed.push(cells);
    filled += cells.length;
    fails = 0;
  }
  return { placed, filled };
}

// Color index per arrow, avoiding the colors of touching arrows where possible.
function assignColors(cellsList, size, rng) {
  const grid = new Int16Array(size * size).fill(-1);
  cellsList.forEach((cells, id) => { for (const [x, y] of cells) grid[y * size + x] = id; });
  const neighbors = cellsList.map(() => new Set());
  cellsList.forEach((cells, id) => {
    for (const [x, y] of cells) {
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inside(size, nx, ny)) continue;
        const o = grid[ny * size + nx];
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
  const grid = buildGrid(level.size, level.arrows);
  let n = 0;
  for (const a of level.arrows) if (scanExit(grid, level.size, a.cells).free) n++;
  return n;
}

export function generateLevel(difficulty = 'easy', seed = randomSeed()) {
  const p = DIFFICULTIES[difficulty];
  if (!p) throw new Error(`Unknown difficulty: ${difficulty}`);
  const rng = createRng(seed);
  let best = null, bestFree = Infinity, bestFilled = -1;
  for (let c = 0; c < p.candidates; c++) {
    const cand = buildCandidate(p, rng);
    const arrows = cand.placed.map((cells, id) => ({ id, cells, color: 0 }));
    const free = countFree({ size: p.size, arrows });
    if (free < bestFree || (free === bestFree && cand.filled > bestFilled)) {
      best = arrows; bestFree = free; bestFilled = cand.filled;
    }
  }
  const colors = assignColors(best.map((a) => a.cells), p.size, rng);
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
  const grid = buildGrid(level.size, level.arrows);
  const left = new Set(level.arrows.map((a) => a.id));
  const order = [];
  while (left.size) {
    let found = -1;
    for (const id of left) {
      if (scanExit(grid, level.size, level.arrows[id].cells).free) { found = id; break; }
    }
    if (found < 0) return null;
    for (const [x, y] of level.arrows[found].cells) grid[y * level.size + x] = -1;
    left.delete(found);
    order.push(found);
  }
  return order;
}

// Structural checks. Returns a list of problems (empty = valid).
export function validateLevel(level) {
  const errs = [];
  const { size, arrows } = level;
  if (!Number.isInteger(size) || size < 2) return ['bad size'];
  const seen = new Map();
  arrows.forEach((a, i) => {
    if (a.id !== i) errs.push(`arrow ${i}: id ${a.id} does not match index`);
    if (!Array.isArray(a.cells) || a.cells.length < 2) { errs.push(`arrow ${i}: fewer than 2 cells`); return; }
    a.cells.forEach(([x, y], k) => {
      if (!inside(size, x, y)) errs.push(`arrow ${i}: cell ${x},${y} off board`);
      const key = y * size + x;
      if (seen.has(key)) errs.push(`arrow ${i}: cell ${x},${y} overlaps arrow ${seen.get(key)}`);
      seen.set(key, i);
      if (k > 0) {
        const [px, py] = a.cells[k - 1];
        if (Math.abs(px - x) + Math.abs(py - y) !== 1) errs.push(`arrow ${i}: cells ${k - 1} and ${k} not adjacent`);
      }
    });
    const own = new Set(a.cells.map(([x, y]) => y * size + x));
    for (const [x, y] of exitPath(size, a.cells)) {
      if (own.has(y * size + x)) { errs.push(`arrow ${i}: exit path crosses its own body`); break; }
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
    this.grid = buildGrid(level.size, level.arrows);
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

  arrowAt(x, y) {
    if (!inside(this.size, x, y)) return -1;
    return this.grid[y * this.size + x];
  }

  check(id) { return scanExit(this.grid, this.size, this.arrow(id).cells); }

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
      for (const [x, y] of this.arrow(id).cells) this.grid[y * this.size + x] = -1;
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
