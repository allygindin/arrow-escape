// Arrow Escape (cube): level generation, rules and solver.
// No DOM access in this file, so the test page can use it on its own.
//
// The board is the surface of a cube: 6 faces of size x size cells. Cells are
// numbered face * size² + v * size + u. An arrow can bend over the cube's
// edges onto other faces. Tapped, it slides the way its head points to the
// edge of the face its head is on, then flies off into space.
//
// A level is { difficulty, seed, size, arrows, solution, bridges }.
// Each arrow is { id, cells, both }: cells (cell numbers) run from the tail
// to the head. `id` is the arrow's index. A two-sided arrow (both: true) has
// a head at each end and can leave by either one: end 0 is the usual head
// (the last cell), end 1 is the first cell.
//
// Bridges are cube edges, each written [f, g] (the two faces it joins, f < g).
// An exit path that reaches a bridge carries on over it onto the next face,
// and over the next one too if that is also a bridge, until it reaches a
// plain edge.

export const DIFFICULTIES = {
  // size: cells along each face's side; minLen/maxLen: cells per arrow; bend:
  // chance of turning at each cell; density: share of cells to fill; aim:
  // preference for heads with long exit paths; headTries: empty cells compared
  // when choosing each head; candidates: boards generated, keeping the hardest
  // (fewest arrows free at the start, or with pick: 'mix', most solving
  // rounds minus freeWeight x arrows free at the start). bridgeChance: share
  // of levels with bridge edges; bridges: [fewest, most] bridges in such a level.
  // twoSidedChance: share of levels with two-sided arrows; twoSided: [fewest,
  // most] two-sided arrows in such a level.
  easy:   { label: 'Easy',   size: 4,  minLen: 3, maxLen: 8,  bend: 0.6,  density: 0.9,  aim: 3, candidates: 40 },
  medium: { label: 'Medium', size: 5,  minLen: 4, maxLen: 12, bend: 0.65, density: 0.92, aim: 5, headTries: 8,
            candidates: 100, pick: 'mix', freeWeight: 2, bridgeChance: 1 / 3, bridges: [1, 1], twoSidedChance: 0.5, twoSided: [1, 2] },
  hard:   { label: 'Hard',   size: 7,  minLen: 3, maxLen: 10, bend: 0.65, density: 0.95, aim: 8, headTries: 20,
            candidates: 120, pick: 'mix', freeWeight: 1, bridgeChance: 1 / 3, bridges: [1, 1], twoSidedChance: 0.5, twoSided: [1, 2] },
  expert: { label: 'Expert', size: 9,  minLen: 4, maxLen: 16, bend: 0.7,  density: 0.95, aim: 8, headTries: 24,
            candidates: 70, pick: 'mix', freeWeight: 1, bridgeChance: 1 / 3, bridges: [1, 2], twoSidedChance: 0.5, twoSided: [2, 4] },
  master: { label: 'Master', size: 11, minLen: 4, maxLen: 14, bend: 0.75, density: 0.96, aim: 10, headTries: 32,
            candidates: 50, pick: 'mix', freeWeight: 1, bridgeChance: 1 / 3, bridges: [1, 2], twoSidedChance: 0.5, twoSided: [2, 4] },
};
export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'expert', 'master'];

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

// ---------------------------------------------------------------- bridges

// Number for the cube edge between faces a and b.
export const edgeKey = (a, b) => (a < b ? a * 6 + b : b * 6 + a);

// The level's bridge edges as a Set of edge keys, or null if it has none.
export function bridgeSet(level) {
  const list = level.bridges;
  return list && list.length ? new Set(list.map(([a, b]) => edgeKey(a, b))) : null;
}

// One step along an exit path: the next cell, or null where the path leaves
// the cube (at a plain edge). Over a bridge it continues onto the next face.
// Stepping off face f in direction d lands on face d.
function exitStep(cube, cell, d, bridges) {
  const r = cube.step(cell, d);
  if (!r.wrap) return r;
  return bridges && bridges.has(edgeKey(cube.faceOf(cell), d)) ? r : null;
}

// Longest possible exit path. A path that keeps going straight passes at
// most 4 faces before coming back; levels never have a closed ring of 4
// bridges, but this cap keeps a bad level from looping forever.
const maxExit = (cube) => 4 * cube.size;

// The exit path from just past the head to the edge where the arrow leaves
// the cube, following bridges. Returns { cells, dirs, dir, face }: the cells in
// order, the direction of travel into each one, and the direction and face
// the arrow flies off in and from.
export function exitRoute(cube, cells, bridges = null) {
  let d = headDirection(cube, cells), cur = cells[cells.length - 1];
  const out = [], dirs = [];
  for (let n = 0; n < maxExit(cube); n++) {
    const r = exitStep(cube, cur, d, bridges);
    if (!r) break;
    out.push(r.cell); dirs.push(r.dir);
    cur = r.cell; d = r.dir;
  }
  return { cells: out, dirs, dir: d, face: cube.faceOf(cur) };
}

