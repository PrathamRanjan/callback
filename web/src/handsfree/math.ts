/**
 * The numbers behind hands-free "Look and Say" (spec A). Plain functions with no browser or React imports, so the unit
 * tests and the simulated benchmark run the same code the page does.
 *
 *  - OneEuro: a speed-adaptive low-pass filter. Still eyes get heavy smoothing (no jitter); fast moves get light
 *    smoothing (no lag). Casiez, Roussel and Vogel, CHI 2012.
 *  - fitRidge / predict: maps eye-and-head features to a screen point, learned from the 9-dot calibration.
 *  - crossValidate: leave one dot out, fit on the rest, measure how far the held-out dot lands. That is the accuracy
 *    in pixels we show the person, measured rather than assumed.
 *  - Snapper: turns a noisy gaze point into "which button", by votes that decay each frame, with hysteresis.
 *  - Drift: when the person clicks with a real mouse while gaze is on, the gap between where we thought they looked
 *    and where they clicked nudges a running correction.
 */

export interface Pt { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }

/* ---------------------------------------------------------------- One Euro filter */

class LowPass {
  private y: number | null = null;
  filter(x: number, a: number) {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
  last() { return this.y; }
  reset() { this.y = null; }
}
const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private t: number | null = null;
  constructor(private minCutoff = 1.0, private beta = 0.007, private dCutoff = 1.0) {}
  filter(v: number, tMs: number): number {
    const dt = this.t === null ? 1 / 30 : Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const prev = this.x.last();
    const d = prev === null ? 0 : (v - prev) / dt;
    const ed = this.dx.filter(d, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    return this.x.filter(v, alpha(cutoff, dt));
  }
  reset() { this.x.reset(); this.dx.reset(); this.t = null; }
}

/** Tuned in pixels: halves 30 px jitter (rms 30 → 10) for one or two frames of lag on a jump. */
export const GAZE_FILTER = { minCutoff: 0.6, beta: 0.002 };

export class OneEuro2 {
  private fx: OneEuro;
  private fy: OneEuro;
  constructor(minCutoff = 1.0, beta = 0.007) {
    this.fx = new OneEuro(minCutoff, beta);
    this.fy = new OneEuro(minCutoff, beta);
  }
  filter(p: Pt, tMs: number): Pt { return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs) }; }
  reset() { this.fx.reset(); this.fy.reset(); }
}

/* ---------------------------------------------------------------- ridge regression */

/** Adds a bias term and the squares of the first `quad` features: a little curvature for the edges of the screen. */
export function expand(f: number[], quad = 4): number[] {
  const out = [1, ...f];
  for (let i = 0; i < Math.min(quad, f.length); i++) out.push(f[i] * f[i]);
  return out;
}

/** Solves A x = b by Gaussian elimination with partial pivoting. A is n×n. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export interface Model { wx: number[]; wy: number[]; mean: number[]; scale: number[]; quad: number }
export interface Sample { f: number[]; target: Pt; dot?: number }

/** Ridge regression on standardised features. `lambda` keeps it from overfitting a few dots. */
export function fitRidge(samples: Sample[], lambda = 0.01, quad = 4): Model {
  if (!samples.length) throw new Error("No calibration samples");
  const k = samples[0].f.length;
  const mean = Array.from({ length: k }, (_, i) => samples.reduce((s, x) => s + x.f[i], 0) / samples.length);
  const scale = Array.from({ length: k }, (_, i) => Math.sqrt(samples.reduce((s, x) => s + (x.f[i] - mean[i]) ** 2, 0) / samples.length) || 1);
  const X = samples.map((s) => expand(s.f.map((v, i) => (v - mean[i]) / scale[i]), quad));
  const n = X[0].length;
  const XtX = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j && i > 0 ? lambda * samples.length : 0)));
  const Xty = (key: "x" | "y") => Array.from({ length: n }, (_, i) => X.reduce((s, r, m) => s + r[i] * samples[m].target[key], 0));
  return { wx: solve(XtX, Xty("x")), wy: solve(XtX, Xty("y")), mean, scale, quad };
}

