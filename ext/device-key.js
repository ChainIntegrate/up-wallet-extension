// UP Wallet extension: this computer's key as the page's signing wallet, instead of MetaMask.
// The key is a controller of the UP (authorized from the site's Backup page with no admin permissions). It is
// kept and used only by the extension's signing window (signer.html): this file never sees it. For every
// signature it opens that window with the request; the window shows what is signed, asks for the passkey or
// the password, and answers with the signature. Transactions are prepared here (nonce, gas, fees from the
// network's RPC), signed there, and sent here. Announced to the page through EIP-6963, as a browser wallet is:
// the page's checks and confirmation window are unchanged.
// Bundled by scripts/build.js (esbuild) into dist/ext/device-key.js; loaded after chains.js and ethers.
const api = globalThis.chrome;
document.documentElement.classList.add("computer-key");
const SITE = window.__upwalletSite || "https://crosschain-lukso.chainintegrate.it/";
const STORE = "deviceKey";
const ACK_KEY = "upwallet.computerkey.ack";
const ACK_VERSION = "1";
const INFO = Object.freeze({
  uuid: "3f0c2a8e-9d41-4b7a-8c55-1e6b2f7d9a04",
  name: "Computer key (UP Wallet)",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='4' y='6' width='24' height='16' rx='2' fill='%233b82f6'/%3E%3Crect x='10' y='24' width='12' height='3' rx='1' fill='%233b82f6'/%3E%3C/svg%3E",
  rdns: "it.chainintegrate.upwallet.computerkey",
});

const en = () => document.documentElement.lang === "en";
const $ = (id) => document.getElementById(id);
const T = {
  connect: () => (en() ? "Use this computer's key" : "Usa la chiave del computer"),
  title: () => (en() ? "This computer" : "Questo computer"),
  none: () => (en() ? "No key yet: it is created when you press \"Use this computer's key\" (with a passkey, or a password)." : "Nessuna chiave: si crea quando premi \"Usa la chiave del computer\" (con una passkey, o una password)."),
  addr: (a, m) => (en() ? `Computer key: ${a}` : `Chiave del computer: ${a}`) + (m ? ` · ${m}` : ""),
  authHint: () => (en()
    ? "To use it, authorize it once on each network where the UP exists: the site's Backup page, \"Authorize a phone\" (it works for this computer's key too), signed by an admin controller of the UP (for example in MetaMask). A lost computer or a removed extension is revoked from the same page."
    : "Per usarla, autorizzala una volta su ogni rete dove esiste la UP: pagina Backup del sito, \"Autorizza un telefono\" (vale anche per la chiave del computer), firmato da un controller amministratore della UP (per esempio in MetaMask). Un computer perso o l'estensione tolta si revocano dalla stessa pagina."),
  copy: () => (en() ? "Copy address" : "Copia indirizzo"),
  copied: () => (en() ? "Copied" : "Copiato"),
  open: () => (en() ? "Open the Backup page" : "Apri la pagina Backup"),
  remove: () => (en() ? "Delete the key" : "Elimina la chiave"),
  noSite: () => (en() ? "No network chosen in the page." : "Nessuna rete scelta nella pagina."),
  warnTitle: () => (en() ? "UP Wallet for the browser: experimental wallet" : "UP Wallet per il browser: wallet sperimentale"),
  warn: () => (en()
    ? ["This extension is the wallet: it keeps a signing key on this computer, encrypted, opened with a passkey or a password for each signature.",
       "This is the maintainer's own experimental wallet. Its risk is higher than signing in an external wallet: whoever can use this computer and pass its passkey (or knows the password) can sign with the key, within the permissions you give it on the UP, which include moving its funds.",
       "Use it only if you understand how a Universal Profile's controllers and permissions work, with small amounts, at your own risk. Free software under the MIT license, with no warranty.",
       "The key never leaves the extension and has no copy: if you lose the computer or remove the extension, revoke it from another controller of the UP (site, Backup page)."]
    : ["Questa estensione è il wallet: tiene una chiave di firma su questo computer, cifrata, aperta con una passkey o una password a ogni firma.",
       "È il wallet sperimentale del manutentore. Il rischio è più alto che firmare in un wallet esterno: chi può usare questo computer e passare la sua passkey (o conosce la password) può firmare con la chiave, nei limiti dei permessi che le dai sulla UP, che comprendono muoverne i fondi.",
       "Usalo solo se sai come funzionano i controller e i permessi di una Universal Profile, con importi piccoli, a tuo rischio. Software libero con licenza MIT, senza garanzie.",
       "La chiave non esce mai dall'estensione e non ha copie: se perdi il computer o togli l'estensione, revocala da un altro controller della UP (sito, pagina Backup)."]),
  warnOk: () => (en() ? "I understand, continue" : "Ho capito, continua"),
};

