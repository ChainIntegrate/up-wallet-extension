# UP Wallet for the browser (desktop extension)

The UP Wallet page of [Cross_Chain](https://github.com/ChainIntegrate/Cross_Chain) as a desktop browser
extension: the wallet of a LUKSO Universal Profile on every network where it exists, with this computer's
own key, so that the computer needs no MetaMask to use dApps. The Android app does the same on the phone
([up-wallet-android](https://github.com/ChainIntegrate/up-wallet-android)).

**Status: phase 2, 0.2.8 (0.2.0: an injected wallet for the sites you connect, the wallet page isolated by the browser; 0.2.1: a new version announced in the wallet; 0.2.3: the signing window's EXT-02 and EXT-03; 0.2.2 and 0.2.4 to 0.2.7: fixes from live use, connecting from the side panel, Aave, the token lists; 0.2.8: the signing window shows by name and arguments the calls the wallet page knows, checked against the data, and warns only from what they do); prototype (0.x).** Chrome, Edge and Brave (Chromium 121 or later).
Firefox is not supported yet. Step 2 of Cross_Chain's roadmap.

> **⚠️ Experimental: the maintainer's own wallet.** The extension keeps a signing key on this computer,
> encrypted. Whoever can use the computer and pass its passkey (or knows the password) can sign with the
> key, within the permissions it has on the UP, which include moving its funds. Use it only if you
> understand how a Universal Profile's controllers and permissions work, with small amounts, at your own
> risk. Not an official LUKSO product. Free software under the MIT license, with no warranty.

## Why an extension, and not the web page

A web page's code comes from the server at every visit: if it held a key, whoever controlled the server for
an hour could serve a version that copies it. An extension is installed code, versioned and updated only
when the user chooses, as the Android app is. So the key can live in the extension and never in a page.

## How it works

- **The page.** The same UP Wallet page as the site, taken from Cross_Chain at the commit pinned in
  `UPSTREAM.json` and packaged by `scripts/build.js`: ethers bundled (checked against the page's own
  integrity hash), the page's inline scripts moved to files (Manifest V3 runs no inline script; the
  manifest's policy is `script-src 'self'`), and the extension's own files, described below: the computer
  key (`ext/device-key.js`), the signing window, the connected sites (`ext/dapp-kit.js`), the relay calls to
  the site (`ext/ext-shim.js`) and the side panel's look (`ext/ext.css`). The toolbar button opens the wallet
  in the browser's side panel, as a browser wallet does; its menu (right click) opens it in a tab.
- **The page is sandboxed** (from 0.2.0; review of 2026-11-04, EXT-01). It runs as a sandboxed page of the
  extension (manifest `sandbox`): an opaque origin, no `chrome.*` API, no access to the extension's storage
  (where the encrypted key is), to the passkey (whose relying party is the extension's id) or to the signing
  window. The wallet is `wallet.html` with `ext/host.js`, a small privileged page that holds the page in a
  frame and answers, by messages, only: the page's own settings (language, network, UP, contacts), the key's
  address and method, a structured request for the signing window (one at a time; the site it names is the
  host's, never the page's word), the site's relay on its known paths, the connected sites' requests and
  answers. Everything else is refused. `ext/sandbox-shim.js`, the page's first script, gives it its storage
  and that bridge. The page's own scripts (its decoders, everything it loads) can at most ask for a
  signature, which the signing window shows and the user confirms; they cannot open the key.
- **This computer's key** (`ext/device-key.js`): the page's wallet, announced through EIP-6963 as
  "Computer key (UP Wallet)". It prepares transactions (nonce, gas, fees from the network's RPC) and sends
  them; it does not hold the key: every signature goes to the signing window. Only read methods reach the
  RPC. Under the page's connect button, the panel "This computer": the key's address, its name kept on the
  UP on the page's network (given on the site's Backup page), the link to the Backup page (which fills in
  the key, the UP, the network and "Computer · UP Wallet extension" as the name to start from), the key's
  own balance on that network (the currency it pays gas with when it sends a transaction itself) with
  "Send the key's balance to the UP" (one plain transfer to the page's UP, the balance minus the transfer's
  maximum fee, confirmed in the signing window: a key that is lost has no copy, and neither has its
  balance), delete. At every opening the key connects by itself (it only reads its address), with the
  last UP used and the network.
- **The signing window** (`ext/signer.html`, `ext/signer.js`, a window at the top right of the browser window, large enough for the browser's passkey dialogs; its buttons answer only a second after the request is shown, so a click meant for the page cannot sign): the only place where the code opens the key. What a request signs, and what the window shows of it, is computed by `ext/sign-plan.js`, which has no browser code: the Android app's signing window uses the same file. The
  key is a secp256k1 private key created there, and stored (`chrome.storage.local`) only encrypted with
  AES-256-GCM. The AES key comes from:
  - a **passkey**, through WebAuthn's PRF extension (HKDF-SHA256 of the PRF value). The passkey belongs to
    this extension's id; the user chooses where it lives: Windows Hello (an up-to-date Windows 11), Google
    Password Manager, a phone, a security key;
  - or a **password** (at least 12 characters, PBKDF2-SHA256 with 600,000 rounds), the fallback where no
    passkey gives a PRF value.

  For each request the window computes what is signed from the request itself, not from the page's words,
  and shows it, with its warnings first (from 0.2.3, review of 2026-11-04, EXT-02 and EXT-03: typed data by
  the type that is signed, a declared `primaryType` that differs refused, only the signed fields shown;
  the token calls' arguments, transfers and approvals of ERC-20, LSP7, ERC-721, LSP8, ERC-1155 and Permit2,
  with "unlimited" approvals flagged; every call of a batch; a function the window does not know, said so): the message's text, the typed data's domain and content, the transaction's network,
  recipient, value, function and maximum gas (through the UP's Key Manager, `execute(bytes)`: what the UP
  does, each call's recipient, value and function), the gas-relay operation's recipient, value and function
  (its hash computed there). It asks for the passkey or the password, decrypts the key, signs, checks the
  signature against the stored address and answers with the signature only. It refuses opaque 32-byte
  messages (they could authorize an operation of the UP), another account, another UP's operation and
  EntryPoints other than v0.6.
- **On the UP**, the key is a controller like the Android app's phone key: authorized once per network from
  the site's Backup page, "Authorize a device", signed by an admin controller (for example MetaMask on the
  computer), with no admin permissions (it cannot add controllers or change permissions; it can use the UP's
  funds). Admin operations keep using an external wallet such as MetaMask. A lost computer or a removed
  extension is handled by revoking the key from the same page.
- **Relay calls** (gas paid by the site) go to the site through the host (`ext/ext-shim.js`, `ext/host.js`); the
  extension has the site in its host permissions, and the relayer and the sponsor service accept the
  extension's origin. The networks' RPCs answer the sandboxed page as they answer any site (checked on
  2026-11-23 for every network of the page); Ronin's, the one that does not, goes through the host, and so
  does Alchemy (token lists, NFTs: the extension's own key accepts only the extension's origin; from 0.2.5,
  as an ordinary cross-origin request from 0.2.6, since Chrome leaves the Origin header out of a GET to a host
  the extension has permission for). Chrome lets the
  user limit an extension's "Site access": then the wallet says so at the top, with "Allow", which asks for
  it again (without it the relay calls fail, blocked by CORS).
- **A new version announced** (from 0.2.1; Cross_Chain `WALLET-BACKLOG.md` item 14): at every opening the host
  asks the site's relay service which is the latest full release (`relay/versions`, which reads GitHub's
  "latest" at most every 30 minutes; the wallet never calls GitHub) and, when it is newer, shows above the
  wallet the version it has and the latest, how to update (copy the files into the same folder, "Load
  unpacked" on it, never remove the extension) and the download link, only if it is a file of this
  extension's own releases. "Later" hides it for three days. Nothing is downloaded or installed by itself,
  nothing about the user is sent.
- **In the side panel** (about 400 pixels wide) the page has a compact header (`ext/ext.css`): a smaller
  banner, the title on one line, the introduction left to panel 0.
- **dApps: an injected wallet, on the sites you connect** (from 0.2.0; no WalletConnect in the extension).
  On the dApp's tab, press UP Wallet's toolbar button (the click lets the extension read that tab's site, for a
  moment: activeTab), then in the wallet, panel 4 "Connected sites", **Connect the active tab's site**: Chrome
  asks for access to that one site (optional host permission, never "all sites"). That site's pages then get `ext/inpage.js`, an
  EIP-1193 provider announced through EIP-6963 as **UP Wallet** (`it.chainintegrate.upwallet`), never written
  to `window.ethereum`, so MetaMask and LUKSO's extension keep working; `ext/content.js` passes its calls to
  the service worker (`ext/background.js`), which takes the site's origin from Chrome. The account is the UP
  chosen in the wallet, on the wallet's network, as with a WalletConnect session: reads go to that network's
  RPC; "Connect" (`eth_requestAccounts`) and everything signed go to the wallet page, which checks and
  confirms them with the same code as WalletConnect's requests (`ext/dapp-kit.js` gives it the sites in place
  of the WalletConnect client), then to the signing window, which names the site as Chrome gave it. Another
  network is refused (the wallet's network is chosen in the wallet); other methods are refused (4200). A
  request with the wallet closed opens it by itself, in a window at the top right, and waits for its checks;
  a wallet closed with a request not answered refuses it (4001). **Disconnect** removes the site and gives
  Chrome's access back. Checked with the dApps in use on 2026-11-22 (`spike/eip6963-discovery/`): listed by
  hup, Morpho, KyberSwap, Yield Yak, BENQI, revoke.cash, Uniswap, Aave and Merkl; Aerodrome lists only a fixed
  set of wallets, so it is used from the Android app (WalletConnect) or the site's page with MetaMask.

Non-custodial throughout: the key is created on the computer, never leaves the extension and has no copy.

**The extension's id is fixed**, `bjndlbdefcelfamapgpimaiaboehehek`, by the public key in `ext-config.json`
(the manifest's `key`). The passkey belongs to that id: an extension loaded with another id would not find
it. A future Chrome Web Store version will have the store's own id, so its users will create a new key and
authorize it again.

## One key per device, by choice

Each computer (and each phone, with the Android app) has its own key, created there, with no export, no
import and no copy, not even an encrypted backup file or a synced one. A new computer means a new key and one
"Authorize a device" from the site's Backup page, signed by an admin controller (MetaMask), once per network.
That step is deliberate:

- each device is a controller of its own on the UP: a lost or stolen device is revoked alone, the others keep
  working;
- a key that never leaves its device is not in a file to export, a backup or a seed phrase. It is stored
  encrypted in the browser profile: with a passkey, the secret that decrypts it stays with the passkey; with
  a password, whoever copies the profile can try passwords offline (EXT-1 below), so a long, unique password
  matters;
- the device keys have no admin permissions, so one of them cannot authorize another: adding a controller
  always takes an admin controller, by design.

## Install

From the [releases](https://github.com/ChainIntegrate/up-wallet-extension/releases): download
`up-wallet-extension-v….zip` (not "Source code") and extract it into Documents: it holds one folder,
`UP-Wallet-Extension` (from 0.1.9; before, the files were loose in the zip). Keep it for good, not in Downloads:
Chrome runs the extension from that folder. Then in Chrome, Edge or Brave `chrome://extensions`, "Developer
mode" on, "Load unpacked": the dialog shows only folders; click once on `UP-Wallet-Extension` and press
"Select" (the same on Windows, Mac and Linux). To update, copy everything inside the new zip's
`UP-Wallet-Extension` folder into the folder the extension already runs from (replace the files), then press
"Load unpacked" again on that same folder: the key stays (the id is the same). The reload button alone may keep the old version (seen on Chrome 156, Windows 11): check the
version on the extension's card, then close and reopen the wallet. **Never remove the extension to update it**:
removing it deletes its key, which has no copy. The key is kept by the browser with the extension, not in
the folder: if the folder is deleted, the extension stops working (a loading error), but do not press
"Remove" on it; put the same version back into the same folder and press "Load unpacked" on it, and the
key is there again.

Or build it yourself:

```
npm ci
npm run build          # clones Cross_Chain at the pinned commit; or CROSS_CHAIN_DIR=/path/to/Cross_Chain
```

Then in Chrome, Edge or Brave: `chrome://extensions`, "Developer mode" on, "Load unpacked", the `dist`
folder. Each CI run attaches the built zip as an artifact, and each release carries it. An unpacked
extension does not update by itself.

First use: open the extension (toolbar), accept the warning, choose the network and the UP, press "Use this
computer's key": the signing window creates the key with a passkey (or a password). Then authorize its
address on the UP from the site's Backup page, on each network. To use a dApp: open it in a tab, press UP
Wallet's toolbar button there, and in panel 4 press "Connect the active tab's site"; then on the dApp press
"Connect" and choose "UP Wallet".

## Privacy

No account, no usage statistics, no data sent to ChainIntegrate beyond what the wallet needs to work: what
the extension keeps in the browser, which services it talks to (RPC nodes, Alchemy, the explorers, IPFS
gateways, the site's relayer for sponsored gas and the release check) and what they see are in the
[privacy notice](https://crosschain-lukso.chainintegrate.it/privacy.html), section 7 for the extension.

## Phase 0: the passkey test

`spike/passkey-prf/` (Chrome) and `spike/passkey-prf-firefox/` check that a passkey with PRF works from an
extension's own page. Results (2026-10-28): Chromium 153 with a virtual authenticator, and Chrome 156 on
Windows 11 with a passkey in Google Password Manager: it works, the PRF value is the same at every unlock.
With Windows Hello on that computer, then on Windows 11 23H2 without updates since 2024 (Windows Update
had been blocked), the passkey worked but gave no PRF value; once the updates were installed, Windows Hello
gave a PRF value too, the same at every unlock. Windows Hello's PRF support came with Windows' updates of
2026, so an up-to-date Windows is needed. Hence the choice of passkey (Windows Hello where Windows supports
it, otherwise Google Password Manager, a phone or a security key), and the password fallback.

## Tests

`npm test` (after `npm run build`): the extension in Chromium with a virtual WebAuthn authenticator that
supports PRF (Chrome DevTools Protocol), the RPCs mocked: the page and its Content-Security-Policy, its
texts for the computer key, the warning, a passkey key, a personal message, typed data, a transaction, a
transaction through the Key Manager, a gas-relay operation through the page's own client, the refusals, a
rejection; the page's isolation (EXT-01: the review's proof-of-concept steps, run in the page, fail; the host
refuses anything else; the relay and Ronin's RPC through the host); a connected site (a test dApp, allowed in
the test's copy of the manifest, since a test cannot answer Chrome's prompt): the provider announced at once
and at every load, the network and no account before connecting, the connection checked by the page, reads,
refusals, a message signed through the page's request window and the signing window, which names the site,
a request with the wallet closed (the wallet opens and takes it; closed again, the site is refused),
disconnecting; a newer version announced (its own release links only, "Later", the same or an older version
not announced); the buttons of the signing window armed after a moment, the key's balance sent to the UP, at every
opening the last UP, the key and "Only simulation" back, the compact header, the euro prices, the site
access withheld, delete, a password key (too short, wrong, right). The CI runs it on every push.

## Security review

Reviewed in the external AI-assisted review of the whole project of 2026-10-29 (Cross_Chain's
[AUDIT.md, section 17](https://github.com/ChainIntegrate/Cross_Chain/blob/main/AUDIT.md#17-rev-14--external-review-of-the-whole-system-with-the-browser-extension-2026-10-29)),
this repository at `e6f06a7` (0.1.7), read from scratch: **not a professional audit, but an in-depth one.**
No Critical, High or Medium. The key handling, the signing window, the provider, the isolation and the build
were found sound ("well engineered"). The review of 2026-11-04, after 0.1.9 (`audits/2026-11-04-review.md`),
qualified the isolation (EXT-01, Medium) and the signing window (EXT-02, EXT-03, Medium): all three fixed in
0.2.0 to 0.2.3; the README, the release workflow and the privacy notice (EXT-05 to EXT-07) on 2026-11-24;
EXT-04 (the network's name and the payer in the signing window) and the license files in the zip go with
the next release. Summary: Cross_Chain's AUDIT.md, section 19. Two items of 2026-10-29 concern this repository:

- **EXT-1 (Low, accepted): the password is the weaker way.** With a password, the encrypted key and its
  salt are in the browser profile: whoever copies the profile can try passwords offline (PBKDF2-SHA256 with
  600,000 rounds and at least 12 characters raise the cost, but do not stop a weak password). The password
  is only the fallback for a computer whose passkeys give no PRF value. **Use a passkey**: Windows Hello on
  an up-to-date Windows 11 (the maintainer's setup), or Google Password Manager. A passkey kept by Windows
  Hello or a security key stays on that device; a synced passkey (Google Password Manager, iCloud Keychain,
  1Password) is copied to the account's other devices, so whoever controls that account and gets a copy of
  this browser profile could unlock the key: protect that account (AUDIT 2026-11-04 EXT-05). If you must use a password, make it long and unique.
- **EXT-2 (Info, accepted): the id is fixed by a public key in this repository**, so anyone can build a
  package with the same id. Chrome installs only what you load, and the passkey and the stored key belong
  to your installed copy: install only the zip of this repository's releases.

## The plan

1. **Phase 0: the passkey from the extension.** Done.
2. **Phase 1: the wallet.** Done (0.1.0 to 0.1.7, 2026-10-28 and 29): the server settings (the extension's origin
   accepted by the relayer and the sponsor service, and by the WalletConnect project), tests on the
   maintainer's computer (Windows 11, Chrome, Windows Hello), WalletConnect kept alive in an offscreen
   document, the controller names of the Backup page, the key's balance sent to the UP; used live with
   hup.social on LUKSO and Morpho on Base and Arbitrum One; reviewed with the whole project on 2026-10-29
   (Cross_Chain `AUDIT.md`, section 17). Then 0.1.8 (2026-11-01): page 0.13.0 (ChainIntegrate's
   Traceability Registry and the contracts verified on LUKSO decoded, contacts for sends with the
   address-poisoning warning, the site relayer checked before a request). Then 0.1.9 (2026-11-03): page
   0.14.0 (ChainIntegrate's Supplier Trust Registry decoded), the panel "This computer" linking to the
   LUKSO authorization page on LUKSO, one folder in the zip, the signing logic in `ext/sign-plan.js`
   (shared with the Android app's signing window). Next: Firefox (an `.xpi` signed by Mozilla as an unlisted add-on).
3. **Phase 2: no WalletConnect** (decided on 2026-11-22; 0.2.0). The UP offered to dApps in the browser's tabs
   as an injected wallet (EIP-1193, announced through EIP-6963), every request through the same checks and
   confirmation window (Cross_Chain's roadmap, step 5). The discovery test first (`spike/eip6963-discovery/`,
   2026-11-22: listed by every dApp in use but Aerodrome); then, in one release, the wallet page isolated by
   the browser (EXT-01), the provider on the sites the user connects only (permission granted site by site),
   WalletConnect removed from the extension (the Android app keeps it). Done in 0.2.0 (2026-11-23), tested
   live on Aave and Arcstock. Next: the two-provider review of this structural change, run by the
   maintainer (Cross_Chain `AUDIT.md`, review policy).
4. **Later: the key signing inside the hardware.** Today the passkey unlocks the key, which is decrypted
   for one signature in the signing window. A passkey signing by itself (P-256, never leaving Windows
   Hello or a security key) needs a contract on the UP that checks such signatures (an ERC-4337 validator,
   since the Key Manager checks Ethereum signatures only) and a professional audit: Cross_Chain's roadmap,
   step 8.

## License

MIT for this repository's code ([LICENSE](LICENSE)). Third-party code in the extension keeps its own
license: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The ChainIntegrate name and logo are not covered
by the license.
Provided "as is", without warranty of any kind: experimental, at your own risk.
