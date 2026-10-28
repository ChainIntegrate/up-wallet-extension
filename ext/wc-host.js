// UP Wallet extension: the WalletConnect client, in an offscreen document of the extension (ext/wc-host.html),
// so that the dApps' sessions stay alive while the browser runs, with the wallet closed. The wallet page uses it
// through ext/wc-remote.js, with the same calls as the WalletKit client it would otherwise start itself: this
// file decides nothing, it keeps the connection and passes proposals and requests to the page, where they are
// checked and confirmed as always.
// - A proposal or a request goes to the wallet page that listens (the last one opened). With no page open, the
//   extension opens the wallet in a window and the request waits for it.
// - A page closed with a proposal or a request not answered: rejected, as a wallet does when its window closes.
(function () {
  "use strict";
  const api = globalThis.chrome;
  const SITE = "__SITE__";   // filled in by scripts/build.js from ext-config.json
  const CALLS = new Set(["pair", "approveSession", "rejectSession", "respondSessionRequest", "disconnectSession", "emitSessionEvent"]);
  const MAX_QUEUE = 20;
  const ports = new Set();
  const listening = new Set(); // the pages that receive proposals and requests: the last one opened gets them
  let listener = null;
  const queue = [];           // waiting for a page: [name, event]
  const open = new Map();     // passed to a page, not answered yet: key → { port, name, event }
  let openedAt = 0;
  let kit = null;

  const B = window.WalletKitBundle;
  const sessions = () => (kit ? kit.getActiveSessions() : {});
  const keyOf = (name, e) => (name === "session_proposal" ? "p:" + e.id : "r:" + e.topic + ":" + e.id);
  function changed() {
    const s = sessions();
    for (const p of ports) post(p, { type: "sessions", sessions: s });
    api.storage.local.set({ wcActive: Object.keys(s).length > 0 }).catch(() => null);
    idleCheck();
  }
  function post(port, msg) { try { port.postMessage(msg); return true; } catch (e) { return false; } }

  async function reject(name, e) {
    try {
      if (name === "session_proposal") await kit.rejectSession({ id: e.id, reason: B.getSdkError("USER_REJECTED") });
      else await kit.respondSessionRequest({ topic: e.topic, response: { id: e.id, jsonrpc: "2.0", error: { code: 4001, message: "User rejected the request." } } });
    } catch (x) { /* expired or the session closed meanwhile */ }
  }
  function deliver(name, e) {
    if (listener && post(listener, { type: "event", name, event: e, sessions: sessions() })) {
      open.set(keyOf(name, e), { port: listener, name, event: e });
      return;
    }
    if (queue.length >= MAX_QUEUE) { reject(name, e); return; }
    queue.push([name, e]);
    for (const p of ports) post(p, { type: "waiting", n: queue.length });
    // No page that listens: the wallet opens by itself (once, unless no page is open any more).
    if (!ports.size && Date.now() - openedAt > 10000) {
      openedAt = Date.now();
      api.runtime.sendMessage({ type: "wc-open-wallet" }).catch(() => null);
    }
  }
  function flush() { while (listener && queue.length) { const [name, e] = queue.shift(); deliver(name, e); } }

  async function start() {
    const projectId = (window.CROSSCHAIN_CONFIG || {}).walletConnectProjectId;
    if (!projectId) throw new Error("no WalletConnect project id");
    // No usage telemetry to Reown, as in the page (AUDIT W-tel).
    const core = new B.Core({ projectId, telemetryEnabled: false });
    if (core.eventClient) { core.eventClient.init = async () => {}; core.eventClient.sendEvent = async () => ({ ok: true }); }
    kit = await B.WalletKit.init({ core, metadata: { name: "ChainIntegrate UP Wallet", description: "Universal Profile bridge", url: SITE.replace(/\/$/, ""), icons: [SITE + "favicon.ico"] } });
    kit.on("session_proposal", (e) => deliver("session_proposal", e));
    kit.on("session_request", (e) => deliver("session_request", e));
    kit.on("session_delete", (e) => {
      for (const p of ports) post(p, { type: "event", name: "session_delete", event: e, sessions: sessions() });
      changed();
    });
    changed();
    return kit;
  }
  const ready = start();
  ready.catch((e) => console.error("WalletConnect:", e));

  // A page's call: answered with its result and the sessions as they are after it.
  async function call(port, m) {
    let reply;
    try {
      if (!CALLS.has(m.method)) throw new Error("not a WalletKit call: " + m.method);
      await ready;
      const a = m.args || {};
      const result = await kit[m.method](a);
      if (m.method === "approveSession" || m.method === "rejectSession") open.delete("p:" + a.id);
      if (m.method === "respondSessionRequest" && a.response) open.delete("r:" + a.topic + ":" + a.response.id);
      reply = { type: "reply", n: m.n, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
    } catch (e) {
      reply = { type: "reply", n: m.n, error: String((e && e.message) || e) };
    }
    reply.sessions = sessions();
    post(port, reply);
    if (/Session$/.test(m.method) || m.method === "pair") changed();
  }

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== "wc" || port.sender.id !== api.runtime.id) return;
    ports.add(port);
    ready.then(() => post(port, { type: "state", sessions: sessions(), waiting: queue.length }), (e) => post(port, { type: "state", sessions: {}, waiting: 0, error: String(e.message || e) }));
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "listen") { listening.add(port); listener = port; ready.then(flush); }
      else if (m.type === "call") call(port, m);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      listening.delete(port);
      if (listener === port) listener = [...listening].pop() || null;
      for (const [k, x] of open) if (x.port === port) { open.delete(k); reject(x.name, x.event); }
      // The wallet closed with requests still waiting for it: rejected too.
      if (!ports.size) for (const [name, e] of queue.splice(0)) reject(name, e);
      idleCheck();
    });
  });

  // No session and no page: the extension's service worker closes this document.
  let idleTimer = null;
  function idleCheck() {
    clearTimeout(idleTimer);
    if (ports.size || Object.keys(sessions()).length) return;
    idleTimer = setTimeout(() => {
      if (!ports.size && !Object.keys(sessions()).length) api.runtime.sendMessage({ type: "wc-idle" }).catch(() => null);
    }, 60000);
  }
})();
