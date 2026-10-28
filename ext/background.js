// UP Wallet extension: the toolbar button opens the wallet in the browser's side panel, as a browser wallet does.
// The button's menu (right click) also opens it in a tab, or brings back the tab already open.
// WalletConnect lives in an offscreen document (ext/wc-host.html), started here: the dApps' sessions stay
// while the browser runs, and a request with the wallet closed opens the wallet in a window.
const api = globalThis.chrome;
const PAGE = "up-wallet.html";
const HOST = "ext/wc-host.html";

api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => null);

async function openTab() {
  const url = api.runtime.getURL(PAGE);
  const open = await api.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] }).catch(() => []);
  const ctx = open.find((c) => c.tabId >= 0);
  if (ctx) { await api.tabs.update(ctx.tabId, { active: true }); await api.windows.update(ctx.windowId, { focused: true }); }
  else await api.tabs.create({ url });
}

// ---- WalletConnect
let creating = null;
async function ensureHost() {
  const url = api.runtime.getURL(HOST);
  const has = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] }).catch(() => []);
  if (has.length) return;
  if (!creating) {
    creating = api.offscreen.createDocument({ url: HOST, reasons: ["LOCAL_STORAGE"],
      justification: "WalletConnect: keeps the dApps' sessions (stored in the page storage) and their relay connection while the wallet is closed." })
      .finally(() => { creating = null; });
  }
  await creating;
}
// A dApp's request with no wallet page open: the wallet opens in a window at the top right, as the signing
// window does, and takes back the session (ext/wc-remote.js).
async function openWallet() {
  const cur = await api.windows.getLastFocused().catch(() => null);
  const W = 460, H = cur && cur.height ? Math.min(820, Math.max(500, cur.height - 90)) : 760;
  const pos = cur && cur.left != null ? { left: Math.max(0, cur.left + Math.max(0, cur.width - W - 12)), top: Math.max(0, cur.top + 72) } : {};
  await api.windows.create({ url: api.runtime.getURL(PAGE + "?wc=1"), type: "popup", width: W, height: H, focused: true, ...pos });
}
api.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || sender.id !== api.runtime.id) return;
  if (m.type === "wc-ensure") {
    ensureHost().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === "wc-open-wallet") openWallet().catch(() => null);
  else if (m.type === "wc-idle") api.offscreen.closeDocument().catch(() => null);
});
// With sessions kept from before (browser restart, extension update): the client starts again by itself.
const resumeHost = () => api.storage.local.get("wcActive").then((v) => { if (v.wcActive) return ensureHost(); }).catch(() => null);
api.runtime.onStartup.addListener(resumeHost);

api.runtime.onInstalled.addListener(() => {
  const it = /^it\b/i.test(api.i18n.getUILanguage() || "");
  api.contextMenus.create({ id: "open-tab", title: it ? "Apri UP Wallet in una scheda" : "Open UP Wallet in a tab", contexts: ["action"] }, () => void api.runtime.lastError);
  resumeHost();
});
api.contextMenus.onClicked.addListener((info) => { if (info.menuItemId === "open-tab") openTab(); });
