import { useEffect, useRef, useState } from "react";
import { postJson } from "./api";

/**
 * Talk in the browser (spec B2 item 1): WebRTC straight to GPT-Live (gpt-live-1). The browser sends its offer to
 * this app, which creates the session with the OpenAI key (never sent to the browser), attaches its own sideband
 * connection and returns the answer. Every turn that needs the account goes from GPT-Live to the server, through
 * the same brain, gate and PayPal calls as a typed turn; the browser only carries the audio.
 */
export function useLiveVoice(callId: string, onChange: () => void) {
  const [state, setState] = useState<"off" | "starting" | "on" | "error">("off");
  const [note, setNote] = useState("");
  const pc = useRef<RTCPeerConnection | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const stop = () => {
    pc.current?.getSenders().forEach((s) => s.track?.stop());
    pc.current?.close();
    pc.current = null;
    setState("off");
    setNote("Live voice stopped.");
    onChange();
  };
  useEffect(() => () => pc.current?.close(), []);

  const start = async () => {
    if (pc.current) return stop();
    setState("starting");
    setNote("Asking for your microphone…");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("This browser can't do live voice. Type instead, or use Call my phone.");
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const conn = new RTCPeerConnection();
      pc.current = conn;
      if (!audio.current) {
        audio.current = new Audio();
        audio.current.autoplay = true;
      }
      conn.ontrack = (e) => {
        if (audio.current) audio.current.srcObject = e.streams[0];
      };
      mic.getTracks().forEach((t) => conn.addTrack(t, mic));
      // GPT-Live's event channel. The server watches the same session on its sideband and acts there; the browser
      // only notes when the session ends.
      const dc = conn.createDataChannel("oai-events");
      dc.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "session.closed") {
            setNote("The call ended.");
            setTimeout(stop, 500);
          }
        } catch {
          /* not JSON */
        }
      };
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === "connected") {
          setState("on");
          setNote("Connected to gpt-live-1. Speak as the customer; the agent talks first.");
          onChange();
        } else if (["failed", "disconnected"].includes(conn.connectionState) && pc.current === conn) {
          setState("error");
          setNote("The voice connection dropped. The call record is kept; start a new call to try again.");
        }
      };
      setNote("Connecting to the voice model…");
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      const r = await postJson<{ answer: string; model: string }>(`/api/app/calls/${callId}/live/webrtc`, { sdp: offer.sdp });
      await conn.setRemoteDescription({ type: "answer", sdp: r.answer });
      onChange();
    } catch (e) {
      pc.current?.getSenders().forEach((s) => s.track?.stop());
      pc.current?.close();
      pc.current = null;
      setState("error");
      setNote((e as Error).message);
    }
  };
  return { state, note, start, stop };
}

export interface LiveSignal { p: Record<string, number>; fired: string[] }
export interface LiveLine { who: "customer" | "agent" | "owner"; text: string; at: string; by?: string }

/**
 * The owner listens (spec B2 item 4): server-sent events from this app with the live call as it happens: what each
 * side is saying now, finished lines, the transcript decisions with their probabilities, and any correction.
 */
export function useLiveEvents(callId: string, enabled: boolean) {
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState(false);
  const [partial, setPartial] = useState<{ customer: string; agent: string }>({ customer: "", agent: "" });
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [signals, setSignals] = useState<LiveSignal | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const es = new EventSource(`/api/app/calls/${callId}/live/events`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      let e: any;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.kind === "partial") setPartial((p) => ({ ...p, [e.who]: e.text ?? "" }));
      else if (e.kind === "line") {
        setLines((l) => [...l.slice(-40), { who: e.who, text: e.text ?? "", at: e.at, by: e.data?.by }]);
        setPartial((p) => ({ ...p, [e.who === "owner" ? "agent" : e.who]: "" }));
      } else if (e.kind === "signal") setSignals(e.data as LiveSignal);
      else if (e.kind === "status" || e.kind === "guard") {
        setNotes((n) => [...n.slice(-6), e.text ?? ""]);
        if (e.kind === "status") {
          if (typeof e.data?.live === "boolean") setLive(e.data.live);
          else if (/connected/i.test(e.text ?? "")) setLive(true);
          else if (/ended/i.test(e.text ?? "")) setLive(false);
        }
      }
    };
    return () => es.close();
  }, [callId, enabled]);
  return { connected, live, partial, lines, signals, notes };
}