// Cells from just past the head to where the arrow leaves the cube, in order.
export function exitPath(cube, cells, bridges = null) {
  return exitRoute(cube, cells, bridges).cells;
}

// True if the exit path crosses a bridge.
export function usesBridge(cube, cells, bridges) {
  if (!bridges) return false;
  const hf = cube.faceOf(cells[cells.length - 1]);
  return exitPath(cube, cells, bridges).some((c) => cube.faceOf(c) !== hf);
}

// Problems with a list of bridges (empty = fine).
function bridgeProblems(bridges) {
  if (bridges === undefined) return [];
  if (!Array.isArray(bridges)) return ['bridges is not a list'];
  const errs = [], seen = new Set(), perAxis = [0, 0, 0];
  for (const e of bridges) {
    if (!Array.isArray(e) || e.length !== 2 || !e.every((f) => Number.isInteger(f) && f >= 0 && f < 6)) { errs.push(`bad bridge ${JSON.stringify(e)}`); continue; }
    const [a, b] = e;
    if (a >> 1 === b >> 1) { errs.push(`bridge ${a}-${b} does not join neighbouring faces`); continue; }
    const k = edgeKey(a, b);
    if (seen.has(k)) errs.push(`bridge ${a}-${b} listed twice`);
    seen.add(k);
    perAxis[3 - (a >> 1) - (b >> 1)]++; // the axis the edge runs along
  }
  // The 4 edges along one axis form a ring around the cube; with all 4 as
  // bridges an arrow could circle forever.
  if (perAxis.some((n) => n >= 4)) errs.push('bridges form a closed ring around the cube');
  return errs;
}

// Map of cell -> arrow id (-1 = empty).
export function buildGrid(cube, arrows) {
  const grid = new Int16Array(cube.count).fill(-1);
  for (const a of arrows) for (const c of a.cells) grid[c] = a.id;
  return grid;
}

// Walks the exit path. `steps` is how many empty cells the head can move
// before leaving the cube (free) or reaching the first blocking arrow.
export function scanExit(grid, cube, cells, bridges = null) {
  let d = headDirection(cube, cells), cur = cells[cells.length - 1];
  let steps = 0;
  for (let n = 0; n < maxExit(cube); n++) {
    const r = exitStep(cube, cur, d, bridges);
    if (!r) break;
    const v = grid[r.cell];
    if (v >= 0) return { free: false, steps, blocker: v };
    steps++;
    cur = r.cell; d = r.dir;
  }
  return { free: true, steps, blocker: -1 };
}

// ---------------------------------------------------------------- two-sided arrows

// The ends an arrow can leave by: [0], or [0, 1] for a two-sided arrow.
export const endsOf = (a) => (a.both ? [0, 1] : [0]);

// The arrow's cells ordered so the given end is the head.
export const endCells = (a, end) => (end === 1 && a.both ? a.cells.slice().reverse() : a.cells);

