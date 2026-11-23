# Spike: is UP Wallet found by dApps through EIP-6963?

A test before building the injected provider (phase 2 of the extension, Cross_Chain roadmap step 5): does a
wallet that announces itself with **EIP-6963** appear in the "Connect" window of the dApps we use, and what do
they ask once connected? Nothing else is tested here.

**It is not a wallet.** It holds no key. It answers the account (a public address, `ADDRESS` in `provider.js`) and
the network, accepts a network switch among LUKSO, Base, Arbitrum One, Polygon, Avalanche, Arc and Ethereum, and
refuses every signature and transaction (4001). Every call is logged in the page's console with the prefix
`[UP Wallet test]`. It runs on every https page while installed: remove it after the test.

## How

1. `chrome://extensions`, Developer mode, **Load unpacked**, this folder.
2. Open each dApp, press its "Connect" button, and note:
   - does **"UP Wallet (test)"** appear (with the icon)? In which section ("Installed", "Detected", "Browser
     wallet", ...)?
   - press it: does the dApp show the address as connected?
   - in the console (F12): which methods did the dApp call (a network switch? a sign-in signature, refused here)?
3. Remove the extension.

## Result (2026-11-22, the maintainer's Chrome on Windows, MetaMask and LUKSO's extension also installed)

| dApp | Listed and connects | Methods asked |
|---|---|---|
| hup.social | Yes | `wallet_requestPermissions`, `eth_requestAccounts`, `wallet_switchEthereumChain` (to LUKSO); a "like" sent as `eth_sendTransaction` from the UP (`batchLike`), refused here as expected |
| app.morpho.org | Yes | permissions, accounts, network switch |
| aerodrome.finance | **No**: its "Browser wallet" opens a fixed list (MetaMask, WalletConnect, Coinbase Wallet, Binance Wallet); it does not use EIP-6963 | — |
| kyberswap.com | Yes | permissions, accounts, network switch |
| yieldyak.com | Yes | permissions, accounts, network switch (also a change of network made by the user) |
| app.benqi.fi | Yes | permissions, accounts, network switch |
| revoke.cash | Yes | permissions, accounts, `wallet_getCapabilities` (EIP-5792; refused, no harm) |
| app.uniswap.org | Yes | permissions, accounts, `wallet_getCapabilities` (refused: a warning in its console, the connection works) |
| pro.aave.com, app.aave.com | Yes | permissions, accounts, network switch |
| app.merkl.xyz | Yes | permissions, accounts |
| AStocks | No reaction during the test | — |

Every dApp that lists it asks the same few methods: `wallet_requestPermissions` / `eth_requestAccounts`,
`eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`; two ask `wallet_getCapabilities` (EIP-5792) and
work without it. None asked for a sign-in signature at connection.
Aerodrome is the one dApp in use that does not list it.

The `rdns` (`it.chainintegrate.upwallet`) and the name are the ones the real provider would use.