// ---- the page's network
function allNets() { return typeof NETWORKS !== "undefined" ? NETWORKS : []; }
function knownNet() {
  const el = $("network");
  const c = el ? allNets().find((x) => x.key === el.value) : null;
  return c && c.chainId ? c : null;
}
const customIds = new Map();
async function customNet() {
  const el = $("network"), r = $("customRpc");
  const rpc = el && el.value === "custom" && r ? r.value.trim() : "";
  if (!/^https?:\/\/\S+$/.test(rpc)) return null;
  if (!customIds.has(rpc)) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: ctl.signal });
      const id = Number(BigInt((await res.json()).result));
      if (!(id > 0)) return null;
      customIds.set(rpc, id);
    } catch (e) { return null; } finally { clearTimeout(timer); }
  }
  return { key: "custom", name: en() ? "custom RPC" : "RPC personalizzato", chainId: customIds.get(rpc), rpc, currency: "" };
}
async function currentNet() { return knownNet() || customNet(); }
const rpcs = new Map();
function rpcFor(net) {
  const k = `${net.chainId}|${net.rpc}`;
  if (!rpcs.has(k)) rpcs.set(k, new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true, batchMaxCount: 1 }));
  return rpcs.get(k);
}

const rpcError = (code, message) => Object.assign(new Error(message), { code });

// ---- the key's address (the key itself stays in the signing window)
let address = null, method = null;
async function status() {
  const k = (await api.storage.local.get(STORE))[STORE];
  address = k && k.address ? ethers.getAddress(k.address) : null;
  method = k ? k.method : null;
  return { exists: !!address, address, method };
}
const sameAddr = (a) => typeof a === "string" && ethers.isAddress(a) && address && ethers.getAddress(a) === address;

// One request to the signing window: it answers with { result } or { error }; closing it rejects.
async function ask(req) {
  const id = crypto.randomUUID();
  await api.storage.session.set({ ["req:" + id]: { ...req, site: req.site || null, lang: en() ? "en" : "it" } });
  try {
    return await new Promise((ok, no) => {
      let winId = null;
      const done = (fn, v) => { api.runtime.onMessage.removeListener(onMsg); api.windows.onRemoved.removeListener(onGone); fn(v); };
      const onMsg = (m) => {
        if (!m || m.type !== "signer-result" || m.id !== id) return;
        if (m.error) done(no, rpcError(m.error.code || -32603, m.error.message || "error")); else done(ok, m.result);
      };
      const onGone = (w) => { if (w === winId) done(no, rpcError(4001, "User rejected the request.")); };
      api.runtime.onMessage.addListener(onMsg);
      api.windows.onRemoved.addListener(onGone);
      const w = Math.round(window.screenX + (window.outerWidth - 460) / 2), t = Math.round(window.screenY + 80);
      api.windows.create({ url: api.runtime.getURL("ext/signer.html#" + encodeURIComponent(id)), type: "popup", width: 460, height: 640, left: Math.max(0, w), top: Math.max(0, t) })
        .then((win) => { winId = win.id; })
        .catch((e) => done(no, rpcError(-32603, e.message)));
    });
  } finally { api.storage.session.remove("req:" + id).catch(() => null); }
}
// The dApp asking, for the signing window's header: the WalletConnect session the page's request window is for.
const site = () => (typeof window.__upwalletRequestSite === "string" ? window.__upwalletRequestSite.slice(0, 200) : null);

async function ensureKey() {
  const s = await status();
  if (s.exists) return address;
  await acknowledged();
  await ask({ kind: "create" });
  await status();
  emit("accountsChanged", address ? [address] : []);
  renderPanel();
  return address;
}

