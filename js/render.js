// Canvas drawing and animation. Reads the game state; never changes it.
import { exitPath, headDirection } from './logic.js';

export const PALETTE = ['#E4572E', '#F2A007', '#3FA34D', '#2B7DE9', '#8B5CF6', '#E0479E', '#0EA5B7', '#B5651D'];

const THEME = {
  light: { board: '#FFFFFF', edge: 'rgba(31,36,51,0.08)', dot: 'rgba(31,36,51,0.16)', hint: '#FFC21A', bump: '#E5484D' },
  dark:  { board: '#1E2129', edge: 'rgba(255,255,255,0.07)', dot: 'rgba(255,255,255,0.16)', hint: '#FFD43B', bump: '#FF6369' },
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeIn = (p) => p * p;
const easeOut = (p) => 1 - (1 - p) * (1 - p) * (1 - p);

function pointAt(path, s) {
  const i = Math.max(0, Math.min(path.length - 2, Math.floor(s)));
  const f = s - i, a = path[i], b = path[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// The drawn arrow is the stretch of its path from t (tail) to t + len (head),
// so as t grows the body follows its own cells like a snake.
function snake(path, t, len) {
  const end = t + len;
  const pts = [pointAt(path, t)];
  for (let k = Math.floor(t) + 1; k < end; k++) pts.push(path[k]);
  pts.push(pointAt(path, end));
  const j = Math.max(0, Math.min(path.length - 2, Math.ceil(end) - 1));
  return { pts, dir: [path[j + 1][0] - path[j][0], path[j + 1][1] - path[j][1]] };
}

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 ? clamp01(((px - a[0]) * vx + (py - a[1]) * vy) / l2) : 0;
  return Math.hypot(px - (a[0] + vx * t), py - (a[1] + vy * t));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = null;
    this.vis = new Map();
    this.hover = -1;
    this.hint = -1;
    this.hintStart = 0;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.cell = 0; this.fitCell = 0; this.ox = 0; this.oy = 0;
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
    this.vis.clear();
    this.hover = -1;
    this.hint = -1;
    for (const a of game.level.arrows) {
      const ray = exitPath(game.size, a.cells);
      const dir = headDirection(a.cells);
      // Path = body + exit path + a few cells past the edge to slide into.
      const path = a.cells.map((c) => [c[0], c[1]]).concat(ray);
      let [x, y] = path[path.length - 1];
      for (let i = 0; i < a.cells.length + 2; i++) { x += dir[0]; y += dir[1]; path.push([x, y]); }
      this.vis.set(a.id, {
        id: a.id, color: PALETTE[a.color % PALETTE.length], path, dir,
        len: a.cells.length - 1, rayLen: ray.length,
        t: 0, alpha: 1, flash: 0, shake: null, anim: null, gone: false,
      });
    }
    this.resetView();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (r.width === this.w && r.height === this.h && dpr === this.dpr && this.cell > 0) return;
    this.dpr = dpr;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.resetView();
  }

  // Fits the whole board on screen (zoom 1).
  layout() {
    if (!this.game) return;
    const pad = Math.max(16, Math.min(this.w, this.h) * 0.03);
    // The board's rounded backing extends 0.2 cells past the grid on each side.
    this.fitCell = Math.max(0, Math.min(this.w, this.h) - pad * 2) / (this.game.size + 0.4);
    this.cell = this.fitCell;
    const side = this.cell * this.game.size;
    this.ox = (this.w - side) / 2;
    this.oy = (this.h - side) / 2;
  }

  // ---------------------------------------------------------------- zoom

  get zoom() { return this.fitCell > 0 ? this.cell / this.fitCell : 1; }
  get maxZoom() { return Math.max(2, 110 / Math.max(1, this.fitCell)); }
  get zoomed() { return this.zoom > 1.001; }

  // Scales the board by `factor` around screen point (sx, sy), relative to the canvas.
  zoomAt(factor, sx, sy) {
    if (!this.game || this.fitCell <= 0) return;
    const next = Math.max(this.fitCell, Math.min(this.fitCell * this.maxZoom, this.cell * factor));
    const k = next / this.cell;
    this.ox = sx - (sx - this.ox) * k;
    this.oy = sy - (sy - this.oy) * k;
    this.cell = next;
    this.clampView();
    this.requestDraw();
    if (this.onView) this.onView();
  }

  zoomBy(factor) { this.zoomAt(factor, this.w / 2, this.h / 2); }

  panBy(dx, dy) {
    this.ox += dx; this.oy += dy;
    this.clampView();
    this.requestDraw();
  }

  resetView() {
    this.layout();
    this.requestDraw();
    if (this.onView) this.onView();
  }

  // Keeps the board on screen: a board smaller than the view stays centered;
  // a bigger one can't be dragged past its own edge.
  clampView() {
    const m = this.cell * 0.2, pad = 12;
    const side = this.cell * this.game.size;
    const fit = (o, view) => {
      if (side + 2 * m <= view) return (view - side) / 2;
      return Math.min(m + pad, Math.max(view - side - m - pad, o));
    };
    this.ox = fit(this.ox, this.w);
    this.oy = fit(this.oy, this.h);
  }

  isAnimating(id) {
    const v = this.vis.get(id);
    return !!(v && (v.anim || v.gone));
  }

  exit(id, done) {
    const v = this.vis.get(id);
    if (!v) return;
    const dist = v.rayLen + v.len + 1.5;
    v.anim = { kind: 'exit', start: performance.now(), dur: 180 + dist * 36, dist, done };
    if (this.hover === id) this.hover = -1;
    if (this.hint === id) this.hint = -1;
    this.requestDraw();
  }

  bump(id, steps, blocker, done) {
    const v = this.vis.get(id);
    if (!v) return;
    v.anim = { kind: 'bump', start: performance.now(), fwd: 110 + steps * 45, back: 300, dist: steps + 0.3, blocker, hit: false, done };
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

  // Board cell coordinates of a screen point, or the arrow under it (-1 if none).
  // Taps near an arrow's line count, not just taps inside its cells.
  hitTest(clientX, clientY) {
    if (!this.game || this.cell <= 0) return -1;
    const r = this.canvas.getBoundingClientRect();
    const ux = (clientX - r.left - this.ox) / this.cell - 0.5;
    const uy = (clientY - r.top - this.oy) / this.cell - 0.5;
    const direct = this.game.arrowAt(Math.round(ux), Math.round(uy));
    if (direct >= 0) return this.isAnimating(direct) ? -1 : direct;
    let best = -1, bestD = 0.75;
    for (const id of this.game.alive) {
      if (this.isAnimating(id)) continue;
      const v = this.vis.get(id);
      const pts = v.path.slice(0, v.len + 1);
      const h = pts[pts.length - 1];
      pts.push([h[0] + v.dir[0] * 0.4, h[1] + v.dir[1] * 0.4]);
      for (let i = 1; i < pts.length; i++) {
        const d = distToSegment(ux, uy, pts[i - 1], pts[i]);
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    return best;
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
    const { ctx, cell, ox, oy } = this;
    const th = this.theme;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.game || cell <= 0) return;

    const size = this.game.size, side = cell * size, m = cell * 0.2;
    roundRect(ctx, ox - m, oy - m, side + 2 * m, side + 2 * m, cell * 0.32);
    ctx.fillStyle = th.board;
    ctx.fill();
    ctx.strokeStyle = th.edge;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = th.dot;
    const r = Math.max(1.5, cell * 0.045);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        ctx.beginPath();
        ctx.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Arrows slide off the board's edge, so clip to it.
    ctx.save();
    roundRect(ctx, ox - m, oy - m, side + 2 * m, side + 2 * m, cell * 0.32);
    ctx.clip();

    const hv = this.hover >= 0 ? this.vis.get(this.hover) : null;
    if (hv && !hv.anim && !hv.gone) this.drawPreview(hv);

    const moving = [];
    for (const v of this.vis.values()) {
      if (v.gone) continue;
      if (v.anim) moving.push(v); else this.drawArrow(v, th, now);
    }
    for (const v of moving) this.drawArrow(v, th, now); // moving arrows on top
    ctx.restore();
  }

  // Faint dashed line from the head to the edge (Pencil hover).
  drawPreview(v) {
    if (!v.rayLen) return;
    const { ctx, cell } = this;
    const h = v.path[v.len];
    const X = (x) => this.ox + (x + 0.5) * cell, Y = (y) => this.oy + (y + 0.5) * cell;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = v.color;
    ctx.lineWidth = Math.max(2, cell * 0.08);
    ctx.lineCap = 'round';
    ctx.setLineDash([cell * 0.1, cell * 0.18]);
    ctx.beginPath();
    ctx.moveTo(X(h[0] + v.dir[0] * 0.6), Y(h[1] + v.dir[1] * 0.6));
    ctx.lineTo(X(h[0] + v.dir[0] * (v.rayLen + 0.5)), Y(h[1] + v.dir[1] * (v.rayLen + 0.5)));
    ctx.stroke();
    ctx.restore();
  }

  drawArrow(v, th, now) {
    const { ctx, cell } = this;
    const { pts, dir } = snake(v.path, v.t, v.len);
    let sx = 0, sy = 0;
    if (v.shake) {
      const e = now - v.shake.start;
      const k = Math.sin(e / 22) * (1 - e / 320) * 0.08 * cell;
      sx = v.shake.dir[0] * k; sy = v.shake.dir[1] * k;
    }
    const X = (p) => this.ox + (p[0] + 0.5) * cell + sx;
    const Y = (p) => this.oy + (p[1] + 0.5) * cell + sy;
    const h = pts[pts.length - 1];
    const [dx, dy] = dir, px = -dy, py = dx;
    const tip = [h[0] + dx * 0.36, h[1] + dy * 0.36];

    const line = (withTip) => {
      ctx.beginPath();
      ctx.moveTo(X(pts[0]), Y(pts[0]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i]), Y(pts[i]));
      if (withTip) ctx.lineTo(X(tip), Y(tip));
    };
    const left = [h[0] - dx * 0.1 + px * 0.27, h[1] - dy * 0.1 + py * 0.27];
    const right = [h[0] - dx * 0.1 - px * 0.27, h[1] - dy * 0.1 - py * 0.27];
    const head = () => {
      ctx.beginPath();
      ctx.moveTo(X(tip), Y(tip));
      ctx.lineTo(X(left), Y(left));
      ctx.lineTo(X(right), Y(right));
      ctx.closePath();
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (v.id === this.hint) {
      const pulse = 0.5 + 0.5 * Math.sin((now - this.hintStart) / 170);
      ctx.globalAlpha = v.alpha * (0.4 + 0.45 * pulse);
      ctx.strokeStyle = th.hint;
      ctx.lineWidth = cell * (0.62 + 0.12 * pulse);
      line(true);
      ctx.stroke();
    } else if (v.id === this.hover && !v.anim) {
      ctx.globalAlpha = v.alpha * 0.25;
      ctx.strokeStyle = v.color;
      ctx.lineWidth = cell * 0.62;
      line(true);
      ctx.stroke();
    }

    ctx.globalAlpha = v.alpha;
    ctx.strokeStyle = v.color;
    ctx.fillStyle = v.color;
    ctx.lineWidth = cell * 0.28;
    line(false);
    ctx.stroke();
    head();
    ctx.fill();
    ctx.lineWidth = cell * 0.06;
    ctx.stroke();

    if (v.flash > 0) {
      ctx.globalAlpha = v.alpha * v.flash * 0.85;
      ctx.strokeStyle = th.bump;
      ctx.fillStyle = th.bump;
      ctx.lineWidth = cell * 0.28;
      line(false);
      ctx.stroke();
      head();
      ctx.fill();
    }

    // Tail cap, a touch darker so the two ends read differently.
    ctx.globalAlpha = v.alpha * 0.35;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(X(pts[0]), Y(pts[0]), cell * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
