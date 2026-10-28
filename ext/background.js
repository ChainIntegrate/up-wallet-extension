// UP Wallet extension: the toolbar button opens the wallet in a tab, or brings back the one already open.
const api = globalThis.chrome;
api.action.onClicked.addListener(async () => {
  const url = api.runtime.getURL("up-wallet.html");
  const open = await api.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] }).catch(() => []);
  const ctx = open.find((c) => c.tabId >= 0);
  if (ctx) { await api.tabs.update(ctx.tabId, { active: true }); await api.windows.update(ctx.windowId, { focused: true }); }
  else await api.tabs.create({ url });
});
