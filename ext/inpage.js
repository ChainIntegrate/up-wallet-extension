// UP Wallet extension: the wallet offered to a dApp, in the dApp's own page (content script, MAIN world), only on
// the sites the user has connected (Chrome's permission, granted site by site; ext/background.js registers this
// script for those sites only).
// An EIP-1193 provider announced through EIP-6963 ("UP Wallet"), never written to window.ethereum, so the other
// wallets (MetaMask, LUKSO's extension) keep working. It holds nothing: every call goes to the extension through
// ext/content.js (the isolated world), and the extension knows the site from Chrome, not from this page. The
// account is the Universal Profile chosen in the wallet, on the wallet's network; what is signed is checked and
// confirmed in the wallet, then in its signing window.
(() => {
  "use strict";
  if (window.__upWalletInjected) return;
  Object.defineProperty(window, "__upWalletInjected", { value: true });
  const ICON = "__ICON__";   // filled in by scripts/build.js
  const listeners = {};
  const waiting = new Map();
  let n = 0;
  const emit = (ev, v) => { for (const f of (listeners[ev] || []).slice()) { try { f(v); } catch (e) { /* the dApp's own listener */ } } };
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.target !== "upw-inpage") return;
    const d = e.data;
    if (d.event) { emit(d.event, d.data); return; }
    const w = waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    if (d.error) w.no(Object.assign(new Error(String(d.error.message || "error")), { code: d.error.code, data: d.error.data }));
    else w.ok(d.result);
  });
  const provider = {
    isUpWallet: true,
    request(args) {
      const method = args && args.method;
      if (typeof method !== "string") return Promise.reject(Object.assign(new Error("invalid request"), { code: -32600 }));
      let params;
      try { params = args.params === undefined ? [] : JSON.parse(JSON.stringify(args.params)); }
      catch (e) { return Promise.reject(Object.assign(new Error("invalid params"), { code: -32602 })); }
      return new Promise((ok, no) => {
        const id = ++n;
        waiting.set(id, { ok, no });
        window.postMessage({ target: "upw-content", id, method, params }, window.location.origin);
      });
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((g) => g !== f); return provider; },
  };
  provider.off = provider.removeListener;
  Object.freeze(provider);
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: "UP Wallet", icon: ICON, rdns: "it.chainintegrate.upwallet" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
