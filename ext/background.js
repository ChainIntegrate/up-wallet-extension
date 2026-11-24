// UP Wallet extension: the service worker.
// - The toolbar button opens the wallet (wallet.html, ext/host.js, which holds the sandboxed wallet page) in the
//   browser's side panel; its menu (right click) also opens it in a tab.
// - The injected wallet (phase 2): the sites the user connected (one by one, with Chrome's permission for that
//   site) get ext/inpage.js and ext/content.js; their calls arrive here on a port, with the site's origin from
//   Chrome. Reads, the account and the network are answered here; connecting and everything signed go to the
//   wallet page, which checks and confirms them as it did WalletConnect's requests, and then to the signing
//   window. With no wallet open, it opens in a window and the request waits for it.
importScripts("/chains.js");   // CHAINS, LUKSO_CHAIN, LUKSO_TESTNET_CHAIN: the networks' RPCs, for the reads
const api = globalThis.chrome;
const HOST = "wallet.html";
const NETS = [LUKSO_CHAIN, LUKSO_TESTNET_CHAIN, ...CHAINS];
const SITES = "dappSites";        // chrome.storage.local: the connected sites' origins
const STATE = "dappState";        // chrome.storage.session: { sessions: { origin: { chainId, account } }, chainId }
const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;   // https, no port (content-script match patterns take none)
const SCRIPTS = ["upw-content", "upw-inpage"];
// Signed or confirmed in the wallet; everything else that is not a read is refused here (4200).
const TO_WALLET = new Set(["eth_requestAccounts", "wallet_requestPermissions", "wallet_switchEthereumChain", "wallet_getCapabilities",
  "personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_sendTransaction"]);
const NEEDS_SESSION = new Set(["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_sendTransaction", "wallet_getCapabilities"]);
const READS = new Set(["eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_getBalance",
  "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByHash",
  "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas", "eth_getProof"]);
const MAX_QUEUE = 20;
// Review of 2026-11-24 (R1, R5): at most 5 requests of one site and 20 in all open at once (waiting for the
// wallet or in it), with the wallet open too; a request not answered in 10 minutes is refused; a request is
// dropped when its site's page goes (its port closes) or the wallet cannot open.
const PER_SITE = 5, MAX_OPEN = 20, EXPIRY_MS = 10 * 60 * 1000;
const err = (code, message) => ({ code, message });

// The toolbar button opens the side panel here, not by Chrome's panel behaviour: the click also gives this
// extension the tab for a moment (activeTab), so the site open in it is noted for "Connect the active tab's
// site" (Chrome does not grant it when the button opens the panel by itself, seen on 0.2.1).
api.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => null);
api.action.onClicked.addListener((tab) => {
  api.sidePanel.open({ windowId: tab.windowId }).catch(() => null);   // first, within the click
  let origin = null;
  try { origin = tab.url ? new URL(tab.url).origin : null; } catch (e) { /* no address */ }
  if (origin && ORIGIN.test(origin)) api.storage.session.set({ actionTab: { id: tab.id, origin, at: Date.now() } }).catch(() => null);
  else api.storage.session.remove("actionTab").catch(() => null);
});

async function openTab() {
  const url = api.runtime.getURL(HOST);
  const open = await api.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] }).catch(() => []);
  const ctx = open.find((c) => c.tabId >= 0);
  if (ctx) { await api.tabs.update(ctx.tabId, { active: true }); await api.windows.update(ctx.windowId, { focused: true }); }
  else await api.tabs.create({ url });
}

