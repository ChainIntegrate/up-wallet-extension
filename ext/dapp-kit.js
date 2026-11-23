// UP Wallet extension (phase 2): the connected sites inside the wallet page, in place of WalletConnect.
// The page's own WalletConnect code (getWalletKit, its proposal and request handlers, with every check and the
// request window) gets this object instead of the WalletKit client: a site's "connect" (eth_requestAccounts) is a
// session proposal, its requests are session requests, and the page's answers go back to the site through the
// host and the service worker. The site's origin is Chrome's; the session is the UP chosen in the page, on its
// network, as with WalletConnect. Also here: panel 4, the connected sites (connect the active tab's site,
// disconnect one), and the page's texts that named WalletConnect.
(function () {
  "use strict";
  const bridge = window.__upwBridge;
  if (!bridge) return;
  const en = () => document.documentElement.lang === "en";
  const L = (it, eng) => (en() ? eng : it);
  const METHODS = ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4", "eth_signTypedData", "eth_signTypedData_v3", "eth_sign", "wallet_switchEthereumChain", "wallet_getCapabilities"];
  const EVENTS = ["accountsChanged", "chainChanged"];
  const WAIT_MS = 60000;
  const handlers = {};
  const sessions = {};          // topic → a session in WalletKit's shape
  const proposals = new Map();  // request number → { origin, method }
  const switching = new Set();    // request numbers of wallet_switchEthereumChain sent to the page
  const queue = [];             // requests before the page's checks are set up
  let sites = [], kitReady = false, note = "";
  const topicOf = (o) => "dapp:" + o;
  const originOf = (topic) => String(topic).replace(/^dapp:/, "");
  const hostOf = (o) => { try { return new URL(o).host; } catch (e) { return String(o); } };
  const answer = (n, result) => bridge.call("dapp-answer", { n, result }).catch(() => null);
  const refuse = (n, code, message) => bridge.call("dapp-answer", { n, error: { code, message: String(message || "error") } }).catch(() => null);
  const emit = (name, ev) => { for (const f of handlers[name] || []) { try { f(ev); } catch (e) { /* the page's own error */ } } };
  /* global compliance, getWalletKit, NETWORKS, log, applyI18n, I18N, PHONE_I18N */
  const pageLog = (text, cls) => { if (typeof log === "function") log(text, cls); };

  function session(origin, chainId, account) {
    const caip = `eip155:${chainId}`;
    return { topic: topicOf(origin), peer: { metadata: { name: hostOf(origin), url: origin, description: "", icons: [] } },
      namespaces: { eip155: { chains: [caip], accounts: [`${caip}:${account}`], methods: METHODS, events: EVENTS } } };
  }

  // ---- the WalletKit client the page starts (getWalletKit)
  const kit = {
    on(name, f) { (handlers[name] = handlers[name] || []).push(f); return kit; },
    off(name, f) { handlers[name] = (handlers[name] || []).filter((g) => g !== f); return kit; },
    getActiveSessions() { return sessions; },
    async pair() { throw new Error(L("Nell'estensione niente WalletConnect: collega il sito dal pannello 4.", "No WalletConnect in the extension: connect the site from panel 4.")); },
    async approveSession({ id, namespaces }) {
      const p = proposals.get(id);
      if (!p) throw new Error("no such request");
      proposals.delete(id);
      const [, chainId, account] = String((namespaces && namespaces.eip155 && namespaces.eip155.accounts || [])[0] || "").split(":");
      const s = session(p.origin, Number(chainId), account);
      sessions[s.topic] = s;
      await bridge.call("dapp-session", { origin: p.origin, chainId: Number(chainId), account });
      await answer(id, p.method === "wallet_requestPermissions" ? [{ parentCapability: "eth_accounts" }] : [account]);
      renderSites();
      return s;
    },
    async rejectSession({ id, reason }) {
      if (!proposals.has(id)) return;
      proposals.delete(id);
      await refuse(id, 4001, (reason && reason.message) || "User rejected the request.");
    },
    async respondSessionRequest({ response }) {
      if (!response) return;
      // Another network refused: the page answers 4001, right for WalletConnect. For an injected wallet 4001
      // means "the user rejected", and wagmi's connect (Aave and many dApps) then drops the whole connection;
      // 4901 (not connected to that chain) lets it go on, on the wallet's network (seen on app.aave.com, 0.2.3).
      if (switching.delete(response.id) && response.error && (response.error.code === 4001 || response.error.code === 5000)) {
        await refuse(response.id, 4901, response.error.message || "UP Wallet is on another network: choose it in the wallet.");
        return;
      }
      // WalletConnect's "rejected" (5000) is EIP-1193's 4001 for an injected wallet.
      if (response.error) await refuse(response.id, response.error.code === 5000 ? 4001 : response.error.code, response.error.message);
      else await answer(response.id, response.result);
    },
    async disconnectSession({ topic }) {
      if (!sessions[topic]) return;
      delete sessions[topic];
      await bridge.call("dapp-session", { origin: originOf(topic), end: true }).catch(() => null);
      renderSites();
    },
    async emitSessionEvent({ topic, event }) {
      if (!sessions[topic] || !event) return;
      await bridge.call("dapp-event", { origin: originOf(topic), name: event.name, data: event.data });
    },
  };
  kit.removeListener = kit.off;
  const SDK = { USER_REJECTED: { code: 5000, message: "User rejected." }, USER_DISCONNECTED: { code: 6000, message: "User disconnected." }, UNSUPPORTED_CHAINS: { code: 5100, message: "Unsupported chains." } };
  window.WalletKitBundle = Object.freeze({
    Core: function Core() {},
    WalletKit: Object.freeze({ init: async () => kit }),
    getSdkError: (k) => SDK[k] || { code: 5000, message: String(k) },
    // The page offers one account on one network: that is the session.
    buildApprovedNamespaces: ({ supportedNamespaces }) => {
      const e = supportedNamespaces.eip155;
      return { eip155: { chains: e.chains, methods: e.methods, events: e.events, accounts: e.accounts } };
    },
  });

  // ---- the sites' requests
  const pageNet = () => {
    const el = document.getElementById("network");
    const n = el && typeof NETWORKS !== "undefined" ? NETWORKS.find((x) => x.key === el.value) : null;
    return n && n.chainId ? n : null;
  };
  function deliver(r) {
    const { n, origin, method, params } = r;
    const topic = topicOf(origin);
    if (method === "upwallet_siteDisconnected") {
      if (sessions[topic]) { delete sessions[topic]; emit("session_delete", { topic }); }
      renderSites();
      return;
    }
    // The origin comes from the browser: the site is the one named (WalletConnect's "VALID").
    const verifyContext = { verified: { validation: "VALID", origin, verifyUrl: "" } };
    if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
      proposals.set(n, { origin, method });
      const net = pageNet();
      emit("session_proposal", { id: n, verifyContext, params: { id: n, expiry: 0, relays: [], requiredNamespaces: {},
        optionalNamespaces: { eip155: { chains: net ? [`eip155:${net.chainId}`] : [], methods: METHODS, events: EVENTS } },
        proposer: { publicKey: "", metadata: { name: hostOf(origin), url: origin, description: "", icons: [] } } } });
      return;
    }
    const s = sessions[topic];
    if (!s) { refuse(n, 4100, "Connect UP Wallet first."); return; }
    if (method === "wallet_switchEthereumChain") switching.add(n);
    emit("session_request", { topic, id: n, verifyContext, params: { request: { method, params }, chainId: s.namespaces.eip155.chains[0] } });
  }
  bridge.on("dapp-request", (r) => {
    if (!r || typeof r.n !== "number") return;
    if (kitReady) { deliver(r); return; }
    // The page's checks are not set up yet (no UP or network chosen, or the check of panel 3 not green):
    // the request waits a minute for them.
    const item = { r, timer: setTimeout(() => {
      const i = queue.indexOf(item);
      if (i < 0) return;
      queue.splice(i, 1);
      refuse(r.n, 4100, "UP Wallet is not ready: choose the UP and the network in the wallet (the check of panel 3 must be green).");
      pageLog(L(`${hostOf(r.origin)}: richiesta rifiutata, il wallet non era pronto (la verifica del pannello 3 deve essere verde).`,
        `${hostOf(r.origin)}: request refused, the wallet was not ready (the check of panel 3 must be green).`), "line-warn");
    }, WAIT_MS) };
    queue.push(item);
    pageLog(L(`${hostOf(r.origin)} ha mandato una richiesta: arriva quando la verifica del pannello 3 è verde.`,
      `${hostOf(r.origin)} sent a request: it comes once the check of panel 3 is green.`), "line-warn");
  });
  // The kit starts with the page's checks, as WalletConnect's client does: getWalletKit closes the sessions
  // that present another UP or network than the page's.
  async function startKit() {
    for (;;) {
      if (typeof compliance !== "undefined" && compliance && typeof getWalletKit === "function") {
        try { await getWalletKit(); kitReady = true; break; } catch (e) { /* tried again */ }
      }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    for (const item of queue.splice(0)) { clearTimeout(item.timer); deliver(item.r); }
    renderSites();
  }

  // ---- panel 4: the connected sites
  function renderSites() {
    const panel = document.querySelector('.panel[data-view="dapp"]');
    if (!panel) return;
    let box = panel.querySelector(".upw-dapps");
    if (!box) { box = document.createElement("div"); box.className = "upw-dapps"; panel.appendChild(box); }
    box.textContent = "";
    const add = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; box.appendChild(e); return e; };
    add("h2", L("4 · Siti collegati (dApp)", "4 · Connected sites (dApps)"));
    add("div", L("UP Wallet si offre solo ai siti che colleghi qui, uno per uno: Chrome chiede l'accesso a quel sito soltanto. Sul sito premi \"Connect\" e scegli \"UP Wallet\". Il sito vede la UP sulla rete scelta qui; le sue richieste arrivano in questa pagina, con gli stessi controlli, e si firmano nella finestra di firma.",
      "UP Wallet offers itself only to the sites you connect here, one by one: Chrome asks for access to that site only. On the site press \"Connect\" and choose \"UP Wallet\". The site sees the UP on the network chosen here; its requests come to this page, with the same checks, and are signed in the signing window."), "note");
    const btn = add("button", L("Collega il sito della scheda attiva", "Connect the active tab's site"));
    btn.type = "button"; btn.id = "upwConnectSite";
    btn.addEventListener("click", async () => {
      btn.disabled = true; note = "";
      try {
        const r = await bridge.call("dapp-connect");
        sites = r.sites || sites;
        note = L(`Collegato: ${r.origin}. Sul sito premi "Connect" e scegli "UP Wallet" (se non c'è, ricarica la pagina del sito).`, `Connected: ${r.origin}. On the site press "Connect" and choose "UP Wallet" (if it is not there, reload the site's page).`);
      } catch (e) { note = e.message || String(e); }
      renderSites();
    });
    if (note) add("div", note, "note").style.marginTop = "8px";
    if (!sites.length) { add("div", L("Nessun sito collegato.", "No site connected."), "note").style.marginTop = "8px"; return; }
    const list = add("div"); list.style.marginTop = "8px";
    for (const o of sites) {
      const row = document.createElement("div");
      row.className = "status-box"; row.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:6px;";
      const s = sessions[topicOf(o)];
      const text = document.createElement("span");
      text.style.overflowWrap = "anywhere";
      if (s) { const [, cid, acc] = s.namespaces.eip155.accounts[0].split(":"); text.textContent = L(`✅ ${o} — usa la UP ${acc} su chainId ${cid}`, `✅ ${o} — uses the UP ${acc} on chainId ${cid}`); }
      else text.textContent = L(`${o} — non connesso alla UP ora`, `${o} — not connected to the UP now`);
      const b = document.createElement("button");
      b.type = "button"; b.className = "secondary small"; b.textContent = L("Scollega", "Disconnect");
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { sites = await bridge.call("dapp-disconnect", { origin: o }); delete sessions[topicOf(o)]; note = ""; } catch (e) { note = e.message || String(e); }
        renderSites();
      });
      row.append(text, b);
      list.appendChild(row);
    }
  }

  // ---- the page's texts that named WalletConnect, as COMPUTER_PHRASES does for the key
  const PHRASES = {
    it: [
      ["usi le dApp con WalletConnect", "usi le dApp dal browser"],
      ["Usa una dApp con la UP (WalletConnect)", "Usa una dApp con la UP, dal browser"],
      ["Verifica del dominio WalletConnect: VALID.", "Sito: l'indirizzo lo dà il browser."],
      ["— verifica del dominio: VALID", "— indirizzo dato dal browser"],
      ["che si collegano con WalletConnect", "che si collegano a un wallet del browser"],
      ["sessioni WalletConnect", "sessioni con i siti"],
      ["Ricollega la dApp.", "Ricollega la dApp dal sito."],
    ],
    en: [
      ["use dApps with WalletConnect", "use dApps from the browser"],
      ["Use a dApp with the UP (WalletConnect)", "Use a dApp with the UP, from the browser"],
      ["WalletConnect domain verification: VALID.", "Site: its address is given by the browser."],
      ["— domain verification: VALID", "— address given by the browser"],
      ["that connect with WalletConnect", "that connect to a browser wallet"],
      ["WalletConnect session(s)", "session(s) with sites"],
      ["WalletConnect sessions", "sessions with sites"],
      ["Connect the dApp again.", "Connect the dApp again from the site."],
    ],
  };
  // The footer's WalletConnect notice: the extension no longer contains it.
  const WC_NOTICE = /<br><span style="font-size:11\.5px;">WalletConnect: Portions[\s\S]*?<\/span>/;
  const swap = (s) => (typeof s === "string" ? PHRASES[en() ? "en" : "it"].reduce((x, [a, b]) => x.split(a).join(b), s).replace(WC_NOTICE, "") : s);

  document.addEventListener("DOMContentLoaded", async () => {
    // The page's t() (a global function of its script) through the phrases above; the texts shown again.
    if (typeof window.t === "function") {
      const own = window.t;
      window.t = function (key, vars) { return swap(own(key, vars)); };
      try { if (typeof applyI18n === "function") applyI18n(); } catch (e) { /* shown at the next language change */ }
    }
    new MutationObserver(() => renderSites()).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    // The page's network, for the sites with no session (what they read as the network).
    const el = document.getElementById("network");
    const tell = () => { const n = pageNet(); if (n) bridge.call("dapp-net", { chainId: n.chainId }).catch(() => null); };
    if (el) el.addEventListener("change", tell);
    try {
      const st = await bridge.call("dapp-listen");
      sites = st.sites || [];
      for (const [o, x] of Object.entries(st.sessions || {})) sessions[topicOf(o)] = session(o, x.chainId, x.account);
    } catch (e) { /* the extension restarting: the list comes at the next change */ }
    tell();
    renderSites();
    startKit();
  });
})();
