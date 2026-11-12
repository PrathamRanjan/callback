import { describe, expect, it } from "vitest";
import { Drift, GAZE_FILTER, OneEuro, Snapper, benchmark, crossValidate, fitRidge, gauss, headPoint, headShifted, nineDots, predict, rng, type Sample } from "../web/src/handsfree/math.js";
import { MAX_STEPS, afterWake, isStop, parseCommand, riskOf } from "../web/src/handsfree/words.js";

describe("hands-free maths (spec A2, A4)", () => {
  it("the One Euro filter smooths jitter on a still point but follows a fast move", () => {
    const f = new OneEuro(GAZE_FILTER.minCutoff, GAZE_FILTER.beta);
    const r = rng(1);
    let se = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      const v = f.filter(500 + gauss(r) * 30, i * 33);
      if (i > 30) { se += (v - 500) ** 2; n++; }
    }
    expect(Math.sqrt(se / n)).toBeLessThan(15); // raw noise is 30 px rms
    let moved = 0;
    for (let i = 300; i < 306; i++) moved = f.filter(1100, i * 33);
    expect(moved).toBeGreaterThan(1000); // within 0.2 s of a 600 px jump
  });

  it("ridge regression learns a gaze mapping and cross-validation reports its accuracy in pixels", () => {
    // Synthetic eyes: the features are a noisy linear view of the screen point, as a real iris offset roughly is.
    const r = rng(3);
    const dots = nineDots(1280, 800);
    const samples: Sample[] = dots.flatMap((d, i) => Array.from({ length: 20 }, () => ({ f: [d.x / 6400 + gauss(r) * 0.002, d.y / 8000 + gauss(r) * 0.002, 0, 0, 0.5, 0.5].map((v, k) => v + (k > 1 ? gauss(r) * 0.001 : 0)), target: d, dot: i })));
    const m = fitRidge(samples, 0.001, 2);
    const p = predict(m, [640 / 6400, 400 / 8000, 0, 0, 0.5, 0.5]);
    expect(Math.hypot(p.x - 640, p.y - 400)).toBeLessThan(40);
    const cv = crossValidate(samples, 0.001, 2);
    expect(cv.perDot).toHaveLength(9);
    expect(cv.meanPx).toBeGreaterThan(0);
    expect(cv.meanPx).toBeLessThan(150);
    expect(cv.worstPx).toBeGreaterThanOrEqual(cv.meanPx);
  });

  it("snapping holds a button through noise instead of flickering to its neighbour", () => {
    const a = { key: "a", rect: { left: 100, right: 200, top: 100, bottom: 144 } };
    const b = { key: "b", rect: { left: 210, right: 310, top: 100, bottom: 144 } };
    const s = new Snapper<string>();
    const r = rng(5);
    const picks: (string | null)[] = [];
    for (let i = 0; i < 60; i++) picks.push(s.step({ x: 180 + gauss(r) * 25, y: 122 + gauss(r) * 25 }, [a, b]));
    const settled = picks.slice(10);
    expect(settled.filter((k) => k === "a").length / settled.length).toBeGreaterThan(0.9);
    // Looking clearly at b takes over after a few frames.
    let k: string | null = null;
    for (let i = 0; i < 15; i++) k = s.step({ x: 290, y: 122 }, [a, b]);
    expect(k).toBe("b");
    // Looking far away from everything lets the choice lapse.
    for (let i = 0; i < 30; i++) k = s.step({ x: 900, y: 700 }, [a, b]);
    expect(k).toBeNull();
  });

  it("drift correction learns from real clicks and ignores a click far from the gaze", () => {
    const d = new Drift(0.5);
    for (let i = 0; i < 6; i++) d.observe({ x: 400, y: 300 }, { x: 440, y: 280 });
    expect(Math.round(d.apply({ x: 400, y: 300 }).x)).toBeGreaterThan(430);
    expect(d.observe({ x: 400, y: 300 }, { x: 1200, y: 700 })).toBe(false);
  });

  it("head mode starts at the centre and moves the pointer the way the head turns (mirrored camera)", () => {
    const ref = { x: 0.5, y: 0.5 };
    expect(headPoint(ref, ref, 1000, 800)).toEqual({ x: 500, y: 400 });
    expect(headPoint({ x: 0.48, y: 0.5 }, ref, 1000, 800).x).toBeGreaterThan(500);
    expect(headPoint({ x: 0.5, y: 0.53 }, ref, 1000, 800).y).toBeGreaterThan(400);
    expect(headShifted({ cx: 0.5, cy: 0.5, scale: 0.1 }, { cx: 0.5, cy: 0.5, scale: 0.1 })).toBe(false);
    expect(headShifted({ cx: 0.62, cy: 0.5, scale: 0.1 }, { cx: 0.5, cy: 0.5, scale: 0.1 })).toBe(true);
    expect(headShifted({ cx: 0.5, cy: 0.5, scale: 0.13 }, { cx: 0.5, cy: 0.5, scale: 0.1 })).toBe(true);
  });

  it("the simulated benchmark picks the right button almost always at modest noise and never guesses wildly", () => {
    const easy = benchmark({ noisePx: 40, trials: 200 });
    expect(easy.accuracy).toBeGreaterThan(0.95);
    expect(easy.wrongRate).toBe(0);
    const hard = benchmark({ noisePx: 120, trials: 200 });
    expect(hard.accuracy).toBeLessThan(easy.accuracy);
    // At heavy noise it mostly declines to press (no selection) rather than pressing the wrong button.
    expect(hard.wrongRate).toBeLessThan(0.1);
    expect(hard.none).toBeGreaterThan(hard.wrong);
  });
});

