// UP Wallet extension: the differences between the extension and the site page, loaded before the page's own
// scripts.
// - The relay service lives on the site: its relative URLs ("relay/...") are sent there. The extension has the
//   site in its host permissions; the relay and the sponsor service accept the extension's origin.
// - Links to the site's other pages, which the extension does not contain, open on the site in a new tab.
(function () {
  "use strict";
  const SITE = "__SITE__";   // filled in by scripts/build.js from ext-config.json
  const PAGE = "__PAGE__";
  document.documentElement.classList.add("in-extension");
  window.__upwalletSite = SITE;
  // The extension's version, for the version line at the bottom of the page (up-wallet.html, renderVersion).
  try { window.__upwalletAppVersion = globalThis.chrome.runtime.getManifest().version; } catch (e) { /* not in the extension */ }

  const toSite = (u) => SITE + u.replace(/^\.?\//, "");
  const ownFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === "string" && /^\.?\/?relay\//.test(input)) input = toSite(input);
    return ownFetch(input, init);
  };

  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) { if (!a.target) a.target = "_blank"; return; }
    if (url.pathname === "/" + PAGE || url.pathname === "/") return;
    a.href = toSite(url.pathname.slice(1)) + url.search + url.hash;
    a.target = "_blank"; a.rel = "noopener";
  }, true);
})();
