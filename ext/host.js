// UP Wallet extension: the wallet's host (wallet.html), the small privileged page that holds the wallet page.
//
// The wallet page (up-wallet.html, the same page as the site, with its decoders and every script it loads) runs
// in a frame as a sandboxed page of the extension (manifest "sandbox"): an opaque origin, no chrome.* API, no
// access to the extension's storage, to the passkey (whose relying party is the extension's id) or to the
// extension's other windows (review of 2026-11-04, EXT-01). It reaches the extension only through this file, by
// messages, and only for:
//   - "store": its own settings (language, network, last UP, contacts...), kept in this origin's localStorage,
//     which holds nothing else: the key is in chrome.storage.local, which the page cannot read;
//   - "key": the computer key's public address and how it is unlocked (passkey or password), never the key;
//   - "sign": a structured request for the signing window (ext/signer.html), which computes again from the
//     request what is signed, shows it, and asks for the passkey or the password: the only place where the key
//     is opened. One request at a time;
//   - "relay": the site's relay service (gas paid by the site), on its known paths only;
//   - "focus": bringing the wallet to the front.
// Anything else is refused. The page's state comes to it at start in the frame's URL fragment (it has no storage
// of its own). Kept small on purpose: everything here is trusted with the key.
(function () {
  "use strict";
  const api = globalThis.chrome;
  const SITE = "__SITE__";   // filled in by scripts/build.js from ext-config.json
  const PAGE = "up-wallet.html";
  const KINDS = new Set(["create", "remove", "message", "typed", "tx", "userop"]);
  const RELAY = /^relay\/(info|send|receipt|sponsor\/(check|sign|email))(\?hash=0x[0-9a-fA-F]{64})?$/;
  const MAX_REQUEST = 256 * 1024, MAX_VALUE = 512 * 1024, MAX_BODY = 64 * 1024, MAX_ANSWER = 1024 * 1024, MAX_SNAPSHOT = 1536 * 1024;
  const $ = (id) => document.getElementById(id);
  const it = () => /^it\b/i.test(localStorage.getItem("upwallet.lang") || navigator.language || "");
  const fail = (code, message) => Object.assign(new Error(message), { code });

  // ---- the page, in its frame, with its state
  function snapshot() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    // Caches (contract ABIs) last: they are left out first if the state is too large for a URL.
    keys.sort((a, b) => (a.startsWith("abi.") ? 1 : 0) - (b.startsWith("abi.") ? 1 : 0));
    const store = {};
    let size = 0;
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v === null || size + k.length + v.length > MAX_SNAPSHOT) continue;
      store[k] = v; size += k.length + v.length;
    }
    return store;
  }
  const b64 = (s) => { const u8 = new TextEncoder().encode(s); let x = ""; for (let i = 0; i < u8.length; i += 0x8000) x += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(x); };
  const frame = document.createElement("iframe");
  frame.title = "UP Wallet";
  frame.allow = "clipboard-write *; web-share *";   // "*": the sandboxed frame has an opaque origin, which no named origin matches
  const init = { store: snapshot(), version: api.runtime.getManifest().version, site: SITE };
  frame.src = PAGE + location.search + "#upw=" + encodeURIComponent(b64(JSON.stringify(init)));
  document.body.appendChild(frame);

  // ---- the signing window
  let busy = false;
  async function ask(req) {
    if (busy) throw fail(-32002, "a request is already open in the signing window");
    busy = true;
    const id = crypto.randomUUID();
    await api.storage.session.set({ ["req:" + id]: req });
    try {
      return await new Promise((ok, no) => {
        let winId = null;
        const done = (fn, v) => { api.runtime.onMessage.removeListener(onMsg); api.windows.onRemoved.removeListener(onGone); fn(v); };
        const onMsg = (m, sender) => {
          if (!m || m.type !== "signer-result" || m.id !== id || sender.id !== api.runtime.id) return;
          if (m.error) done(no, fail(m.error.code || -32603, m.error.message || "error")); else done(ok, m.result);
        };
        const onGone = (w) => { if (w === winId) done(no, fail(4001, "User rejected the request.")); };
        api.runtime.onMessage.addListener(onMsg);
        api.windows.onRemoved.addListener(onGone);
        // A window at the top right of the browser window, under the toolbar, as browser wallets do; wide and
        // tall enough for the browser's own passkey dialogs (Windows Hello's PIN among them), which open over it.
        const W = 520, H = 680;
        api.windows.getCurrent().catch(() => null).then((cur) => {
          const left = cur && cur.left != null ? cur.left + Math.max(0, cur.width - W - 12) : Math.round(window.screenX + window.outerWidth - W - 12);
          const top = cur && cur.top != null ? cur.top + 72 : Math.round(window.screenY + 72);
          return api.windows.create({ url: api.runtime.getURL("ext/signer.html#" + encodeURIComponent(id)), type: "popup", width: W, height: H, left: Math.max(0, left), top: Math.max(0, top), focused: true });
        })
          .then((win) => { winId = win.id; })
          .catch((e) => done(no, fail(-32603, e.message)));
      });
    } finally { busy = false; api.storage.session.remove("req:" + id).catch(() => null); }
  }

  // ---- what the page may ask
  const str = (v, max) => typeof v === "string" && v.length <= max;
  async function handle(type, a) {
    switch (type) {
      case "store": {
        if (!a || !str(a.key, 256)) throw fail(-32602, "bad key");
        if (a.op === "set") { if (!str(a.value, MAX_VALUE)) throw fail(-32602, "bad value"); try { localStorage.setItem(a.key, a.value); } catch (e) { /* full: the page keeps it in memory */ } }
        else if (a.op === "remove") localStorage.removeItem(a.key);
        else throw fail(-32602, "bad op");
        return null;
      }
      case "key": {
        const k = (await api.storage.local.get("deviceKey")).deviceKey;
        return k && k.address ? { address: k.address, method: k.method === "password" ? "password" : "passkey" } : null;
      }
      case "sign": {
        if (!a || typeof a !== "object" || !KINDS.has(a.kind)) throw fail(-32602, "unknown request");
        const json = JSON.stringify(a);
        if (json.length > MAX_REQUEST) throw fail(-32602, "request too large");
        return ask(JSON.parse(json));
      }
      case "relay": {
        if (!a || !str(a.path, 200) || !RELAY.test(a.path)) throw fail(-32602, "not a relay path");
        const method = a.method === "POST" ? "POST" : "GET";
        if (method === "POST" && !str(a.body, MAX_BODY)) throw fail(-32602, "bad body");
        const r = await fetch(SITE + a.path, { method, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
          headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? a.body : undefined });
        const body = await r.text();
        return { status: r.status, body: body.length > MAX_ANSWER ? "" : body };
      }
      case "focus": {
        const tab = await api.tabs.getCurrent().catch(() => null);
        if (tab) { await api.tabs.update(tab.id, { active: true }); await api.windows.update(tab.windowId, { focused: true }); return null; }
        const w = await api.windows.getCurrent().catch(() => null);
        if (w) await api.windows.update(w.id, { focused: true });
        return null;
      }
    }
    throw fail(4200, "not available to the wallet page");
  }
  window.addEventListener("message", async (e) => {
    // Only the page's own frame (a sandboxed page: origin "null").
    if (e.source !== frame.contentWindow || e.origin !== "null") return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.upw !== 1 || typeof m.type !== "string") return;
    let out;
    try { out = { result: await handle(m.type, m.args) }; }
    catch (err) { out = { error: { code: typeof err.code === "number" ? err.code : -32603, message: String((err && err.message) || err).slice(0, 500) } }; }
    if (typeof m.n === "number" && frame.contentWindow) frame.contentWindow.postMessage({ upw: 1, n: m.n, ...out }, "*");
  });

  // ---- Chrome's "Site access": without it the extension cannot reach the site (the relay, the gas paid by the
  // site). Said here, with a button that asks for it again.
  (async () => {
    const origins = [SITE + "*"];
    let ok = true;
    try { ok = await api.permissions.contains({ origins }); } catch (e) { return; }
    if (ok) return;
    $("bannerText").textContent = it()
      ? "Chrome non lascia raggiungere il sito a UP Wallet (\"Accesso ai siti\" dell'estensione): il gas pagato dal sito non si può usare."
      : "Chrome does not let UP Wallet reach the site (the extension's \"Site access\"): the gas paid by the site cannot be used.";
    $("bannerBtn").textContent = it() ? "Consenti" : "Allow";
    $("bannerBtn").addEventListener("click", async () => {
      try { if (await api.permissions.request({ origins })) location.reload(); } catch (e) { /* the user's choice */ }
    });
    $("banner").hidden = false;
  })();
})();
