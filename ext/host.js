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
//   - "rpc": a JSON-RPC call to one of the few network RPCs that answer the site but not a sandboxed page
//     (origin "null"; checked on 2026-11-23): only those URLs, POST only (RPC_PROXY, set by scripts/build.js);
//   - "focus": bringing the wallet to the front;
//   - "dapp-*" (phase 2): the requests of the connected sites, passed from the service worker to the page and
//     its answers back (the site's origin is always the one Chrome gave the service worker, never the page's
//     word); the list of connected sites, connecting the active tab's site (Chrome's permission for that site,
//     asked here) and disconnecting one.
// Anything else is refused. The page's state comes to it at start in the frame's URL fragment (it has no storage
// of its own). Kept small on purpose: everything here is trusted with the key.
(function () {
  "use strict";
  const api = globalThis.chrome;
  const SITE = "__SITE__";   // filled in by scripts/build.js from ext-config.json
  const RPC_PROXY = new Set(__RPC_PROXY__);   // filled in by scripts/build.js
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

  // ---- the connected sites' requests (phase 2), from the service worker
  const SIGNING = new Set(["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_sendTransaction"]);
  const dappOpen = new Map();   // n → { origin, method }: passed to the page, not answered yet
  const bgCalls = new Map();
  let bg = null, ready = false, bgN = 0;
  const push = (kind, data) => { if (frame.contentWindow) frame.contentWindow.postMessage({ upw: 1, push: kind, data }, "*"); };
  function connectBg() {
    const p = api.runtime.connect({ name: "host" });
    p.onMessage.addListener((m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "request" && typeof m.n === "number") {
        dappOpen.set(m.n, { origin: m.origin, method: m.method });
        push("dapp-request", { n: m.n, origin: m.origin, method: m.method, params: m.params });
      } else if (m.type === "reply") {
        const w = bgCalls.get(m.c);
        if (!w) return;
        bgCalls.delete(m.c);
        if (m.error) w.no(fail(m.error.code || -32603, m.error.message || "error")); else w.ok(m.result);
      }
    });
    // The service worker restarted: the requests it passed are gone with it; connect again.
    p.onDisconnect.addListener(() => {
      if (bg === p) bg = null;
      for (const w of bgCalls.values()) w.no(fail(4900, "the extension restarted"));
      bgCalls.clear(); dappOpen.clear();
      setTimeout(() => { connectBg(); if (ready) bg.postMessage({ type: "listen" }); }, 300);
    });
    bg = p;
  }
  connectBg();
  const bgCall = (type, args) => new Promise((ok, no) => {
    const c = ++bgN;
    bgCalls.set(c, { ok, no });
    try { bg.postMessage({ type, c, ...(args || {}) }); } catch (e) { bgCalls.delete(c); no(fail(4900, "the extension is restarting: try again")); }
  });
  const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;   // https, no port (content-script match patterns take none)
  async function connectActiveSite() {
    const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const tab = tabs.find((t) => t.url && /^https:/.test(t.url));
    if (!tab) {
      throw fail(4100, it()
        ? "Apri il sito della dApp nella scheda attiva, premi il pulsante di UP Wallet nella barra del browser mentre sei lì, poi riprova da questo pannello."
        : "Open the dApp's site in the active tab, press UP Wallet's button in the browser's toolbar while there, then try again from this panel.");
    }
    const origin = new URL(tab.url).origin;
    if (!ORIGIN.test(origin)) throw fail(-32602, "only https sites can be connected");
    // Chrome asks the user for this one site (not "all sites").
    const granted = await api.permissions.request({ origins: [origin + "/*"] }).catch(() => false);
    if (!granted) throw fail(4001, it() ? "Accesso al sito non concesso." : "Access to the site not given.");
    return { origin, sites: await bgCall("add-site", { origin, tabId: tab.id }) };
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
        const req = JSON.parse(json);
        // The site shown in the signing window: the connected site whose request is open, as Chrome named it;
        // none when it is the wallet's own (a send, the key's balance). Never what the page says.
        const open = [...dappOpen.values()].filter((x) => SIGNING.has(x.method));
        req.site = open.length === 1 ? open[0].origin : null;
        return ask(req);
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
      case "rpc": {
        if (!a || !RPC_PROXY.has(a.url) || !str(a.body, MAX_BODY)) throw fail(-32602, "not a proxied RPC");
        const r = await fetch(a.url, { method: "POST", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: a.body });
        const body = await r.text();
        return { status: r.status, body: body.length > MAX_ANSWER ? "" : body };
      }
      case "dapp-listen": { ready = true; bg.postMessage({ type: "listen" }); return bgCall("state"); }
      case "dapp-state": return bgCall("state");
      case "dapp-answer": {
        if (!a || !dappOpen.has(a.n)) throw fail(-32602, "no such request");
        const json = JSON.stringify(a.error ? { error: a.error } : { result: a.result === undefined ? null : a.result });
        if (json.length > MAX_ANSWER) throw fail(-32602, "answer too large");
        dappOpen.delete(a.n);
        bg.postMessage({ type: "answer", n: a.n, ...JSON.parse(json) });
        return null;
      }
      case "dapp-session": {
        if (!a || !ORIGIN.test(a.origin || "")) throw fail(-32602, "bad origin");
        bg.postMessage(a.end ? { type: "session", origin: a.origin, end: true } : { type: "session", origin: a.origin, chainId: Number(a.chainId), account: String(a.account || "") });
        return null;
      }
      case "dapp-event": {
        if (!a || !ORIGIN.test(a.origin || "") || !["chainChanged", "accountsChanged"].includes(a.name)) throw fail(-32602, "bad event");
        bg.postMessage({ type: "event", origin: a.origin, name: a.name, data: JSON.parse(JSON.stringify(a.data ?? null)) });
        return null;
      }
      case "dapp-net": { if (a && Number(a.chainId) > 0) bg.postMessage({ type: "net", chainId: Number(a.chainId) }); return null; }
      case "dapp-connect": return connectActiveSite();
      case "dapp-disconnect": {
        if (!a || !ORIGIN.test(a.origin || "")) throw fail(-32602, "bad origin");
        return bgCall("remove-site", { origin: a.origin });
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

  // ---- a new version (WALLET-BACKLOG item 14), as ChainIntegrate Account does: the site's relay service says
  // which is the latest full release (it reads GitHub; the wallet never does). Shown here, above the wallet,
  // with how to update; the link only if it is a file or page of this extension's own releases. Nothing is
  // downloaded or installed by itself, nothing about the user is sent (a plain read).
  const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  const OWN_RELEASES = "https://github.com/ChainIntegrate/up-wallet-extension/releases/";
  (async () => {
    let v = null;
    try {
      const r = await fetch(SITE + "relay/versions", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      v = r.ok ? (await r.json()).extension : null;
    } catch (e) { return; }
    const mine = api.runtime.getManifest().version;
    if (!v || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v.version || "") || !newer(v.version, mine)) return;
    // "Later": not shown again for three days, for that version.
    const dismissed = "upwallet.update.later";
    const [laterV, laterAt] = String(localStorage.getItem(dismissed) || "").split("|");
    if (laterV === v.version && Date.now() - Number(laterAt) < 3 * 86400000) return;
    const box = $("update");
    const el = (tag, text) => { const e = document.createElement(tag); if (text) e.textContent = text; return e; };
    const head = el("div");
    head.append(el("b", it() ? `È disponibile UP Wallet ${v.version}` : `UP Wallet ${v.version} is available`), document.createTextNode(it() ? ` (questa è la ${mine}).` : ` (this is ${mine}).`));
    box.appendChild(head);
    const steps = el("ol");
    const own = (u) => typeof u === "string" && u.startsWith(OWN_RELEASES) && !/[\s"'<>]/.test(u);
    const li1 = el("li");
    if (own(v.download)) {
      const a = el("a", it() ? "Scarica lo zip" : "Download the zip");
      a.href = v.download; a.target = "_blank"; a.rel = "noopener noreferrer";
      li1.append(a, document.createTextNode(it() ? " (dalle release di ChainIntegrate su GitHub)." : " (from ChainIntegrate's releases on GitHub)."));
    } else li1.textContent = it() ? "Scarica lo zip dalle release di up-wallet-extension su GitHub." : "Download the zip from up-wallet-extension's releases on GitHub.";
    steps.append(li1,
      el("li", it() ? "Copia tutto il contenuto della cartella UP-Wallet-Extension dello zip nella cartella da cui gira già l'estensione (sostituisci i file)." : "Copy everything in the zip's UP-Wallet-Extension folder into the folder the extension already runs from (replace the files)."),
      el("li", it() ? "Su chrome://extensions premi \"Carica estensione non pacchettizzata\" sulla stessa cartella e controlla la versione. Non rimuovere mai l'estensione: la chiave si perderebbe." : "On chrome://extensions press \"Load unpacked\" on the same folder and check the version. Never remove the extension: its key would be lost."));
    box.appendChild(steps);
    if (own(v.notes)) {
      const n = el("a", it() ? "Cosa cambia" : "What changes");
      n.href = v.notes; n.target = "_blank"; n.rel = "noopener noreferrer";
      const p = el("div"); p.style.marginTop = "4px"; p.appendChild(n); box.appendChild(p);
    }
    const later = el("button", it() ? "Più tardi" : "Later");
    later.type = "button";
    later.addEventListener("click", () => { try { localStorage.setItem(dismissed, `${v.version}|${Date.now()}`); } catch (e) { /* shown again */ } box.hidden = true; });
    box.appendChild(later);
    box.hidden = false;
  })();

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
