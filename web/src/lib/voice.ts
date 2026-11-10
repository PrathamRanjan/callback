import { useRef, useState } from "react";
import { postJson } from "./api";

/**
 * Live voice: OpenAI Realtime over WebRTC, the same protocol as the server-rendered page. The browser gets a
 * short-lived client secret, streams the microphone, and every function call the model makes is executed on the
 * server through the money gate (/calls/:id/tool); the gate's result goes back to the model.
 */
export function useLiveVoice(callId: string, onChange: () => void) {
  const [state, setState] = useState<"off" | "starting" | "on" | "error">("off");
  const [note, setNote] = useState("");
  const pc = useRef<RTCPeerConnection | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const handled = useRef(new Set<string>());

  const stop = () => {
    pc.current?.getSenders().forEach((s) => s.track?.stop());
    pc.current?.close();
    pc.current = null;
    setState("off");
    setNote("Stopped.");
    onChange();
  };

  const start = async () => {
    if (pc.current) return stop();
    setState("starting");
    setNote("Opening a secure voice session…");
    try {
      const s = await postJson<{ client_secret: string; model: string }>(`/voice/realtime/session/${callId}`);
      const conn = new RTCPeerConnection();
      pc.current = conn;
      if (!audio.current) {
        audio.current = new Audio();
        audio.current.autoplay = true;
      }
      conn.ontrack = (e) => {
        if (audio.current) audio.current.srcObject = e.streams[0];
      };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => conn.addTrack(t, mic));
      const dc = conn.createDataChannel("oai-events");
      dc.onmessage = async (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
          void postJson(`/calls/${callId}/speech`, { text: msg.transcript }).then(onChange).catch(() => {});
        }
        if ((msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") && msg.transcript) {
          void postJson(`/calls/${callId}/speech`, { who: "agent", text: msg.transcript }).then(onChange).catch(() => {});
        }
        if (msg.type === "response.function_call_arguments.done" || (msg.type === "response.output_item.done" && msg.item?.type === "function_call")) {
          const item = msg.item ?? msg;
          // Each function call arrives twice (arguments.done, then output_item.done): run it once.
          if (!item.call_id || handled.current.has(item.call_id)) return;
          handled.current.add(item.call_id);
          let args = {};
          try {
            args = JSON.parse(item.arguments || "{}");
          } catch {
            /* empty args */
          }
          setNote(`Checking with the money gate: ${item.name}`);
          const out = await postJson<{ ended?: boolean }>(`/calls/${callId}/tool`, { name: item.name, arguments: args, call_id: item.call_id }).catch((e) => ({ ok: false, error: (e as Error).message }) as any);
          dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(out) } }));
          dc.send(JSON.stringify({ type: "response.create" }));
          onChange();
          if (out?.ended) setTimeout(stop, 2500);
        }
      };
      dc.onopen = () => {
        setState("on");
        setNote("Connected. Speak as the customer.");
        dc.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: { transcription: { model: "gpt-4o-mini-transcribe", language: "en" } } } } }));
        dc.send(JSON.stringify({ type: "response.create" }));
      };
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      const sdp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(s.model)}`, { method: "POST", headers: { Authorization: `Bearer ${s.client_secret}`, "content-type": "application/sdp" }, body: offer.sdp });
      if (!sdp.ok) throw new Error(`The voice service refused the connection (${sdp.status}).`);
      await conn.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
    } catch (e) {
      pc.current?.close();
      pc.current = null;
      setState("error");
      setNote((e as Error).message);
    }
  };
  return { state, note, start, stop };
}
