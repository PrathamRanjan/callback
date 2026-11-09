// Live voice: OpenAI Realtime over WebRTC. The browser gets a short-lived client secret from this server, streams
// microphone audio to the model and plays its voice back. Every function call the model makes is POSTed to
// /calls/:id/tool and executed server-side through the money gate; the result is returned to the model.
(() => {
  const btn = document.getElementById("rt-start");
  if (!btn) return;
  const status = document.getElementById("rt-status");
  const audio = document.getElementById("rt-audio");
  const callId = btn.dataset.call;
  const say = (t) => { if (status) status.textContent = t; };
  let pc = null, dc = null;
  btn.addEventListener("click", async () => {
    if (pc) { pc.close(); pc = null; btn.textContent = "Start live voice"; say("stopped"); location.reload(); return; }
    try {
      btn.disabled = true; say("minting session…");
      const s = await fetch(`/voice/realtime/session/${callId}`, { method: "POST", headers: { accept: "application/json" } }).then((r) => r.json());
      if (!s.client_secret) throw new Error(s.message || s.error || "no client secret");
      pc = new RTCPeerConnection();
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => pc.addTrack(t, mic));
      dc = pc.createDataChannel("oai-events");
      dc.onmessage = async (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
          fetch(`/calls/${callId}/speech`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ text: msg.transcript }) }).catch(() => {});
        }
        if (msg.type === "response.function_call_arguments.done" || msg.type === "response.output_item.done" && msg.item && msg.item.type === "function_call") {
          const item = msg.item || msg;
          const name = item.name; const callIdOai = item.call_id;
          let args = {}; try { args = JSON.parse(item.arguments || "{}"); } catch {}
          say(`tool: ${name}`);
          const out = await fetch(`/calls/${callId}/tool`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ name, arguments: args }) }).then((r) => r.json());
          dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callIdOai, output: JSON.stringify(out) } }));
          dc.send(JSON.stringify({ type: "response.create" }));
          if (out.ended) setTimeout(() => location.reload(), 2500);
        }
      };
      dc.onopen = () => { say("connected: speak"); dc.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } } } })); dc.send(JSON.stringify({ type: "response.create" })); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(s.model)}`, { method: "POST", headers: { Authorization: `Bearer ${s.client_secret}`, "content-type": "application/sdp" }, body: offer.sdp });
      if (!sdp.ok) throw new Error("realtime handshake " + sdp.status);
      await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
      btn.textContent = "Stop live voice"; btn.disabled = false;
    } catch (e) { say("failed: " + e.message); btn.disabled = false; if (pc) { pc.close(); pc = null; } }
  });
})();
