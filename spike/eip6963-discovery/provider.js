// UP Wallet discovery test (spike, not a wallet). Announces a provider through EIP-6963 on every https page, to see
// which dApps list it in their "Connect" window and what they ask once connected. It holds no key: it answers the
// account (a public address, set below) and the network, refuses every signature and transaction (4001), and logs
// every call in the page's console with the prefix [UP Wallet test]. Remove the extension after the test.
(() => {
  // The address the dApps will see (public data). Change it to the UP you want them to read.
  const ADDRESS = "0x4a2605796e0d91A9667d6E30365aEEC384C48c27";
  let chainId = "0x2105"; // Base; a dApp may ask to switch (logged, accepted for these networks)
  const NETWORKS = ["0x2a", "0x2105", "0xa4b1", "0x89", "0xa86a", "0x13b2", "0x1"]; // LUKSO, Base, Arbitrum, Polygon, Avalanche, Arc, Ethereum
  const SIGNING = ["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_sendTransaction", "eth_signTransaction", "wallet_sendCalls"];
  const listeners = {};
  const log = (...a) => console.log("%c[UP Wallet test]", "color:#3b82f6;font-weight:bold", ...a);
  const err = (code, message) => Object.assign(new Error(message), { code });
  const emit = (ev, v) => (listeners[ev] || []).forEach((f) => { try { f(v); } catch (e) { /* the dApp's listener */ } });
  let connected = false;
  const provider = {
    isUpWalletTest: true,
    async request({ method, params } = {}) {
      log(location.host, method, params === undefined ? "" : params);
      switch (method) {
        case "eth_requestAccounts": connected = true; emit("connect", { chainId }); return [ADDRESS];
        case "eth_accounts": return connected ? [ADDRESS] : [];
        case "eth_chainId": return chainId;
        case "net_version": return String(parseInt(chainId, 16));
        case "wallet_switchEthereumChain": {
          const want = String(params && params[0] && params[0].chainId || "").toLowerCase();
          if (!NETWORKS.includes(want)) throw err(4902, "network not in the test's list");
          chainId = want; emit("chainChanged", chainId); return null;
        }
        case "wallet_addEthereumChain": return null;
        case "wallet_requestPermissions": connected = true; return [{ parentCapability: "eth_accounts" }];
        case "wallet_getPermissions": return connected ? [{ parentCapability: "eth_accounts" }] : [];
        case "wallet_revokePermissions": connected = false; emit("accountsChanged", []); return null;
      }
      if (SIGNING.includes(method)) throw err(4001, "UP Wallet discovery test: signing is disabled");
      throw err(4200, "UP Wallet discovery test: method not supported (" + method + ")");
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((g) => g !== f); return provider; },
  };
  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: "UP Wallet (test)",
    icon: "data:image/png;base64,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",
    rdns: "it.chainintegrate.upwallet",
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", () => { log(location.host, "asked for wallets (EIP-6963)"); announce(); });
  announce();
})();
