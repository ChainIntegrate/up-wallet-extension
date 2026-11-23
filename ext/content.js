// UP Wallet extension: the link between the provider in a connected dApp's page (ext/inpage.js, MAIN world) and
// the extension (ext/background.js), in the isolated world of the same page. It passes the dApp's calls and the
// answers; the extension takes the site from Chrome (the port's sender), never from the messages.
(() => {
  "use strict";
  const api = globalThis.chrome;
  if (window.top !== window || window.__upwContent) return;
  window.__upwContent = true;
  const MAX = 512 * 1024;
  let port = null;
  const open = new Set();   // the calls sent and not answered yet
  const toPage = (m) => window.postMessage({ target: "upw-inpage", ...m }, window.location.origin);
  function connect() {
    if (port) return port;
    const p = api.runtime.connect({ name: "dapp" });
    p.onMessage.addListener((m) => {
      if (!m || typeof m !== "object") return;
      if (typeof m.id === "number") open.delete(m.id);
      toPage(m);
    });
    // The extension stopped (restarted, updated, the site disconnected): the calls left are refused.
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      for (const id of open) toPage({ id, error: { code: 4900, message: "UP Wallet is not reachable: try again." } });
      open.clear();
    });
    port = p;
    return port;
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.target !== "upw-content") return;
    const { id, method, params } = e.data;
    if (typeof id !== "number" || typeof method !== "string" || method.length > 100) return;
    let json;
    try { json = JSON.stringify(params === undefined ? [] : params); } catch (x) { json = null; }
    if (json === null || json.length > MAX) { toPage({ id, error: { code: -32602, message: "invalid params" } }); return; }
    try { connect().postMessage({ id, method, params: JSON.parse(json) }); open.add(id); }
    catch (x) {
      // The extension was reloaded or updated: this page keeps the old script until it is reloaded.
      port = null;
      toPage({ id, error: { code: 4900, message: "UP Wallet was updated: reload the page." } });
    }
  });
})();