async function personalSign(params) {
  const [m, a] = params || [];
  // Some dApps send (address, message): accept either order, never another account.
  const swapped = sameAddr(m) && !sameAddr(a);
  return ask({ kind: "message", message: swapped ? a : m, account: swapped ? m : a, site: site() });
}
async function signTyped(params) {
  const [a, data] = params || [];
  const n = await currentNet();
  return ask({ kind: "typed", account: a, data: typeof data === "string" ? data : JSON.stringify(data), chainId: n ? n.chainId : null, site: site() });
}
const big = (v) => (v === undefined || v === null || v === "" ? null : BigInt(v));
async function sendTransaction(params) {
  const tx = (params || [])[0] || {};
  const net = await currentNet();
  if (!net) throw rpcError(4100, T.noSite());
  if (tx.from && !sameAddr(tx.from)) throw rpcError(4100, "not this computer key's account");
  if (tx.chainId != null && Number(big(tx.chainId)) !== net.chainId) throw rpcError(4901, `the transaction is for chain ${Number(big(tx.chainId))}, the page is on ${net.chainId}`);
  const rpc = rpcFor(net);
  const base = { to: tx.to ? ethers.getAddress(tx.to) : null, data: tx.data || tx.input || "0x", value: big(tx.value) || 0n };
  const nonce = big(tx.nonce) !== null ? Number(big(tx.nonce)) : await rpc.getTransactionCount(address, "pending");
  const gasLimit = big(tx.gas) || big(tx.gasLimit) || await rpc.estimateGas({ ...base, from: address });
  let fees;
  if (big(tx.maxFeePerGas) !== null) fees = { type: 2, maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) ?? 0n };
  else if (big(tx.gasPrice) !== null) fees = { type: 0, gasPrice: big(tx.gasPrice) };
  else {
    const f = await rpc.getFeeData();
    fees = f.maxFeePerGas != null ? { type: 2, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n } : { type: 0, gasPrice: f.gasPrice };
  }
  const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  const raw = await ask({ kind: "tx", tx: str({ ...base, nonce, gasLimit, chainId: net.chainId, ...fees }), net: { name: net.name, currency: net.currency || "" }, site: site() });
  const t = ethers.Transaction.from(raw);
  if (t.from !== address || Number(t.chainId) !== net.chainId) throw rpcError(-32603, "signature check failed");
  return rpc.send("eth_sendRawTransaction", [raw]);
}
async function signUserOperation(params) {
  const { op, entryPoint, chainId } = (params || [])[0] || {};
  const net = await currentNet();
  if (!net) throw rpcError(4100, T.noSite());
  if (Number(chainId) !== net.chainId) throw rpcError(4901, `operation for chain ${Number(chainId)}, the page is on ${net.chainId}`);
  const upEl = $("upAddress");
  const up = upEl && ethers.isAddress(upEl.value.trim()) ? ethers.getAddress(upEl.value.trim()) : null;
  return ask({ kind: "userop", op, entryPoint, chainId: net.chainId, up, net: { name: net.name, currency: net.currency || "" } });
}

// ---- the EIP-1193 provider
const READS = new Set(["eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_getBalance",
  "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByHash",
  "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas"]);
const handlers = {};
function emit(ev, arg) { for (const fn of handlers[ev] || []) { try { fn(arg); } catch (e) { /* a listener's own error */ } } }
const provider = {
  isUpWalletApp: true,
  isPhoneKey: true,   // the same protocol as the phone key: upwallet_signUserOperation for the gas relay
  isComputerKey: true,
  async request(args) {
    const m = args && args.method, p = args && args.params;
    switch (m) {
      case "eth_requestAccounts": return [await ensureKey()];
      case "eth_accounts": await status(); return address ? [address] : [];
      case "eth_chainId": { const n = await currentNet(); return n ? "0x" + n.chainId.toString(16) : "0x1"; }
      case "net_version": { const n = await currentNet(); return String(n ? n.chainId : 1); }
      case "wallet_switchEthereumChain": {
        const id = Number(BigInt(p && p[0] && p[0].chainId));
        const n = await currentNet();
        if (n && n.chainId === id) return null;
        throw rpcError(4902, "choose this network in the page");
      }
      case "wallet_addEthereumChain": return null;
      case "personal_sign": return personalSign(p);
      case "eth_signTypedData_v4": case "eth_signTypedData": return signTyped(p);
      case "eth_sendTransaction": return sendTransaction(p);
      case "upwallet_signUserOperation": return signUserOperation(p);
      case "eth_sign": case "eth_signTransaction": throw rpcError(4200, `${m} is not supported`);
      default: {
        if (!READS.has(m)) throw rpcError(4200, `${m} is not supported`);
        const n = await currentNet();
        if (!n) throw rpcError(4100, T.noSite());
        return rpcFor(n).send(m, p || []);
      }
    }
  },
  on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return provider; },
  removeListener(ev, fn) { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); return provider; },
};

