# Third-party notices

This repository's own code is under the MIT license ([LICENSE](LICENSE)). The extension built from it
(`dist/`, and the zip attached to each release) also contains the third-party code below, each under its own
terms.

## WalletConnect bundle (Reown)

`vendor/walletkit-1.6.0.min.js`, taken from the Cross_Chain repository at the commit pinned in
`UPSTREAM.json`, together with the UP Wallet page.

> Portions © 2025 Reown, Inc. All Rights Reserved

Under the WalletConnect Community License Agreement of Reown, Inc., which is not an open-source license and
has its own usage thresholds. The notice is in the page's footer; the license text and the list of the other
packages in the bundle are in the Cross_Chain repository (`vendor/walletkit-1.6.0.LICENSE.md`,
`vendor/walletkit-1.6.0.THIRD-PARTY.txt`, `THIRD_PARTY_NOTICES.md`).

## Other components

| Component | License |
|---|---|
| UP Wallet page and its scripts (Cross_Chain) | MIT |
| ethers 6.13.4 (in the page, and bundled in the signing window) | MIT |
| `qrcode-generator` 1.4.4 (Kazuhiko Arase), from Cross_Chain's `vendor/` | MIT |
| The icons, from the UP Wallet Android app | MIT (this project) |

esbuild and Playwright are used only to build and test the extension; they are not in it.
