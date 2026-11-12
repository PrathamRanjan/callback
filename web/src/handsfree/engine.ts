/**
 * The camera side of hands-free (spec A1). MediaPipe Face Landmarker runs in this browser tab on WebAssembly; each
 * camera frame is read into it and dropped. Only numbers leave this file (eye and head features, blink scores): no
 * frame, image or landmark list is stored or sent anywhere. There is no network code here; the only downloads are
 * the runtime (from Callback's own server) and the face model file (from Google's MediaPipe model storage), once.
 */
import type { Pt } from "./math";

export const MEDIAPIPE_VERSION = "1.2.0";
const WASM_BASE = `/mediapipe/${MEDIAPIPE_VERSION}`;
export const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface Frame {
  t: number;
  face: boolean;
  /** Gaze features: mean iris offset in each eye (x, y), head yaw and pitch, face centre (x, y). */
  f?: number[];
  nose?: Pt;
  head?: { cx: number; cy: number; scale: number };
  blinkL: number;
  blinkR: number;
  yawDeg: number;
}

type L = { x: number; y: number; z?: number };
const sub = (a: L, b: L) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;

/** Where the iris sits inside one eye, along the eye's own axis and across it, in eye widths. */
function eye(lm: L[], inner: number, outer: number, iris: number): Pt {
  const a = lm[inner], b = lm[outer], c = lm[iris];
  const axis = sub(b, a);
  const w = Math.hypot(axis.x, axis.y) || 1e-6;
  const u = { x: axis.x / w, y: axis.y / w };
  const v = { x: -u.y, y: u.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const d = sub(c, mid);
  return { x: dot(d, u) / w, y: dot(d, v) / w };
}

/** Exported for the unit tests: turns one face's landmarks (+ optional pose matrix) into features. */
export function featuresOf(lm: L[], matrix?: number[]): { f: number[]; nose: Pt; head: { cx: number; cy: number; scale: number }; yawDeg: number } {
  // MediaPipe's 478-point mesh: right eye 133 inner / 33 outer / 468 iris; left eye 362 inner / 263 outer / 473 iris.
  const r = eye(lm, 133, 33, 468);
  const l = eye(lm, 362, 263, 473);
  // The right eye's axis points the other way across the face; flip it so both eyes move the same way.
  const mx = (l.x - r.x) / 2, my = (l.y + r.y) / 2;
  let yaw = 0, pitch = 0;
  if (matrix && matrix.length >= 16) {
    // Column-major 4×4. Rotation part R: R20 = m[2], R21 = m[6], R22 = m[10].
    yaw = Math.atan2(-matrix[2], Math.hypot(matrix[6], matrix[10]));
    pitch = Math.atan2(matrix[6], matrix[10]);
  } else {
    const eyesMid = { x: (lm[33].x + lm[263].x) / 2, y: (lm[33].y + lm[263].y) / 2 };
    const iod = Math.hypot(lm[263].x - lm[33].x, lm[263].y - lm[33].y) || 1e-6;
    yaw = (lm[1].x - eyesMid.x) / iod;
    pitch = (lm[1].y - eyesMid.y) / iod;
  }
  const cx = (lm[33].x + lm[263].x) / 2, cy = (lm[33].y + lm[263].y) / 2;
  const scale = Math.hypot(lm[263].x - lm[33].x, lm[263].y - lm[33].y);
  return { f: [mx, my, yaw, pitch, cx, cy], nose: { x: lm[1].x, y: lm[1].y }, head: { cx, cy, scale }, yawDeg: (yaw * 180) / Math.PI };
}

export interface Camera { stop(): void; video: HTMLVideoElement }

export class HandsFreeError extends Error {
  constructor(message: string, readonly why: "no-camera" | "denied" | "offline" | "model" | "unsupported") {
    super(message);
  }
}

/** Starts the camera and the face model; calls onFrame about 30 times a second until stop(). */
export async function startCamera(onFrame: (f: Frame) => void): Promise<Camera> {
  if (!navigator.mediaDevices?.getUserMedia) throw new HandsFreeError("This browser can't use a camera here.", "unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new HandsFreeError("Camera permission was refused.", "denied");
    throw new HandsFreeError("No camera was found.", "no-camera");
  }
  const stopStream = () => stream.getTracks().forEach((t) => t.stop());
  let landmarker: { detectForVideo(v: HTMLVideoElement, t: number): any; close(): void };
  try {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(WASM_BASE);
    const make = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
    landmarker = await make("GPU").catch(() => make("CPU"));
  } catch (e) {
    stopStream();
    if (!navigator.onLine) throw new HandsFreeError("You're offline, and the face model isn't loaded yet.", "offline");
    throw new HandsFreeError(`The face model didn't load (${(e as Error).message || "unknown error"}).`, "model");
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.setAttribute("aria-hidden", "true");
  await video.play();
  let on = true;
  let last = -1;
  const tick = () => {
    if (!on) return;
    const now = performance.now();
    if (video.readyState >= 2 && video.currentTime !== last) {
      last = video.currentTime;
      try {
        const r = landmarker.detectForVideo(video, now);
        const lm = r.faceLandmarks?.[0] as L[] | undefined;
        const bs = (r.faceBlendshapes?.[0]?.categories ?? []) as { categoryName: string; score: number }[];
        const score = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
        if (lm && lm.length >= 478) {
          const m = r.facialTransformationMatrixes?.[0]?.data as number[] | undefined;
          const x = featuresOf(lm, m);
          onFrame({ t: now, face: true, f: x.f, nose: x.nose, head: x.head, blinkL: score("eyeBlinkLeft"), blinkR: score("eyeBlinkRight"), yawDeg: x.yawDeg });
        } else onFrame({ t: now, face: false, blinkL: 0, blinkR: 0, yawDeg: 0 });
      } catch {
        onFrame({ t: now, face: false, blinkL: 0, blinkR: 0, yawDeg: 0 });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    video,
    stop() {
      on = false;
      stopStream();
      video.srcObject = null;
      try {
        landmarker.close();
      } catch {
        /* already closed */
      }
    },
  };
}