// ---- the warning, until accepted
function isAcked() { try { return localStorage.getItem(ACK_KEY) === ACK_VERSION; } catch (e) { return false; } }
let ackWaiters = [];
function acknowledged() {
  if (isAcked()) return Promise.resolve();
  showWarning();
  return new Promise((ok) => ackWaiters.push(ok));
}
function showWarning() {
  if ($("pkWarn")) return;
  const back = document.createElement("div");
  back.id = "pkWarn";
  back.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;";
  const box = document.createElement("div");
  box.style.cssText = "max-width:560px;max-height:90vh;overflow:auto;background:var(--raised,#fff);color:var(--text,#111);border-radius:12px;padding:18px;font-size:14px;line-height:1.5;";
  const h = document.createElement("h3"); h.textContent = "⚠️ " + T.warnTitle(); h.style.marginTop = "0";
  box.appendChild(h);
  for (const t of T.warn()) { const d = document.createElement("p"); d.textContent = t; box.appendChild(d); }
  const ok = document.createElement("button");
  ok.type = "button"; ok.id = "pkWarnOk"; ok.textContent = T.warnOk();
  ok.addEventListener("click", () => {
    try { localStorage.setItem(ACK_KEY, ACK_VERSION); } catch (e) { /* asked again next time */ }
    back.remove();
    const w = ackWaiters; ackWaiters = []; for (const f of w) f();
  });
  box.appendChild(ok);
  back.appendChild(box);
  document.body.appendChild(back);
}

// ---- "This computer", under the page's connect button
function backupLink() {
  const q = new URLSearchParams();
  if (address) q.set("phone", address);
  const up = $("upAddress") && $("upAddress").value.trim();
  if (up && ethers.isAddress(up)) q.set("up", ethers.getAddress(up));
  const n = knownNet();
  if (n) q.set("network", n.key);
  return `${SITE}up-backup.html?${q}`;
}
function renderPanel() {
  const signer = $("connectSigner");
  if (!signer) return;
  signer.textContent = T.connect();
  let box = $("pkPanel");
  if (!box) {
    box = document.createElement("div");
    box.id = "pkPanel"; box.className = "note"; box.style.marginTop = "8px";
    signer.insertAdjacentElement("afterend", box);
  }
  box.textContent = "";
  const add = (tag, text) => { const e = document.createElement(tag); if (text) e.textContent = text; box.appendChild(e); return e; };
  add("b", T.title());
  if (!address) { add("div", T.none()); return; }
  add("div", T.addr(address, method)).style.cssText = "font-family:monospace;overflow-wrap:anywhere;margin:4px 0;";
  add("div", T.authHint());
  const row = add("div"); row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;";
  const btn = (text, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "secondary small"; b.textContent = text; b.addEventListener("click", fn); row.appendChild(b); return b; };
  const copy = btn(T.copy(), async () => {
    try { await navigator.clipboard.writeText(address); } catch (e) { /* the address is on screen */ }
    copy.textContent = T.copied(); setTimeout(() => { copy.textContent = T.copy(); }, 1500);
  });
  const link = document.createElement("a");
  link.href = backupLink(); link.target = "_blank"; link.rel = "noopener"; link.textContent = T.open();
  link.className = "secondary small"; link.style.alignSelf = "center";
  link.addEventListener("click", () => { link.href = backupLink(); });
  row.appendChild(link);
  btn(T.remove(), async () => {
    try { await ask({ kind: "remove" }); } catch (e) { return; }
    await status();
    emit("accountsChanged", []);
    renderPanel();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try { await status(); } catch (e) { /* no key */ }
  renderPanel();
  new MutationObserver(() => renderPanel()).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  const changed = async () => { const n = await currentNet(); if (n) emit("chainChanged", "0x" + n.chainId.toString(16)); };
  const el = $("network");
  if (el) el.addEventListener("change", changed);
  const rpcEl = $("customRpc");
  if (rpcEl) rpcEl.addEventListener("change", changed);
  if (!isAcked()) showWarning();
});

const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: INFO, provider }) }));
window.addEventListener("eip6963:requestProvider", announce);
announce();
