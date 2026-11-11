/**
 * The phone bridge (spec B2 item 1, option a): Twilio Media Streams to a GPT-Live WebSocket session.
 * Twilio dials, fetches /webhooks/voice/live/:id, and opens a WebSocket to /voice/stream with the call id and a
 * one-use stream token as custom parameters. This server opens a GPT-Live session in Twilio's own audio format
 * (G.711 μ-law, 8 kHz), passes audio both ways unchanged, clears Twilio's buffer when the customer talks over the
 * agent, and closes the stream when the call ends (the TwiML then hangs up).
 * The test line uses the same socket and protocol, so a robot can stand in for Twilio when checking the deployed app.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { getDb, inWorkspace, scopedSecret, type Queryable } from "../db.js";
import { wsFromSecret } from "../services/wsrefs.js";
import { instructionsForCall, LiveCall, liveCallFor, openPrimary } from "./live.js";

export type StreamTransport = "phone" | "test-line";

/** A one-use token for one call's audio stream, valid for ten minutes. It names its workspace (cbv_w<ws>_…). */
export async function issueStreamToken(q: Queryable, callId: string, transport: StreamTransport): Promise<string> {
  const token = scopedSecret("cbv");
  await q.query("UPDATE calls SET state = state || $2::jsonb WHERE id = $1", [callId, JSON.stringify({ live_token: token, live_token_at: new Date().toISOString(), live_transport: transport, live_token_used: false })]);
  return token;
}

/** Takes the token if it is this call's, unused and fresh; marks it used in the same statement. */
export async function claimStreamToken(callId: string, token: string): Promise<{ ws: string | null; transport: StreamTransport } | null> {
  if (!callId || !token || !/^cbv_/.test(token)) return null;
  const ws = wsFromSecret(token);
  const db = await getDb();
  const r = await inWorkspace(ws, () =>
    db.query<{ transport: string }>(
      `UPDATE calls SET state = state || '{"live_token_used":true}'::jsonb, status = CASE WHEN status = 'ringing' THEN 'in_progress' ELSE status END
       WHERE id = $1 AND state->>'live_token' = $2 AND coalesce(state->>'live_token_used','false') <> 'true'
         AND (state->>'live_token_at')::timestamptz > now() - interval '10 minutes' AND status IN ('ringing','in_progress')
       RETURNING state->>'live_transport' AS transport`,
      [callId, token],
    ),
  );
  const t = r.rows[0]?.transport;
  return t === "phone" || t === "test-line" ? { ws, transport: t } : null;
}

/**
 * Ends a stream so the other side can tell why, even through a proxy that drops close frames (Render's edge does):
 * a plain message first ({"event":"closing","code":…,"reason":…}; Twilio ignores unknown events), then the close,
 * then the socket is cut if the close handshake has not finished in two seconds.
 */
function shut(tw: WebSocket, code: number, reason: string) {
  if (tw.readyState !== WebSocket.OPEN) return;
  tw.send(JSON.stringify({ event: "closing", code, reason }));
  tw.close(code, reason);
  setTimeout(() => tw.readyState !== WebSocket.CLOSED && tw.terminate(), 2000).unref();
}

function onStream(tw: WebSocket) {
  let live: LiveCall | null = null;
  let streamSid: string | null = null;
  let starting = false;
  const toTwilio = (m: unknown) => tw.readyState === WebSocket.OPEN && tw.send(JSON.stringify(m));
  tw.on("message", (raw) => {
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.event === "start" && !starting) {
      starting = true;
      streamSid = String(m.start?.streamSid ?? m.streamSid ?? "");
      const p = m.start?.customParameters ?? {};
      const callId = String(p.call ?? "");
      void (async () => {
        const claim = await claimStreamToken(callId, String(p.token ?? ""));
        if (!claim) {
          console.error(`[bridge] refused a stream for ${callId.slice(0, 40)}: token missing, used, stale or not this call's`);
          return shut(tw, 1008, "not allowed");
        }
        if (liveCallFor(callId)) return shut(tw, 1008, "this call already has live voice");
        const instructions = await inWorkspace(claim.ws, () => instructionsForCall(callId));
        const link = openPrimary(instructions, { type: "audio/pcmu", rate: 8000 });
        live = new LiveCall({
          callId, ws: claim.ws, link, role: "primary", transport: claim.transport,
          onAudio: (b64) => toTwilio({ event: "media", streamSid, media: { payload: b64 } }),
          onBargeIn: () => toTwilio({ event: "clear", streamSid }),
          onEnd: () => setTimeout(() => shut(tw, 1000, "call ended"), 300),
        });
      })().catch((e) => {
        console.error("[bridge] start failed", (e as Error).message);
        shut(tw, 1011, "start failed");
      });
    } else if (m.event === "media" && live && (m.media?.track ?? "inbound") === "inbound") {
      live.sendAudio(String(m.media?.payload ?? ""));
    } else if (m.event === "stop") {
      live?.close();
    }
  });
  tw.on("close", () => live?.close());
  tw.on("error", (e) => console.error("[bridge] socket", e.message));
}

/** Adds /voice/stream to the HTTP server. Any other upgrade request is refused. */
export function attachVoiceBridge(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/voice/stream") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (tw) => onStream(tw));
  });
  return wss;
}
