/** Turns on web push for the signed-in owner on this device: service worker, permission, subscription, saved on the server. */
export async function enablePush(): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) throw new Error("This browser can't show alerts. On iPhone, add Callback to your Home Screen first.");
  const { key } = (await fetch("/push/public-key").then((r) => r.json())) as { key: string | null };
  if (!key) throw new Error("Alerts aren't set up on this server yet.");
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Alerts are blocked for this site. Allow notifications in your browser settings, then try again.");
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) }));
  const r = await fetch("/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
  if (!r.ok) throw new Error("Couldn't save alerts for this device. Sign in again and retry.");
  return "Alerts are on for this device. Held money moves will pop up here.";
}