export function predict(m: Model, f: number[]): Pt {
  const x = expand(f.map((v, i) => (v - m.mean[i]) / m.scale[i]), m.quad);
  return { x: x.reduce((s, v, i) => s + v * m.wx[i], 0), y: x.reduce((s, v, i) => s + v * m.wy[i], 0) };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Leave-one-dot-out: for each calibration dot, fit on the other dots and measure the held-out dot's error (the mean
 * of its samples' predictions against the dot). Returns the mean and the worst dot, in pixels.
 */
export function crossValidate(samples: Sample[], lambda = 0.01, quad = 4): { meanPx: number; worstPx: number; perDot: number[] } {
  const dots = [...new Set(samples.map((s) => s.dot ?? -1))];
  if (dots.length < 3) return { meanPx: NaN, worstPx: NaN, perDot: [] };
  const perDot = dots.map((d) => {
    const train = samples.filter((s) => s.dot !== d);
    const test = samples.filter((s) => s.dot === d);
    const m = fitRidge(train, lambda, quad);
    const ps = test.map((s) => predict(m, s.f));
    const c = { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
    return dist(c, test[0].target);
  });
  return { meanPx: perDot.reduce((s, v) => s + v, 0) / perDot.length, worstPx: Math.max(...perDot), perDot };
}

/** The nine calibration dots, 8% in from each edge. The 3-dot top-up uses the centre and two corners. */
export function nineDots(w: number, h: number): Pt[] {
  const xs = [0.08, 0.5, 0.92], ys = [0.1, 0.5, 0.9];
  return ys.flatMap((y) => xs.map((x) => ({ x: Math.round(x * w), y: Math.round(y * h) })));
}
export const TOPUP = [4, 0, 8];

/* ---------------------------------------------------------------- snapping to targets */

/** Distance from a point to a rectangle's edge (0 inside). */
export function rectDist(p: Pt, r: Rect): number {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}

export interface SnapOpts { radius: number; decay: number; enter: number; switchRatio: number }
export const SNAP: SnapOpts = { radius: 120, decay: 0.82, enter: 2.2, switchRatio: 1.35 };

/**
 * Votes, not nearest-wins: each frame every target's vote decays and the target nearest the gaze point (within
 * `radius`) gains one. A target is chosen once its vote passes `enter`, and a rival takes over only when it beats the
 * current one by `switchRatio`. Noise that flickers between two buttons therefore doesn't flicker the highlight.
 */
export class Snapper<K> {
  private votes = new Map<K, number>();
  current: K | null = null;
  constructor(private o: SnapOpts = SNAP) {}
  step(p: Pt | null, targets: { key: K; rect: Rect }[]): K | null {
    for (const [k, v] of this.votes) {
      const nv = v * this.o.decay;
      if (nv < 0.05) this.votes.delete(k);
      else this.votes.set(k, nv);
    }
    if (p) {
      let best: K | null = null, bd = Infinity;
      for (const t of targets) {
        const d = rectDist(p, t.rect);
        if (d < bd) { bd = d; best = t.key; }
      }
      if (best !== null && bd <= this.o.radius) this.votes.set(best, (this.votes.get(best) ?? 0) + 1);
    }
    const live = new Set(targets.map((t) => t.key));
    if (this.current !== null && !live.has(this.current)) this.current = null;
    let top: K | null = null, tv = 0;
    for (const [k, v] of this.votes) if (live.has(k) && v > tv) { tv = v; top = k; }
    const cv = this.current === null ? 0 : this.votes.get(this.current) ?? 0;
    if (this.current === null) {
      if (top !== null && tv >= this.o.enter) this.current = top;
    } else if (top !== null && top !== this.current && tv >= this.o.enter && tv > cv * this.o.switchRatio) {
      this.current = top;
    } else if (cv < 0.3) {
      this.current = null;
    }
    return this.current;
  }
  vote(k: K) { return this.votes.get(k) ?? 0; }
  reset() { this.votes.clear(); this.current = null; }
}

/* ---------------------------------------------------------------- drift correction */

/** A running offset learned from real clicks: where they clicked minus where we predicted. Ignores far-off clicks. */
export class Drift {
  off: Pt = { x: 0, y: 0 };
  n = 0;
  constructor(private rate = 0.3, private maxPx = 260) {}
  observe(predicted: Pt, clicked: Pt): boolean {
    const d = { x: clicked.x - (predicted.x + this.off.x), y: clicked.y - (predicted.y + this.off.y) };
    if (Math.hypot(d.x, d.y) > this.maxPx) return false;
    this.off = { x: this.off.x + this.rate * d.x, y: this.off.y + this.rate * d.y };
    this.n++;
    return true;
  }
  apply(p: Pt): Pt { return { x: p.x + this.off.x, y: p.y + this.off.y }; }
  reset() { this.off = { x: 0, y: 0 }; this.n = 0; }
}

/* ---------------------------------------------------------------- head mode */

/** Head mode: the nose moves the pointer, relative to where it was when head mode started. No calibration. */
export function headPoint(nose: Pt, ref: Pt, w: number, h: number, gain = 9): Pt {
  // The camera image is mirrored for the person, so moving the head right moves the nose left in the image.
  const x = w / 2 - (nose.x - ref.x) * w * gain * 0.5;
  const y = h / 2 + (nose.y - ref.y) * h * gain * 0.6;
  return { x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y)) };
}

