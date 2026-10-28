// UP Wallet extension: the page's WalletConnect client is the extension's (ext/wc-host.js, an offscreen document
// that keeps the dApps' sessions while the wallet is closed). Loaded right after the WalletKit bundle: the page
// starts WalletKit as on the site, and gets an object with the same calls, passed to the extension's client.
// Proposals and requests reach the page's own handlers, which check and confirm them as always.
// When the wallet opens and the extension keeps a session, the page takes back that session's network and UP,
// and this computer's key, and once its checks are green it receives the session's requests again.
(function () {
  "use strict";
  const api = globalThis.chrome;
  const bundle = window.WalletKitBundle;
  if (!bundle || !api || !api.runtime || !api.runtime.connect) return;
  const en = () => document.documentElement.lang === "en";

  let port = null, connecting = null, cache = {}, n = 0, listening = false;
  const calls = new Map();
  const handlers = {};

  function connect() {
    if (port) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      const r = await api.runtime.sendMessage({ type: "wc-ensure" });
      if (!r || !r.ok) throw new Error((r && r.error) || "the extension's WalletConnect client did not start");
      const p = api.runtime.connect({ name: "wc" });
      const state = new Promise((ok, no) => {
        p.onMessage.addListener((m) => {
          if (!m || typeof m !== "object") return;
          if (m.sessions) cache = m.sessions;
          if (m.type === "state") { if (m.error) no(new Error(m.error)); else ok(m); }
          else if (m.type === "reply") {
            const c = calls.get(m.n);
            if (!c) return;
            calls.delete(m.n);
            if (m.error) c.no(new Error(m.error)); else c.ok(m.result);
          } else if (m.type === "event") {
            for (const fn of handlers[m.name] || []) { try { fn(m.event); } catch (e) { /* the page's own error */ } }
          } else if (m.type === "waiting") waiting(m.n);
        });
        p.onDisconnect.addListener(() => {
          if (port === p) { port = null; listening = false; }
          for (const c of calls.values()) c.no(new Error("the extension's WalletConnect client closed"));
          calls.clear();
          no(new Error("the extension's WalletConnect client closed"));
        });
      });
      const s = await state;
      port = p;
      if (handlers.session_proposal && handlers.session_request) listen();
      return s;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  function listen() {
    if (listening || !port) return;
    listening = true;
    port.postMessage({ type: "listen" });
  }
  async function call(method, args) {
    await connect();
    const id = ++n;
    return new Promise((ok, no) => {
      calls.set(id, { ok, no });
      port.postMessage({ type: "call", n: id, method, args: args === undefined ? {} : JSON.parse(JSON.stringify(args)) });
    });
  }

  const kit = {
    on(name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
      if (handlers.session_proposal && handlers.session_request) listen();
      return kit;
    },
    off(name, fn) { handlers[name] = (handlers[name] || []).filter((f) => f !== fn); return kit; },
    getActiveSessions() { return cache; },
  };
  for (const m of ["pair", "approveSession", "rejectSession", "respondSessionRequest", "disconnectSession", "emitSessionEvent"]) kit[m] = (a) => call(m, a);
  kit.removeListener = kit.off;

  // The page starts WalletKit as on the site (new Core, WalletKit.init): it gets the extension's client instead.
  // buildApprovedNamespaces and getSdkError stay the bundle's own.
  window.WalletKitBundle = Object.assign({}, bundle, {
    Core: function Core() {},
    WalletKit: { init: async () => { await connect(); return kit; } },
  });

  // ---- the extension keeps a session: the page takes it back
  // The page's own top-level names (a classic script sees them; they exist once the page's scripts have run).
  /* global walletKit, compliance, signerAddress, NETWORKS, getWalletKit, log */
  const page = {
    walletKit: () => (typeof walletKit !== "undefined" ? walletKit : null),
    compliance: () => (typeof compliance !== "undefined" ? compliance : null),
    signerAddress: () => (typeof signerAddress !== "undefined" ? signerAddress : null),
    NETWORKS: () => (typeof NETWORKS !== "undefined" ? NETWORKS : []),
  };
  const note = (it, eng, cls) => { if (typeof log === "function") log("WalletConnect: " + (en() ? eng : it), cls); };
  let resuming = false;
  async function resume(s) {
    if (resuming || page.walletKit()) return;
    resuming = true;
    try {
      const all = Object.values((s && s.sessions) || cache);
      const acc = all.length ? ((all[all.length - 1].namespaces || {}).eip155 || {}).accounts || [] : [];
      const [, chain, up] = String(acc[0] || "").split(":");
      const nets = page.NETWORKS();
      const net = nets.find((x) => x.chainId && String(x.chainId) === chain);
      const sel = document.getElementById("network"), upEl = document.getElementById("upAddress");
      if (net && sel && upEl && /^0x[0-9a-fA-F]{40}$/.test(up || "")) {
        if (sel.value !== net.key && [...sel.options].some((o) => o.value === net.key)) {
          sel.value = net.key;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (upEl.value.trim().toLowerCase() !== up.toLowerCase()) {
          upEl.value = window.ethers ? window.ethers.getAddress(up) : up;
          upEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
        // This computer's key, if it exists: connecting it asks for nothing (no signature).
        const key = (await api.storage.local.get("deviceKey")).deviceKey;
        if (key && !page.signerAddress()) document.getElementById("connectSigner").click();
      }
      // The session resumes once the page's checks are green: the page then keeps or closes it, as it does
      // with the sessions of a previous visit.
      for (let i = 0; i < 180 && !page.walletKit(); i++) {
        if (page.compliance()) { await getWalletKit(); break; }
        await new Promise((ok) => setTimeout(ok, 250));
      }
      if (!page.walletKit()) note("la sessione resta nell'estensione: riprende quando la verifica del pannello 3 è verde.", "the session stays in the extension: it resumes once the check of panel 3 is green.", "line-warn");
    } catch (e) {
      note(`ripresa della sessione non riuscita (${e.message}).`, `the session could not be resumed (${e.message}).`, "line-warn");
    } finally { resuming = false; }
  }
  function waiting(count) {
    if (listening) return;
    note(`${count} richiesta in attesa di questa pagina.`, `${count} request(s) waiting for this page.`, "line-warn");
    if (!resuming) connect().then(resume, () => null);
  }
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      const opened = new URLSearchParams(location.search).has("wc");   // opened by the extension for a request
      if (!opened && !(await api.storage.local.get("wcActive")).wcActive) return;
      const s = await connect();
      if (Object.keys(s.sessions || {}).length || s.waiting) await resume(s);
    } catch (e) { /* the page starts WalletKit itself when the user pairs */ }
  });
})();
