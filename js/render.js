// Canvas drawing and animation for the cube. Reads the game state; never changes it.
//
// The cube is drawn with a straight-on (orthographic) camera, so each face
// maps onto the screen with a flat 2D transform. Every visible face is drawn
// by setting that transform and clipping to the face, then drawing the parts
// of each arrow that lie on it, in the face's own cell coordinates.
import { AXES, exitPath, getCube, headDirection } from './logic.js';

export const PALETTE = ['#E4572E', '#F2A007', '#3FA34D', '#2B7DE9', '#8B5CF6', '#E0479E', '#0EA5B7', '#B5651D'];

const THEME = {
  light: { board: '#FFFFFF', edge: 'rgba(31,36,51,0.22)', dot: 'rgba(31,36,51,0.16)', hint: '#FFC21A', bump: '#E5484D', shade: '20,24,36' },
  dark:  { board: '#2A2E39', edge: 'rgba(255,255,255,0.16)', dot: 'rgba(255,255,255,0.18)', hint: '#FFD43B', bump: '#FF6369', shade: '0,0,0' },
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeIn = (p) => p * p;
const easeOut = (p) => 1 - (1 - p) * (1 - p) * (1 - p);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const SPACE = 6; // owner id 6 + f: a segment flying off into space, in face f's plane

// ---------------------------------------------------------------- rotation (3x3, row-major)

const mul = (a, b) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
};
const apply = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
// Rotation by `angle` around the unit axis (x, y, z).
function axisAngle(x, y, z, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}
// Keeps the matrix a pure rotation as small rounding errors build up.
function orthonormalize(m) {
  const n = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const x = n([m[0], m[1], m[2]]);
  let y = [m[3], m[4], m[5]];
  const k = dot(x, y);
  y = n([y[0] - k * x[0], y[1] - k * x[1], y[2] - k * x[2]]);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [...x, ...y, ...z];
}
// Starting view: three faces showing, top and two sides.
const START = mul(axisAngle(1, 0, 0, 0.5), axisAngle(0, 1, 0, -0.62));

// ---------------------------------------------------------------- paths