// ---- the connected sites
async function getSites() { return (await api.storage.local.get(SITES))[SITES] || []; }
async function getState() { const s = (await api.storage.session.get(STATE))[STATE] || {}; return { sessions: s.sessions || {}, chainId: s.chainId || 42 }; }
async function setState(s) { await api.storage.session.set({ [STATE]: s }); }
async function syncScripts(sites) {
  const have = await api.scripting.getRegisteredContentScripts({ ids: SCRIPTS }).catch(() => []);
  if (have.length) await api.scripting.unregisterContentScripts({ ids: have.map((x) => x.id) }).catch(() => null);
  if (!sites.length) return;
  const matches = sites.map((o) => o + "/*");
  await api.scripting.registerContentScripts([
    { id: "upw-content", js: ["ext/content.js"], matches, runAt: "document_start", allFrames: false, persistAcrossSessions: true },
    { id: "upw-inpage", js: ["ext/inpage.js"], matches, runAt: "document_start", allFrames: false, world: "MAIN", persistAcrossSessions: true },
  ]);
}
async function addSite(origin, tabId) {
  if (!ORIGIN.test(origin)) throw err(-32602, "only https sites can be connected");
  if (!(await api.permissions.contains({ origins: [origin + "/*"] }))) throw err(4100, "Chrome did not give access to this site");
  const sites = await getSites();
  if (!sites.includes(origin)) { sites.push(origin); await api.storage.local.set({ [SITES]: sites }); }
  await syncScripts(sites);
  // The page already open gets the wallet at once (a dApp that looked for wallets before may need a reload).
  if (typeof tabId === "number") {
    await api.scripting.executeScript({ target: { tabId }, files: ["ext/content.js"] }).catch(() => null);
    await api.scripting.executeScript({ target: { tabId }, files: ["ext/inpage.js"], world: "MAIN" }).catch(() => null);
  }
  return sites;
}
async function removeSite(origin) {
  const sites = (await getSites()).filter((o) => o !== origin);
  await api.storage.local.set({ [SITES]: sites });
  await syncScripts(sites);
  await endSession(origin);
  await api.permissions.remove({ origins: [origin + "/*"] }).catch(() => null);
  for (const p of dappPorts) if (p.origin === origin) { try { p.disconnect(); } catch (e) { /* gone */ } dappPorts.delete(p); }
  return sites;
}
api.permissions.onRemoved.addListener(async (p) => {
  for (const o of p.origins || []) { const origin = o.replace(/\/\*$/, ""); if ((await getSites()).includes(origin)) await removeSite(origin); }
});
async function endSession(origin) {
  const st = await getState();
  if (!st.sessions[origin]) return;
  delete st.sessions[origin];
  await setState(st);
  toSite(origin, "accountsChanged", []);
}

// ---- the dApps' ports
const dappPorts = new Set();
function toSite(origin, event, data) { for (const p of dappPorts) if (p.origin === origin) { try { p.postMessage({ event, data }); } catch (e) { /* gone */ } } }
const hex = (id) => "0x" + Number(id).toString(16);

async function rpc(chainId, method, params) {
  const net = NETS.find((x) => x.chainId === chainId);
  if (!net) throw err(4901, "network not available");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(net.rpc, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw { code: j.error.code || -32603, message: String(j.error.message || "error"), data: j.error.data };
    return j.result;
  } catch (e) { throw e && e.code ? e : err(-32603, "the network's RPC did not answer"); } finally { clearTimeout(timer); }
}

async function onDapp(port, m) {
  if (!m || typeof m.id !== "number" || typeof m.method !== "string") return;
  const reply = (x) => { try { port.postMessage({ id: m.id, ...x }); } catch (e) { /* the page closed */ } };
  try {
    const origin = port.origin;
    if (!(await getSites()).includes(origin)) return reply({ error: err(4100, "This site is not connected to UP Wallet.") });
    const st = await getState();
    const s = st.sessions[origin];
    const chainId = s ? s.chainId : st.chainId;
    const params = Array.isArray(m.params) ? m.params : [];
    switch (m.method) {
      case "eth_chainId": return reply({ result: hex(chainId) });
      case "net_version": return reply({ result: String(chainId) });
      case "eth_accounts": return reply({ result: s ? [s.account] : [] });
      case "eth_coinbase": return reply({ result: s ? s.account : null });
      case "wallet_getPermissions": return reply({ result: s ? [{ parentCapability: "eth_accounts" }] : [] });
      case "wallet_revokePermissions": { await endSession(origin); toWallet({ origin, method: "upwallet_siteDisconnected", params: [] }, null); return reply({ result: null }); }
      case "eth_requestAccounts": if (s) return reply({ result: [s.account] }); break;
      case "wallet_requestPermissions": if (s) return reply({ result: [{ parentCapability: "eth_accounts" }] }); break;
      case "wallet_addEthereumChain": {
        if (params[0] && Number(params[0].chainId) === chainId) return reply({ result: null });
        // 4901, not 4001: wagmi treats 4001 as a refused connection (see ext/dapp-kit.js).
        return reply({ error: err(4901, "UP Wallet uses the network chosen in the wallet.") });
      }
    }
    if (READS.has(m.method)) return reply({ result: await rpc(chainId, m.method, params) });
    if (!TO_WALLET.has(m.method)) return reply({ error: err(4200, `${m.method} is not supported by UP Wallet`) });
    if (NEEDS_SESSION.has(m.method) && !s) return reply({ error: err(4100, "Connect UP Wallet first (eth_requestAccounts).") });
    toWallet({ origin, method: m.method, params }, reply, port);
  } catch (e) { reply({ error: e && typeof e.code === "number" ? e : err(-32603, String((e && e.message) || e)) }); }
}