// True if the arrow can leave right now by some end.
function canLeave(grid, cube, a, bridges) {
  return endsOf(a).some((e) => scanExit(grid, cube, endCells(a, e), bridges).free);
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
// pointing in a direction whose exit path (over any bridges) is empty, and
// its body grows backwards from the head (over cube edges too) without
// touching filled cells or that exit path. Because every earlier arrow stays
// clear of this one's exit path, removing arrows in the reverse of placement
// order always works.

// Directions a head could point: the cell behind it and its whole exit path
// must be empty. Long exit paths are likely to be crossed by later arrows,
// which makes the board harder; `aim` sets how strongly they are preferred.
// Returned in weighted random order.
function headOptions(grid, cube, head, aim, rng, bridges) {
  const options = [];
  for (const d of cube.tangents[cube.faceOf(head)]) {
    const behind = cube.step(head, d ^ 1); // the cell behind the head fixes its direction
    if (grid[behind.cell] >= 0) continue;
    const path = [];
    let clear = true;
    let cur = head, s = d;
    for (let n = 0; n < maxExit(cube); n++) {
      const r = exitStep(cube, cur, s, bridges);
      if (!r) break;
      // A path over bridges can come round to the cell behind the head.
      if (grid[r.cell] >= 0 || r.cell === behind.cell) { clear = false; break; }
      path.push(r.cell);
      cur = r.cell; s = r.dir;
    }
    const len = path.length;
    if (clear) options.push({ behind, path, len, key: Math.pow(rng(), 1 / Math.pow(len + 1, aim)) });
  }
  return options.sort((a, b) => b.key - a.key);
}

function placeArrow(grid, cube, p, minLen, rng, bridges) {
  const { maxLen, bend, aim } = p;
  const empties = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] < 0) empties.push(i);
  if (!empties.length) return null;

  // Look at `headTries` random empty cells and keep the one with the longest
  // possible exit path (more chances for later arrows to block it).
  let head = -1, options = null, bestLen = -1;
  for (let t = 0; t < (p.headTries || 1); t++) {
    const i = empties[Math.floor(rng() * empties.length)];
    const opts = headOptions(grid, cube, i, aim, rng, bridges);
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

function buildCandidate(p, cube, rng, bridges) {
  const grid = new Int16Array(cube.count).fill(-1);
  const placed = [];
  const goal = Math.round(p.density * cube.count);
  let filled = 0, fails = 0;
  while (filled < goal && fails < 250) {
    // When the cube gets crowded, allow short arrows to fill the gaps.
    const minLen = fails > 60 ? 2 : p.minLen;
    const cells = placeArrow(grid, cube, p, minLen, rng, bridges);
    if (!cells) { fails++; continue; }
    const id = placed.length;
    for (const c of cells) grid[c] = id;
    placed.push(cells);
    filled += cells.length;
    fails = 0;
  }
  return { placed, filled };
}

// Turns some arrows of a finished board two-sided. Giving an arrow a second
// way out never stops the board being solvable: its usual head still leaves
// in the placement order. Only arrows of 4+ cells qualify (so each half is
// easy to tap), and only if the second end's exit path doesn't run into the
// arrow's own body. Arrows whose second end is blocked at the start come
// first, so picking the wrong end matters. Two-sided arrows never touch each
// other, so their matching colors don't run together.
function pickTwoSided(p, cube, arrows, bridges, rng) {
  if (!p.twoSidedChance || rng() >= p.twoSidedChance) return;
  const [lo, hi] = p.twoSided;
  const want = lo + Math.floor(rng() * (hi - lo + 1));
  const grid = buildGrid(cube, arrows);
  const blocked = [], open = [];
  for (const a of shuffle(arrows.slice(), rng)) {
    if (a.cells.length < 4) continue;
    const back = a.cells.slice().reverse();
    const own = new Set(a.cells);
    if (exitPath(cube, back, bridges).some((c) => own.has(c))) continue;
    (scanExit(grid, cube, back, bridges).free ? open : blocked).push(a);
  }
  const touches = (a, b) => a.cells.some((c) => cube.tangents[cube.faceOf(c)].some((d) => grid[cube.step(c, d).cell] === b.id));
  const chosen = [];
  for (const a of blocked.concat(open)) {
    if (chosen.length >= want) break;
    if (!chosen.some((b) => touches(a, b))) chosen.push(a);
  }
  for (const a of chosen) a.both = true;
}

// Arrows that can leave at the start (by either end, for two-sided ones).
export function countFree(level) {
  const cube = getCube(level.size);
  const grid = buildGrid(cube, level.arrows);
  const bridges = bridgeSet(level);
  let n = 0;
  for (const a of level.arrows) if (canLeave(grid, cube, a, bridges)) n++;
  return n;
}

// How many rounds a solve takes if every free arrow is removed each round.
// More rounds means longer chains of arrows waiting on other arrows.
// Returns -1 if the board can't be cleared.
export function solveDepth(level) {
  const cube = getCube(level.size);
  const grid = buildGrid(cube, level.arrows);
  const bridges = bridgeSet(level);
  let left = level.arrows.map((a) => a.id);
  let rounds = 0;
  while (left.length) {
    const free = left.filter((id) => canLeave(grid, cube, level.arrows[id], bridges));
    if (!free.length) return -1;
    for (const id of free) for (const c of level.arrows[id].cells) grid[c] = -1;
    const gone = new Set(free);
    left = left.filter((id) => !gone.has(id));
    rounds++;
  }
  return rounds;
}

// Random bridge edges for a level ([] for most levels). Each extra bridge
// half the time shares a face with an earlier one, so chains of bridges
// happen. Never all 4 edges of a ring (see bridgeProblems).
function pickBridges(p, rng) {
  if (!p.bridgeChance || rng() >= p.bridgeChance) return [];
  const [lo, hi] = p.bridges;
  const want = lo + Math.floor(rng() * (hi - lo + 1));
  const all = [];
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) if (a >> 1 !== b >> 1) all.push([a, b]);
  const out = [];
  while (out.length < want) {
    let pool = all.filter((e) => !out.includes(e) && !bridgeProblems([...out, e]).length);
    if (out.length && rng() < 0.5) {
      const near = pool.filter((e) => out.some((o) => o.includes(e[0]) || o.includes(e[1])));
      if (near.length) pool = near;
    }
    if (!pool.length) break;
    out.push(pool[Math.floor(rng() * pool.length)]);
  }
  return out.map((e) => e.slice()).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

export function generateLevel(difficulty = 'easy', seed = randomSeed()) {
  const p = DIFFICULTIES[difficulty];
  if (!p) throw new Error(`Unknown difficulty: ${difficulty}`);
  const cube = getCube(p.size);
  const rng = createRng(seed);
  // Bridges use their own random stream, so levels without bridges are the
  // same boards they were before bridges existed.
  const bridgeList = pickBridges(p, createRng(seed ^ 0x9E3779B9));
  const bridges = bridgeSet({ bridges: bridgeList });
  // Score each candidate (higher is harder): on levels with bridges, at least
  // one arrow that has to cross one; then fewer arrows free at the start, and
  // with pick: 'mix', more solving rounds too.
  const score = (arrows, filled) => {
    const lv = { size: p.size, arrows, bridges: bridgeList };
    const free = countFree(lv);
    const mix = p.pick === 'mix' ? solveDepth(lv) - p.freeWeight * free : 0;
    const crosses = bridges && arrows.some((a) => usesBridge(cube, a.cells, bridges)) ? 1 : 0;
    return [crosses, mix, -free, filled];
  };
  const beats = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best = null, bestScore = null;
  for (let c = 0; c < p.candidates; c++) {
    const cand = buildCandidate(p, cube, rng, bridges);
    const arrows = cand.placed.map((cells, id) => ({ id, cells, both: false }));
    const sc = score(arrows, cand.filled);
    if (!best || beats(sc, bestScore)) { best = arrows; bestScore = sc; }
  }
  // Two-sided arrows also use their own random stream.
  pickTwoSided(p, cube, best, bridges, createRng(seed ^ 0x51ED270B));
  return {
    difficulty,
    seed,
    size: p.size,
    arrows: best,
    solution: best.map((a) => a.id).reverse(), // reverse placement order
    bridges: bridgeList,
  };
}

// ---------------------------------------------------------------- checks

// Removing an arrow never blocks another one, so taking any free arrow, again
// and again, finds a solution whenever one exists. Returns the order, or null.
export function solve(level) {
  const cube = getCube(level.size);
  const grid = buildGrid(cube, level.arrows);
  const bridges = bridgeSet(level);
  const left = new Set(level.arrows.map((a) => a.id));
  const order = [];
  while (left.size) {
    let found = -1;
    for (const id of left) {
      if (canLeave(grid, cube, level.arrows[id], bridges)) { found = id; break; }
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
  errs.push(...bridgeProblems(level.bridges));
  const bridges = errs.length ? null : bridgeSet(level);
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
    if (a.both !== undefined && typeof a.both !== 'boolean') errs.push(`arrow ${i}: both is not true or false`);
    const own = new Set(a.cells);
    for (const e of endsOf(a)) {
      if (exitPath(cube, endCells(a, e), bridges).some((c) => own.has(c))) {
        errs.push(`arrow ${i}: exit path${e ? ' from its second end' : ''} crosses its own body`);
      }
    }
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
    this.bridges = bridgeSet(level);
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

  // The exit scan for one end of an arrow (0 = usual head, 1 = the other
  // end of a two-sided arrow; regular arrows always use end 0).
  check(id, end = 0) {
    const a = this.arrow(id);
    return scanExit(this.grid, this.cube, endCells(a, a.both ? end : 0), this.bridges);
  }

  // The ends this arrow can leave by right now ([] if it is stuck).
  freeEnds(id) {
    return endsOf(this.arrow(id)).filter((e) => this.check(id, e).free);
  }

  freeArrows() {
    const out = [];
    for (const id of this.alive) if (this.freeEnds(id).length) out.push(id);
    return out;
  }

  // Sends the arrow out by `end`. Returns { type: 'exit', id, end, steps } or
  // { type: 'bump', id, end, steps, blocker }, or null if ignored.
  tap(id, end = 0) {
    if (this.status !== 'playing' || !this.alive.has(id)) return null;
    if (!this.arrow(id).both) end = 0;
    this.moves++;
    const r = this.check(id, end);
    if (r.free) {
      for (const c of this.arrow(id).cells) this.grid[c] = -1;
      this.alive.delete(id);
      if (!this.alive.size) this.status = 'won';
      return { type: 'exit', id, end, steps: r.steps };
    }
    this.hearts--;
    this.mistakes++;
    if (this.hearts <= 0) this.status = 'lost';
    return { type: 'bump', id, end, steps: r.steps, blocker: r.blocker };
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
