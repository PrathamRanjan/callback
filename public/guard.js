// Guard console: passkey registration + countersign, backtest slider label.
(() => {
  const s = document.getElementById("bt-slider"), o = document.getElementById("bt-out");
  if (s && o) s.addEventListener("input", () => (o.textContent = "$" + (Number(s.value)) + "%"));
  const reg = document.getElementById("pk-register");
  if (reg) reg.addEventListener("click", async () => {
    try {
      const r = await registerPasskey("/ops/guard/passkey/register/start", "/ops/guard/passkey/register/finish");
      if (r.error) throw new Error(r.message || r.error);
      location.href = "/ops/guard?ok=" + encodeURIComponent("Passkey registered");
    } catch (e) { alert("Passkey registration failed: " + e.message); }
  });
  document.querySelectorAll("[data-countersign]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const r = await countersign("/ops/guard/passkey/sign/start", "/ops/guard/passkey/sign/finish", b.dataset.countersign);
      if (r.error) throw new Error(r.message || r.error);
      location.href = "/ops/guard?ok=" + encodeURIComponent("Approved with passkey; payload hash " + r.payload_hash.slice(0, 12));
    } catch (e) { alert("Countersign failed: " + e.message); b.disabled = false; }
  }));
})();