// ---- the wallet (its hosts: the side panel, a tab, or the window opened for a request)
const hosts = [];                 // ports of the open wallets whose page is ready; the last one gets the requests
const starting = new Set();       // wallets open whose page is not ready yet
const queue = [];                 // waiting for a wallet: { n, origin, method, params, reply }
const inflight = new Map();       // n → { reply, host, origin, port, at }
let nextN = 0, opening = 0, openedWin = null;
const currentHost = () => hosts[hosts.length - 1] || null;
function toWallet(r, reply, port = null) {
  const item = { n: ++nextN, ...r, reply, port, at: Date.now() };
  if (reply) {
    const open = [...inflight.values(), ...queue];
    if (open.filter((x) => x.origin === r.origin).length >= PER_SITE) { reply({ error: err(-32002, "Too many requests of this site are open in UP Wallet: answer them first.") }); return; }
    if (open.length >= MAX_OPEN) { reply({ error: err(-32002, "Too many requests are open in UP Wallet.") }); return; }
  }
  const h = currentHost();
  if (h) return send(h, item);
  if (!reply) return;   // a notice for the wallet page: nobody to tell
  if (queue.length >= MAX_QUEUE) { reply({ error: err(4001, "Too many requests waiting for the wallet.") }); return; }
  queue.push(item);
  if (!starting.size) openWallet();
}
// A request the site can no longer get an answer for (its page closed, too old): refused to the site if it is
// still there, dropped from the wallet page, whose signing then stops (ext/host.js refuses "sign" for it).
function cancel(n, why) {
  const f = inflight.get(n);
  if (!f) return;
  inflight.delete(n);
  f.reply({ error: err(4001, why) });
  try { f.host.postMessage({ type: "cancel", n }); } catch (e) { /* the wallet closed */ }
}
setInterval(() => {
  const old = Date.now() - EXPIRY_MS;
  for (const [n, f] of inflight) if (f.at < old) cancel(n, "The request expired in UP Wallet (10 minutes).");
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at < old) { const it = queue.splice(i, 1)[0]; if (it.reply) it.reply({ error: err(4001, "The request expired waiting for UP Wallet.") }); }
}, 30000);
function send(h, item) {
  if (item.reply) inflight.set(item.n, { reply: item.reply, host: h, origin: item.origin, port: item.port, at: item.at });
  try { h.postMessage({ type: "request", n: item.n, origin: item.origin, method: item.method, params: item.params }); }
  catch (e) { inflight.delete(item.n); if (item.reply) item.reply({ error: err(4001, "The wallet closed.") }); }
}
// A request with no wallet open: the wallet opens in a window at the top right, as the signing window does.
async function openWallet() {
  if (Date.now() - opening < 15000) return;
  opening = Date.now();
  const cur = await api.windows.getLastFocused().catch(() => null);
  const W = 460, H = cur && cur.height ? Math.min(820, Math.max(500, cur.height - 90)) : 760;
  const pos = cur && cur.left != null ? { left: Math.max(0, cur.left + Math.max(0, cur.width - W - 12)), top: Math.max(0, cur.top + 72) } : {};
  const w = await api.windows.create({ url: api.runtime.getURL(HOST + "?dapp=1"), type: "popup", width: W, height: H, focused: true, ...pos }).catch(() => null);
  openedWin = w ? w.id : null;
  // The window could not open: the waiting requests are refused at once rather than left hanging (R5).
  if (!w && !currentHost() && !starting.size) { opening = 0; for (const it of queue.splice(0)) if (it.reply) it.reply({ error: err(4001, "UP Wallet could not open its window.") }); }
}
api.windows.onRemoved.addListener((id) => {
  // The window opened for a request closed before its wallet took it: the waiting requests are refused.
  if (id !== openedWin) return;
  openedWin = null; opening = 0;
  if (currentHost()) return;
  for (const it of queue.splice(0)) if (it.reply) it.reply({ error: err(4001, "User rejected the request.") });
});

