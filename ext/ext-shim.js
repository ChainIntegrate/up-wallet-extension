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

  const api = globalThis.chrome;
  const en = () => document.documentElement.lang === "en";

  // The request notification's click (up-wallet.html, attention()): the wallet comes to the front, wherever it
  // is open: its tab made active, or the window that holds the side panel or the wallet's own window focused.
  window.__upwalletFocus = async () => {
    try {
      const tab = await api.tabs.getCurrent();
      if (tab) { await api.tabs.update(tab.id, { active: true }); await api.windows.update(tab.windowId, { focused: true }); return; }
      const w = await api.windows.getCurrent();
      if (w) await api.windows.update(w.id, { focused: true });
    } catch (e) { window.focus(); }
  };

  // Chrome lets the user limit an extension's "Site access": without it the extension cannot reach the site
  // (the relay, the gas paid by the site), and its calls fail as blocked by CORS. Say so, with a button that
  // asks for it again.
  document.addEventListener("DOMContentLoaded", async () => {
    const origins = [SITE + "*"];
    let ok = true;
    try { ok = await api.permissions.contains({ origins }); } catch (e) { return; }
    if (ok) return;
    const box = document.createElement("div");
    box.id = "siteAccess";
    box.className = "setup-banner";
    const text = document.createElement("span");
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "small";
    const render = () => {
      text.textContent = en()
        ? "Chrome does not let UP Wallet reach the site (the extension's \"Site access\"): the gas paid by the site cannot be used."
        : "Chrome non lascia raggiungere il sito a UP Wallet (\"Accesso ai siti\" dell'estensione): il gas pagato dal sito non si può usare.";
      btn.textContent = en() ? "Allow" : "Consenti";
    };
    btn.addEventListener("click", async () => {
      try { if (await api.permissions.request({ origins })) location.reload(); } catch (e) { /* the user's choice */ }
    });
    render();
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    box.append(text, btn);
    const nav = document.getElementById("nav");
    if (nav) nav.parentNode.insertBefore(box, nav); else document.body.prepend(box);
  });
})();
