import { postJson } from "./api";

/** WebAuthn passkey helpers, the same protocol as the server's /ops/guard/passkey routes. */
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const passkeysSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

export async function registerPasskey() {
  const r = await postJson<{ id: string; challenge: string; rpName: string; userId: string; userName: string }>("/ops/guard/passkey/register/start");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(r.challenge), rp: { name: r.rpName }, user: { id: fromB64u(r.userId), name: r.userName, displayName: r.userName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { userVerification: "preferred" },
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const resp = cred.response as AuthenticatorAttestationResponse & { authenticatorData?: ArrayBuffer };
  const authData = resp.getAuthenticatorData ? resp.getAuthenticatorData() : resp.authenticatorData!;
  return postJson("/ops/guard/passkey/register/finish", { chalId: r.id, rawId: b64u(cred.rawId), clientDataJSON: b64u(resp.clientDataJSON), authenticatorData: b64u(authData) });
}

export async function countersign(approvalId: string) {
  const r = await postJson<{ id: string; challenge: string }>("/ops/guard/passkey/sign/start", { approvalId });
  const cred = (await navigator.credentials.get({ publicKey: { challenge: fromB64u(r.challenge), userVerification: "preferred" } })) as PublicKeyCredential | null;
  if (!cred) throw new Error("The passkey was not used.");
  const resp = cred.response as AuthenticatorAssertionResponse;
  return postJson<{ status: string; followUp?: { message: string } | null }>("/ops/guard/passkey/sign/finish", {
    chalId: r.id, approvalId, rawId: b64u(cred.rawId), clientDataJSON: b64u(resp.clientDataJSON), authenticatorData: b64u(resp.authenticatorData), signature: b64u(resp.signature),
  });
}