function pointAt(path, s) {
  const i = Math.max(0, Math.min(path.length - 2, Math.floor(s)));
  const f = s - i, a = path[i], b = path[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// The drawn arrow is the stretch of its path from t (tail) to t + len (head),
// so as t grows the body follows its own path like a snake. Path points are
// half a cell apart. Returns the points, the owner of each segment between
// them, and the segment the head is on.
function snake(v, t) {
  const { path, owner } = v;
  const end = t + v.len;
  const pts = [pointAt(path, t)], own = [];
  const first = Math.max(0, Math.min(path.length - 2, Math.floor(t)));
  for (let k = Math.floor(t) + 1; k < end; k++) pts.push(path[k]);
  pts.push(pointAt(path, end));
  for (let i = 0; i < pts.length - 1; i++) own.push(owner[Math.min(owner.length - 1, first + i)]);
  const j = Math.max(0, Math.min(path.length - 2, Math.ceil(end) - 1));
  return { pts, own, headSeg: j };
}

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 ? clamp01(((px - a[0]) * vx + (py - a[1]) * vy) / l2) : 0;
  return Math.hypot(px - (a[0] + vx * t), py - (a[1] + vy * t));
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = null;
    this.cube = null;
    this.vis = new Map();
    this.hover = -1;
    this.hint = -1;
    this.hintStart = 0;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.rot = START.slice();
    this.scale = 0; this.fitScale = 0; // screen pixels per cell, seen face-on
    this.cx = 0; this.cy = 0;           // where the cube's center is on screen
    this.onView = null; // called when the zoom level changes
    this.raf = 0;
    this.darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (this.darkQuery && this.darkQuery.addEventListener) {
      this.darkQuery.addEventListener('change', () => this.requestDraw());
    }
  }

  get theme() { return this.darkQuery && this.darkQuery.matches ? THEME.dark : THEME.light; }

  setGame(game) {
    this.game = game;
    const cube = this.cube = getCube(game.size);
    const N2 = 2 * game.size;
    this.vis.clear();
    this.hover = -1;
    this.hint = -1;

    // Faces a point (doubled coordinates) lies on: one for a point inside a
    // face, two on a cube edge, none out in space.
    const facesOf = (p) => {
      const out = [];
      for (let k = 0; k < 3; k++) {
        if (p[k] < 0 || p[k] > N2) return [];
        if (p[k] === N2) out.push(2 * k); else if (p[k] === 0) out.push(2 * k + 1);
      }
      return out;
    };
    // The point between neighbouring cells a and b: on a cube edge if they
    // are on different faces.
    const between = (a, b) => {
      const pa = cube.pos[a], pb = cube.pos[b], fb = cube.faceOf(b);
      if (cube.faceOf(a) === fb) return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      return add(pa, AXES[fb]);
    };

    for (const a of game.level.arrows) {
      const d = headDirection(cube, a.cells);
      const head = a.cells[a.cells.length - 1], hf = cube.faceOf(head);
      const ray = exitPath(cube, a.cells);
      // Path = body + exit path to the face's edge + a stretch out into space.
      const path = [cube.pos[a.cells[0]]];
      for (let i = 1; i < a.cells.length; i++) path.push(between(a.cells[i - 1], a.cells[i]), cube.pos[a.cells[i]]);
      let last = head;
      for (const c of ray) { path.push(between(last, c), cube.pos[c]); last = c; }
      let p = cube.pos[last];
      for (let i = 0; i < 2 * a.cells.length + 6; i++) { p = add(p, AXES[d]); path.push(p); }

      const owner = [];
      for (let i = 1; i < path.length; i++) {
        const fa = facesOf(path[i - 1]), fb = facesOf(path[i]);
        const common = fa.find((f) => fb.includes(f));
        owner.push(common !== undefined ? common : SPACE + hf);
      }
      this.vis.set(a.id, {
        id: a.id, color: PALETTE[a.color % PALETTE.length], path, owner, dir: d, headFace: hf,
        len: 2 * (a.cells.length - 1), rayLen: ray.length,
        t: 0, alpha: 1, flash: 0, shake: null, anim: null, gone: false,
      });
    }
    this.resetView();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (r.width === this.w && r.height === this.h && dpr === this.dpr && this.scale > 0) return;
    this.dpr = dpr;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.resetView();
  }

  // Fits the whole cube on screen (zoom 1) at any angle: seen corner-on, a
  // cube is √3 times as wide as one side.
  layout() {
    if (!this.game) return;
    const pad = Math.max(16, Math.min(this.w, this.h) * 0.03);
    this.fitScale = Math.max(0, Math.min(this.w, this.h) - pad * 2) / (this.game.size * 1.68);
    this.scale = this.fitScale;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
  }

  // ---------------------------------------------------------------- view

  get zoom() { return this.fitScale > 0 ? this.scale / this.fitScale : 1; }
  get maxZoom() { return Math.max(2, 110 / Math.max(1, this.fitScale)); }
  get zoomed() { return this.zoom > 1.001; }

  // Scales the cube by `factor` around screen point (sx, sy), relative to the canvas.
  zoomAt(factor, sx, sy) {
    if (!this.game || this.fitScale <= 0) return;
    const next = Math.max(this.fitScale, Math.min(this.fitScale * this.maxZoom, this.scale * factor));
    const k = next / this.scale;
    this.cx = sx - (sx - this.cx) * k;
    this.cy = sy - (sy - this.cy) * k;
    this.scale = next;
    this.clampView();
    this.requestDraw();
    if (this.onView) this.onView();
  }

  zoomBy(factor) { this.zoomAt(factor, this.w / 2, this.h / 2); }

  panBy(dx, dy) {
    this.cx += dx; this.cy += dy;
    this.clampView();
    this.requestDraw();
  }

  // Spins the cube as if dragged by (dx, dy) screen pixels.
  rotateBy(dx, dy) {
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const angle = len * 3.2 / Math.max(200, Math.min(this.w, this.h));
    // Screen y points down, the cube's view y points up.
    this.rot = orthonormalize(mul(axisAngle(dy / len, dx / len, 0, angle), this.rot));
    this.requestDraw();
  }

  // Turns the cube around the line of sight (two-finger twist).
  rollBy(angle) {
    if (!angle) return;
    this.rot = orthonormalize(mul(axisAngle(0, 0, 1, -angle), this.rot));
    this.requestDraw();
  }

  resetView() {
    this.layout();
    this.requestDraw();
    if (this.onView) this.onView();
  }

  // When zoomed out the cube stays centered; zoomed in, its center can't be
  // dragged off screen.
  clampView() {
    if (!this.zoomed) { this.cx = this.w / 2; this.cy = this.h / 2; return; }
    this.cx = Math.max(0, Math.min(this.w, this.cx));
    this.cy = Math.max(0, Math.min(this.h, this.cy));
  }

  // ---------------------------------------------------------------- faces

  // For each face: whether it faces the camera, how much, and the 2D
  // transform from its cell coordinates (u, v) to screen pixels.
  faceViews() {
    const N = this.game.size, s = this.scale, R = this.rot;
    return this.cube.faces.map((f) => {
      const n = apply(R, f.n), U = apply(R, f.U), V = apply(R, f.V);
      // Face corner relative to the cube center, in cells.
      const K = apply(R, [(f.corner[0] - N) / 2, (f.corner[1] - N) / 2, (f.corner[2] - N) / 2]);
      return {
        facing: n[2],
        m: [s * U[0], -s * U[1], s * V[0], -s * V[1], this.cx + s * K[0], this.cy - s * K[1]],
      };
    });
  }

  // A 3D point (doubled coordinates) in face f's cell coordinates.
  local(f, p) {
    const F = this.cube.faces[f];
    const d = [p[0] - F.corner[0], p[1] - F.corner[1], p[2] - F.corner[2]];
    return [dot(d, F.U) / 2, dot(d, F.V) / 2];
  }

  // A 3D direction in face f's cell coordinates.
  localDir(f, d) {
    const F = this.cube.faces[f];
    return [dot(d, F.U), dot(d, F.V)];
  }

  isAnimating(id) {
    const v = this.vis.get(id);
    return !!(v && (v.anim || v.gone));
  }

  exit(id, done) {
    const v = this.vis.get(id);
    if (!v) return;
    const dist = 2 * v.rayLen + 1 + v.len + 3; // half-cells until the tail is off the cube
    v.anim = { kind: 'exit', start: performance.now(), dur: 180 + dist * 18, dist, done };
    if (this.hover === id) this.hover = -1;
    if (this.hint === id) this.hint = -1;
    this.requestDraw();
  }

  bump(id, steps, blocker, done) {
    const v = this.vis.get(id);
    if (!v) return;
    v.anim = { kind: 'bump', start: performance.now(), fwd: 110 + steps * 45, back: 300, dist: 2 * steps + 0.6, blocker, hit: false, done };
    this.requestDraw();
  }

  setHover(id) {
    if (id !== this.hover) { this.hover = id; this.requestDraw(); }
  }

  setHint(id) {
    this.hint = id;
    this.hintStart = performance.now();
    this.requestDraw();
  }

  // The arrow under a screen point (-1 if none). Taps near an arrow's line
  // count, not just taps inside its cells.
  hitTest(clientX, clientY) {
    if (!this.game || this.scale <= 0) return -1;
    const r = this.canvas.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    const N = this.game.size;
    const views = this.faceViews();
    for (let f = 0; f < 6; f++) {
      const { facing, m } = views[f];
      if (facing <= 0.02) continue;
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det) continue;
      const x = sx - m[4], y = sy - m[5];
      const u = (m[3] * x - m[2] * y) / det, v = (m[0] * y - m[1] * x) / det;
      if (u < 0 || v < 0 || u > N || v > N) continue;

      const direct = this.game.arrowAt(f * N * N + Math.floor(v) * N + Math.floor(u));
      if (direct >= 0) return this.isAnimating(direct) ? -1 : direct;
      let best = -1, bestD = 0.75;
      for (const id of this.game.alive) {
        if (this.isAnimating(id)) continue;
        const a = this.vis.get(id);
        for (let i = 0; i < a.len; i++) {
          if (a.owner[i] !== f) continue;
          const d = distToSegment(u, v, this.local(f, a.path[i]), this.local(f, a.path[i + 1]));
          if (d < bestD) { bestD = d; best = id; }
        }
      }
      return best;
    }
    return -1;
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.frame(performance.now())) this.requestDraw();
    });
  }

  frame(now) {
    let busy = false;
    const done = [];
    for (const v of this.vis.values()) {
      if (v.shake) {
        if (now - v.shake.start > 320) v.shake = null; else busy = true;
      }
      const a = v.anim;
      if (!a) continue;
      busy = true;
      const e = now - a.start;
      if (a.kind === 'exit') {
        const p = clamp01(e / a.dur);
        v.t = a.dist * easeIn(p);
        v.alpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
        if (p >= 1) { v.anim = null; v.gone = true; done.push(a.done); }
      } else if (e < a.fwd) {
        v.t = a.dist * easeIn(clamp01(e / a.fwd));
      } else {
        if (!a.hit) {
          a.hit = true;
          const b = this.vis.get(a.blocker);
          if (b) b.shake = { start: now, dir: v.dir };
        }
        const p = clamp01((e - a.fwd) / a.back);
        v.t = a.dist * (1 - easeOut(p));
        v.flash = 1 - p;
        if (p >= 1) { v.anim = null; v.t = 0; v.flash = 0; done.push(a.done); }
      }
    }
    if (this.hint >= 0) busy = true;
    this.draw(now);
    for (const fn of done) if (fn) fn();
    return busy;
  }

  draw(now) {
    const { ctx } = this;
    const th = this.theme;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.game || this.scale <= 0) return;

    const N = this.game.size;
    const views = this.faceViews();
    const shown = views.map((v) => v.facing > 0.002);
    const snakes = [];
    for (const v of this.vis.values()) if (!v.gone) snakes.push({ v, s: snake(v, v.t) });
    // Moving arrows on top.
    snakes.sort((a, b) => (a.v.anim ? 1 : 0) - (b.v.anim ? 1 : 0));

    const setFace = (f) => {
      const m = views[f].m, d = this.dpr;
      ctx.setTransform(d * m[0], d * m[1], d * m[2], d * m[3], d * m[4], d * m[5]);
    };

    for (let f = 0; f < 6; f++) {
      if (!shown[f]) continue;
      ctx.save();
      setFace(f);
      ctx.beginPath();
      ctx.rect(0, 0, N, N);
      ctx.fillStyle = th.board;
      ctx.fill();
      ctx.clip();

      ctx.fillStyle = th.dot;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        ctx.beginPath();
        ctx.arc(x + 0.5, y + 0.5, 0.045, 0, Math.PI * 2);
        ctx.fill();
      }

      const hv = this.hover >= 0 ? this.vis.get(this.hover) : null;
      if (hv && !hv.anim && !hv.gone && hv.headFace === f) this.drawPreview(hv);
      for (const { v, s } of snakes) this.drawArrow(v, s, f, f, th, now);

      // Faces turned away from the light are a little darker.
      const k = 0.2 * (1 - views[f].facing);
      ctx.fillStyle = `rgba(${th.shade},${k.toFixed(3)})`;
      ctx.fillRect(0, 0, N, N);
      ctx.restore();

      // Cube edge.
      ctx.save();
      setFace(f);
      ctx.strokeStyle = th.edge;
      ctx.lineWidth = 1.2 / this.scale;
      ctx.strokeRect(0, 0, N, N);
      ctx.restore();
    }

    // Arrows flying off into space, drawn in their head face's plane and
    // clipped to the far side of the edge they left from.
    for (const { v, s } of snakes) {
      if (!v.anim || v.anim.kind !== 'exit') continue;
      const f = v.headFace;
      if (!shown[f] && !shown[v.dir]) continue;
      const [dx, dy] = this.localDir(f, AXES[v.dir]);
      ctx.save();
      setFace(f);
      ctx.beginPath();
      const B = 1000;
      if (dx > 0) ctx.rect(N, -B, B, 2 * B);
      else if (dx < 0) ctx.rect(-B, -B, B, 2 * B);
      else if (dy > 0) ctx.rect(-B, N, 2 * B, B);
      else ctx.rect(-B, -B, 2 * B, B);
      ctx.clip();
      this.drawArrow(v, s, SPACE + f, f, th, now);
      ctx.restore();
    }
  }

  // Faint dashed line from the head to the edge (Pencil hover). Drawn in the
  // head face's coordinates.
  drawPreview(v) {
    if (!v.rayLen) return;
    const { ctx } = this;
    const f = v.headFace;
    const h = this.local(f, v.path[v.len]);
    const [dx, dy] = this.localDir(f, AXES[v.dir]);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = v.color;
    ctx.lineWidth = 0.08;
    ctx.lineCap = 'round';
    ctx.setLineDash([0.1, 0.18]);
    ctx.beginPath();
    ctx.moveTo(h[0] + dx * 0.6, h[1] + dy * 0.6);
    ctx.lineTo(h[0] + dx * (v.rayLen + 0.5), h[1] + dy * (v.rayLen + 0.5));
    ctx.stroke();
    ctx.restore();
  }

  // Draws the parts of arrow v owned by `own` (a face, or SPACE + face),
  // in face f's coordinates. The context is already set up for that face.
  drawArrow(v, s, own, f, th, now) {
    const { ctx } = this;
    const { pts, own: owners, headSeg } = s;

    // Runs of consecutive segments that lie on this face.
    const runs = [];
    let run = null;
    for (let i = 0; i < owners.length; i++) {
      if (owners[i] !== own) { run = null; continue; }
      if (!run) { run = [this.local(f, pts[i])]; runs.push(run); }
      run.push(this.local(f, pts[i + 1]));
    }
    const headHere = v.owner[headSeg] === own;
    if (!runs.length && !headHere) return;

    let sx = 0, sy = 0;
    if (v.shake) {
      const e = now - v.shake.start;
      const k = Math.sin(e / 22) * (1 - e / 320) * 0.08;
      const [ux, uy] = this.localDir(f, AXES[v.shake.dir]);
      sx = ux * k; sy = uy * k;
    }

    // The head: pointing along the segment it's on.
    let tip = null, left = null, right = null;
    if (headHere) {
      const h = this.local(f, pts[pts.length - 1]);
      const a = this.local(f, v.path[headSeg]), b = this.local(f, v.path[headSeg + 1]);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const dx = (b[0] - a[0]) / l, dy = (b[1] - a[1]) / l, px = -dy, py = dx;
      tip = [h[0] + dx * 0.36, h[1] + dy * 0.36];
      left = [h[0] - dx * 0.1 + px * 0.27, h[1] - dy * 0.1 + py * 0.27];
      right = [h[0] - dx * 0.1 - px * 0.27, h[1] - dy * 0.1 - py * 0.27];
    }

    const line = (withTip) => {
      ctx.beginPath();
      for (const r of runs) {
        ctx.moveTo(r[0][0] + sx, r[0][1] + sy);
        for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0] + sx, r[i][1] + sy);
      }
      if (withTip && tip) {
        const h = runs.length ? runs[runs.length - 1][runs[runs.length - 1].length - 1] : null;
        if (h) ctx.lineTo(tip[0] + sx, tip[1] + sy);
      }
    };
    const head = () => {
      ctx.beginPath();
      ctx.moveTo(tip[0] + sx, tip[1] + sy);
      ctx.lineTo(left[0] + sx, left[1] + sy);
      ctx.lineTo(right[0] + sx, right[1] + sy);
      ctx.closePath();
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (v.id === this.hint) {
      const pulse = 0.5 + 0.5 * Math.sin((now - this.hintStart) / 170);
      ctx.globalAlpha = v.alpha * (0.4 + 0.45 * pulse);
      ctx.strokeStyle = th.hint;
      ctx.lineWidth = 0.62 + 0.12 * pulse;
      line(true);
      ctx.stroke();
    } else if (v.id === this.hover && !v.anim) {
      ctx.globalAlpha = v.alpha * 0.25;
      ctx.strokeStyle = v.color;
      ctx.lineWidth = 0.62;
      line(true);
      ctx.stroke();
    }

    ctx.globalAlpha = v.alpha;
    ctx.strokeStyle = v.color;
    ctx.fillStyle = v.color;
    ctx.lineWidth = 0.28;
    line(false);
    ctx.stroke();
    if (tip) {
      head();
      ctx.fill();
      ctx.lineWidth = 0.06;
      ctx.stroke();
    }

    if (v.flash > 0) {
      ctx.globalAlpha = v.alpha * v.flash * 0.85;
      ctx.strokeStyle = th.bump;
      ctx.fillStyle = th.bump;
      ctx.lineWidth = 0.28;
      line(false);
      ctx.stroke();
      if (tip) { head(); ctx.fill(); }
    }

    // Tail cap, a touch darker so the two ends read differently.
    if (owners[0] === own) {
      const t = this.local(f, pts[0]);
      ctx.globalAlpha = v.alpha * 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(t[0] + sx, t[1] + sy, 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
