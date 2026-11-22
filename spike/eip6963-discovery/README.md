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

| dApp | Listed? (section) | Connects, shows the address? | Methods asked (console) |
|---|---|---|---|
| hup.social | | | |
| app.morpho.org | | | |
| aerodrome.finance | | | |
| kyberswap.com | | | |
| yieldyak.com | | | |
| app.benqi.fi | | | |
| revoke.cash | | | |
| app.uniswap.org | | | |

The `rdns` (`it.chainintegrate.upwallet`) and the name are the ones the real provider would use.
