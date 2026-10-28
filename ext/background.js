// UP Wallet extension: the toolbar button opens the wallet in the browser's side panel, as a browser wallet does.
// The button's menu (right click) also opens it in a tab, or brings back the tab already open.
const api = globalThis.chrome;
const PAGE = "up-wallet.html";

api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => null);

async function openTab() {
  const url = api.runtime.getURL(PAGE);
  const open = await api.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] }).catch(() => []);
  const ctx = open.find((c) => c.tabId >= 0);
  if (ctx) { await api.tabs.update(ctx.tabId, { active: true }); await api.windows.update(ctx.windowId, { focused: true }); }
  else await api.tabs.create({ url });
}

api.runtime.onInstalled.addListener(() => {
  const it = /^it\b/i.test(api.i18n.getUILanguage() || "");
  api.contextMenus.create({ id: "open-tab", title: it ? "Apri UP Wallet in una scheda" : "Open UP Wallet in a tab", contexts: ["action"] }, () => void api.runtime.lastError);
});
api.contextMenus.onClicked.addListener((info) => { if (info.menuItemId === "open-tab") openTab(); });