async function onHost(port, m) {
  if (!m || typeof m !== "object") return;
  const reply = (x) => { try { port.postMessage({ type: "reply", c: m.c, ...x }); } catch (e) { /* closed */ } };
  try {
    switch (m.type) {
      case "listen": {
        // The wallet page is ready (its checks set up): it gets the requests, and those waiting go to it.
        const i = hosts.indexOf(port);
        if (i >= 0) hosts.splice(i, 1);
        starting.delete(port);
        hosts.push(port);
        for (const it of queue.splice(0)) send(port, it);
        return;
      }
      case "answer": {
        const f = inflight.get(m.n);
        if (!f || f.host !== port) return;
        inflight.delete(m.n);
        return f.reply(m.error ? { error: err(Number(m.error.code) || -32603, String(m.error.message || "error").slice(0, 500)) } : { result: m.result });
      }
      case "session": {
        if (!(await getSites()).includes(m.origin)) return;
        if (m.end) { await endSession(m.origin); return; }
        if (!/^0x[0-9a-fA-F]{40}$/.test(m.account || "") || !(Number(m.chainId) > 0)) return;
        const st = await getState();
        st.sessions[m.origin] = { chainId: Number(m.chainId), account: m.account };
        await setState(st);
        toSite(m.origin, "connect", { chainId: hex(m.chainId) });
        toSite(m.origin, "chainChanged", hex(m.chainId));
        toSite(m.origin, "accountsChanged", [m.account]);
        return;
      }
      case "event": {
        if (!["chainChanged", "accountsChanged"].includes(m.name) || !(await getSites()).includes(m.origin)) return;
        return toSite(m.origin, m.name, m.data);
      }
      case "net": {
        // The wallet's network: what a site with no session reads as its network.
        if (!(Number(m.chainId) > 0)) return;
        const st = await getState();
        if (st.chainId === Number(m.chainId)) return;
        st.chainId = Number(m.chainId);
        await setState(st);
        for (const o of await getSites()) if (!st.sessions[o]) toSite(o, "chainChanged", hex(st.chainId));
        return;
      }
      case "state": { const st = await getState(); return reply({ result: { sites: await getSites(), sessions: st.sessions, chainId: st.chainId } }); }
      case "add-site": return reply({ result: await addSite(String(m.origin || ""), m.tabId) });
      case "remove-site": return reply({ result: await removeSite(String(m.origin || "")) });
    }
  } catch (e) { reply({ error: e && typeof e.code === "number" ? e : err(-32603, String((e && e.message) || e)) }); }
}

api.runtime.onConnect.addListener((port) => {
  const s = port.sender || {};
  if (port.name === "dapp") {
    // A connected site's page: its origin from Chrome; its top frame only.
    if (s.frameId !== 0 || !s.tab || !ORIGIN.test(s.origin || "")) { port.disconnect(); return; }
    port.origin = s.origin;
    dappPorts.add(port);
    port.onMessage.addListener((m) => onDapp(port, m));
    // The site's page went (closed, reloaded, navigated): its open requests are dropped (R5). Its pings
    // (ext/content.js, every 20 s while a call is open) keep this worker alive meanwhile (R2).
    port.onDisconnect.addListener(() => {
      dappPorts.delete(port);
      for (const [n, f] of inflight) if (f.port === port) cancel(n, "The site's page closed.");
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].port === port) queue.splice(i, 1);
    });
    return;
  }
  if (port.name === "host") {
    if (s.id !== api.runtime.id || !String(s.url || "").startsWith(api.runtime.getURL(HOST))) { port.disconnect(); return; }
    starting.add(port);
    port.onMessage.addListener((m) => onHost(port, m));
    port.onDisconnect.addListener(() => {
      starting.delete(port);
      const i = hosts.indexOf(port);
      if (i >= 0) hosts.splice(i, 1);
      // The wallet closed with requests not answered: refused, as a wallet does when its window closes.
      for (const [n, f] of inflight) if (f.host === port) { inflight.delete(n); f.reply({ error: err(4001, "User rejected the request.") }); }
    });
  }
});

const resync = () => getSites().then(syncScripts).catch(() => null);
api.runtime.onStartup.addListener(resync);
api.runtime.onInstalled.addListener(() => {
  const it = /^it\b/i.test(api.i18n.getUILanguage() || "");
  api.contextMenus.create({ id: "open-tab", title: it ? "Apri UP Wallet in una scheda" : "Open UP Wallet in a tab", contexts: ["action"] }, () => void api.runtime.lastError);
  resync();
});
api.contextMenus.onClicked.addListener((info) => { if (info.menuItemId === "open-tab") openTab(); });
