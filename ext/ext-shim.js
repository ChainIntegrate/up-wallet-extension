// UP Wallet extension: the differences between the extension and the site page, loaded before the page's own
// scripts (after ext/sandbox-shim.js, which gives the bridge to the extension's host).
// - The relay service lives on the site: its relative URLs ("relay/...") go there through the host (the wallet
//   page is sandboxed, with no origin the relay accepts; the host is the extension's own page).
// - Links to the site's other pages, which the extension does not contain, open on the site in a new tab.
(function () {
  "use strict";
  const SITE = "__SITE__";   // filled in by scripts/build.js from ext-config.json
  const PAGE = "__PAGE__";
  const bridge = window.__upwBridge;
  // The network RPCs that answer the site but not a sandboxed page: their calls go through the host.
  const RPC_PROXY = new Set(__RPC_PROXY__);   // filled in by scripts/build.js
  document.documentElement.classList.add("in-extension");
  window.__upwalletSite = SITE;
  // The extension's version, for the version line at the bottom of the page (up-wallet.html, renderVersion).
  if (bridge && bridge.info.version) window.__upwalletAppVersion = bridge.info.version;

  const ownFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : null;
    const o = init || {};
    const method = String(o.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url !== null && RPC_PROXY.has(url) && method === "POST" && bridge) {
      // ethers sends the body as bytes.
      const b = o.body;
      const body = b === undefined || b === null ? (input instanceof Request ? await input.text() : "")
        : typeof b === "string" ? b : b instanceof ArrayBuffer || ArrayBuffer.isView(b) ? new TextDecoder().decode(b) : String(b);
      let r;
      try { r = await bridge.call("rpc", { url, body }); } catch (e) { throw new TypeError("Failed to fetch"); }
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (typeof input !== "string" || !/^\.?\/?relay\//.test(url)) return ownFetch(input, init);
    if (!bridge) throw new TypeError("Failed to fetch");
    let r;
    try { r = await bridge.call("relay", { path: url.replace(/^\.?\//, ""), method, body: method === "POST" ? String(o.body ?? "") : undefined }); }
    catch (e) { throw new TypeError("Failed to fetch"); }
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  };

  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.protocol !== "chrome-extension:") { if (!a.target) a.target = "_blank"; return; }
    if (url.pathname === "/" + PAGE || url.pathname === "/") return;
    a.href = SITE + url.pathname.slice(1) + url.search + url.hash;
    a.target = "_blank"; a.rel = "noopener";
  }, true);

  // The request notification's click (up-wallet.html, attention()): the wallet comes to the front, wherever it
  // is open: its tab made active, or the window that holds the side panel or the wallet's own window focused.
  window.__upwalletFocus = () => (bridge ? bridge.call("focus").catch(() => window.focus()) : window.focus());
})();