/** Has the head moved far from where it was during calibration? Then the fit no longer holds. */
export function headShifted(now: { cx: number; cy: number; scale: number }, ref: { cx: number; cy: number; scale: number }): boolean {
  return Math.hypot(now.cx - ref.cx, now.cy - ref.cy) > 0.08 || Math.abs(now.scale / ref.scale - 1) > 0.18;
}

/* ---------------------------------------------------------------- simulated gaze (demo and benchmark) */

/** A seeded random source, so the benchmark gives the same numbers on every run. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(r: () => number) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * The simulated benchmark: a person "looks" at a random target among 48 buttons (6 × 8, 120 × 44 px, on 1280 × 800); the gaze point has Gaussian
 * noise of `noisePx` and a fixed bias of `biasPx`. Frames run at 30 per second through the One Euro filter and the
 * Snapper; a selection counts when the dwell (in frames) completes. Measures how often the right button is chosen.
 * Synthetic: this tests the snapping and dwell code, not a camera or a person's eyes.
 */
export function benchmark(o: { noisePx: number; biasPx?: number; trials?: number; seed?: number; dwellFrames?: number; cols?: number; rows?: number; w?: number; h?: number; btn?: { w: number; h: number } }) {
  const r = rng(o.seed ?? 7);
  const W = o.w ?? 1280, H = o.h ?? 800, cols = o.cols ?? 6, rows = o.rows ?? 8, bw = o.btn?.w ?? 120, bh = o.btn?.h ?? 44;
  const targets = Array.from({ length: cols * rows }, (_, i) => {
    const cx = ((i % cols) + 0.5) * (W / cols), cy = (Math.floor(i / cols) + 0.5) * (H / rows);
    return { key: i, rect: { left: cx - bw / 2, right: cx + bw / 2, top: cy - bh / 2, bottom: cy + bh / 2 }, c: { x: cx, y: cy } };
  });
  const trials = o.trials ?? 200, dwell = o.dwellFrames ?? 30;
  let right = 0, wrong = 0, none = 0, frames = 0;
  for (let k = 0; k < trials; k++) {
    const goal = targets[Math.floor(r() * targets.length)];
    const snap = new Snapper<number>();
    const f = new OneEuro2(GAZE_FILTER.minCutoff, GAZE_FILTER.beta);
    const bias = { x: (o.biasPx ?? 0) * Math.cos(k), y: (o.biasPx ?? 0) * Math.sin(k) };
    let held: number | null = null, count = 0, chosen: number | null = null, n = 0;
    for (; n < 150 && chosen === null; n++) {
      const raw = { x: goal.c.x + bias.x + gauss(r) * o.noisePx, y: goal.c.y + bias.y + gauss(r) * o.noisePx };
      const cur = snap.step(f.filter(raw, n * 33.3), targets);
      if (cur !== null && cur === held) count++;
      else { held = cur; count = cur === null ? 0 : 1; }
      if (held !== null && count >= dwell) chosen = held;
    }
    frames += n;
    if (chosen === null) none++;
    else if (chosen === goal.key) right++;
    else wrong++;
  }
  return { trials, right, wrong, none, accuracy: right / trials, wrongRate: wrong / trials, meanSeconds: frames / trials / 30 };
}
