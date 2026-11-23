// UP Wallet extension: the first script of the wallet page, which runs as a sandboxed page of the extension
// (manifest "sandbox", review of 2026-11-04 EXT-01): an opaque origin, with no chrome.* API and no storage of
// its own. The page reaches the extension only through its host (wallet.html, ext/host.js), by messages; this
// file gives it:
//   - localStorage and sessionStorage as the page expects them: the state the host sent in the frame's URL
//     fragment at start, each change sent back to the host (sessionStorage stays in memory);
//   - window.__upwBridge.call(type, args): one request to the host, answered with a promise.
// It holds nothing the page could not already ask: the key, the passkey and the signing window are out of its reach.
(function () {
  "use strict";
  // Opened by itself (not inside the wallet's host, the only place where it works): nothing else loads, and it
  // says where the wallet is. (A sandboxed page cannot open the extension's own pages.)
  if (window.parent === window) {
    window.stop();
    const it = /^it\b/i.test(navigator.language || "");
    document.documentElement.innerHTML = "<head><meta charset=\"utf-8\"><title>UP Wallet</title></head><body style=\"font:15px/1.5 system-ui,sans-serif;padding:24px;background:#0f1115;color:#e6e9ef\"></body>";
    document.body.textContent = it ? "UP Wallet si apre dal pulsante dell'estensione nella barra del browser." : "UP Wallet opens from the extension's button in the browser's toolbar.";
    return;
  }

  let init = {};
  const m = /[#&]upw=([^&]*)/.exec(location.hash);
  if (m) {
    try {
      const bin = atob(decodeURIComponent(m[1]));
      init = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) || {};
    } catch (e) { init = {}; }
    // The fragment only carries the state: the page sees its address without it.
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* kept */ }
  }

  // ---- the bridge to the host
  const parent = window.parent;
  const waiting = new Map();
  const pushes = {};   // the host's own messages (the connected sites' requests): kind → listeners
  let n = 0;
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (d && d.upw === 1 && typeof d.push === "string") { for (const f of pushes[d.push] || []) { try { f(d.data); } catch (x) { /* the listener's own error */ } } return; }
    if (!d || d.upw !== 1 || !waiting.has(d.n)) return;
    const w = waiting.get(d.n);
    waiting.delete(d.n);
    if (d.error) w.no(Object.assign(new Error(d.error.message || "error"), { code: d.error.code }));
    else w.ok(d.result);
  });
  function call(type, args) {
    return new Promise((ok, no) => {
      const id = ++n;
      waiting.set(id, { ok, no });
      parent.postMessage({ upw: 1, n: id, type, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }, "*");
    });
  }
  const send = (type, args) => parent.postMessage({ upw: 1, type, args }, "*");

  // ---- storage
  function storage(initial, persist) {
    const data = new Map(Object.entries(initial || {}).filter(([k, v]) => typeof v === "string"));
    return {
      getItem(k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem(k, v) { k = String(k); v = String(v); data.set(k, v); if (persist) send("store", { op: "set", key: k, value: v }); },
      removeItem(k) { k = String(k); data.delete(k); if (persist) send("store", { op: "remove", key: k }); },
      clear() { for (const k of [...data.keys()]) this.removeItem(k); },
      key(i) { return [...data.keys()][i] ?? null; },
      get length() { return data.size; },
    };
  }
  const local = storage(init.store, true), session = storage({}, false);
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => session });

  window.__upwBridge = Object.freeze({
    call,
    on(kind, f) { (pushes[kind] = pushes[kind] || []).push(f); },
    info: Object.freeze({ version: typeof init.version === "string" ? init.version : "", site: typeof init.site === "string" ? init.site : "" }),
  });
})();