describe("hands-free words (spec A6)", () => {
  it("stop is caught in code in all four languages, alone or inside a sentence", () => {
    for (const s of ["stop", "Stop!", "please stop now", "रुको", "ruko", "band karo", "berhenti", "pare", "Parar agora"]) expect(isStop(s), s).toBe(true);
    for (const s of ["para baixo", "stopwatch", "abrir chamadas", "buka panggilan", "calls kholo"]) expect(isStop(s), s).toBe(false);
  });

  it("the wake word gates commands", () => {
    expect(afterWake("Callback open calls", "en")).toBe("open calls");
    expect(afterWake("callback", "en")).toBe("");
    expect(afterWake("open calls", "en")).toBeNull();
    expect(afterWake("कॉलबैक कॉल्स खोलो", "hi-IN")).toBe("कॉल्स खोलो");
  });

  it("commands parse per language, 'this one' presses the gaze target, and 'then' chains steps", () => {
    expect(parseCommand("this one", "en").steps).toEqual([{ kind: "press" }]);
    expect(parseCommand("yeh wala", "hi-IN").steps).toEqual([{ kind: "press" }]);
    expect(parseCommand("yang ini", "id-ID").steps).toEqual([{ kind: "press" }]);
    expect(parseCommand("esse aqui", "pt-BR").steps).toEqual([{ kind: "press" }]);
    expect(parseCommand("open calls", "en").steps).toEqual([{ kind: "go", to: "/calls" }]);
    expect(parseCommand("कॉल्स खोलो", "hi-IN").steps).toEqual([{ kind: "go", to: "/calls" }]);
    expect(parseCommand("buka pelanggan", "id-ID").steps).toEqual([{ kind: "go", to: "/customers" }]);
    expect(parseCommand("abrir aprovações", "pt-BR").steps).toEqual([{ kind: "go", to: "/approvals" }]);
    expect(parseCommand("open money then scroll down then this one", "en").steps).toEqual([{ kind: "go", to: "/money" }, { kind: "scroll", dir: "down" }, { kind: "press" }]);
    expect(parseCommand("sim", "pt-BR").steps).toEqual([{ kind: "confirm" }]);
    expect(parseCommand("batal", "id-ID").steps).toEqual([{ kind: "cancel" }]);
  });

  it("a question that mentions a page name goes to Ask, not to that page", () => {
    expect(parseCommand("who owes money this week", "en").steps).toEqual([{ kind: "ask", q: "who owes money this week" }]);
  });

  it("caps an utterance at 10 steps", () => {
    const r = parseCommand(Array.from({ length: 14 }, () => "next").join(" then "), "en");
    expect(r.steps).toHaveLength(MAX_STEPS);
    expect(r.dropped).toBe(4);
  });

  it("decides in code which presses need a confirm card", () => {
    expect(riskOf({ path: "/calls/abc/place", text: "Call now" })).toBe("call");
    expect(riskOf({ path: "/holds/h1/capture" })).toBe("payment");
    expect(riskOf({ path: "/holds/h1/void" })).toBe("payment");
    expect(riskOf({ path: "/c/tok/pay/o1" })).toBe("payment");
    expect(riskOf({ path: "/obligations/o1/cancel" })).toBe("cancel");
    expect(riskOf({ path: "/demo/reset" })).toBe("reset");
    expect(riskOf({ path: "/calls/abc/say" })).toBe("send");
    expect(riskOf({ text: "Refund $40.00" })).toBe("refund");
    expect(riskOf({ text: "Aprovar" })).toBe("approve");
    expect(riskOf({ text: "Hapus pelanggan" })).toBe("delete");
    expect(riskOf({ href: "https://www.sandbox.paypal.com/checkoutnow?token=X" })).toBe("handover");
    expect(riskOf({ href: "/calls", text: "Calls" })).toBeNull();
    expect(riskOf({ text: "Show filters" })).toBeNull();
    expect(riskOf({ risk: "none", text: "Stop hands-free" })).toBeNull();
  });
});
