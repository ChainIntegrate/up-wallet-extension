# Third-party notices

This repository's own code is under the MIT license ([LICENSE](LICENSE)). The extension built from it
(`dist/`, and the zip attached to each release) also contains the third-party code below, each under its own
terms.

From 0.2.0 the extension no longer contains the WalletConnect bundle (Reown's WalletKit): dApps reach it as an
injected wallet. The page's footer still names it, as on the site, where the page uses it.

## Other components

| Component | License |
|---|---|
| UP Wallet page and its scripts (Cross_Chain) | MIT |
| ethers 6.13.4 (in the page, and bundled in the signing window) | MIT |
| `qrcode-generator` 1.4.4 (Kazuhiko Arase), from Cross_Chain's `vendor/` | MIT |
| The icons, from the UP Wallet Android app | MIT (this project) |

esbuild and Playwright are used only to build and test the extension; they are not in it.
