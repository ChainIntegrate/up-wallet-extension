# UP Wallet for the browser (desktop extension)

The UP Wallet page of [Cross_Chain](https://github.com/ChainIntegrate/Cross_Chain) as a desktop browser
extension: the wallet of a LUKSO Universal Profile on every network where it exists, with its own key, so
that the computer needs no MetaMask to use dApps. The Android app does the same on the phone
([up-wallet-android](https://github.com/ChainIntegrate/up-wallet-android)).

**Status: phase 0, a feasibility test.** There is no wallet here yet. Step 2 of Cross_Chain's roadmap.

## Why an extension, and not the web page

A web page's code comes from the server at every visit: if it held a key, whoever controlled the server for
an hour could serve a version that copies it. An extension is installed code, versioned and updated only
when the user chooses, as the Android app is. So the key can live in the extension and never in a page.

## The plan

1. **Phase 0: the passkey from the extension (this repository today).** The extension's key will be
   encrypted, and decrypted for each signature with a secret the browser derives from a passkey (WebAuthn's
   PRF extension; Windows Hello, Touch ID or a phone). `spike/passkey-prf/` checks that this works from the
   extension's own page (`chrome-extension://…`), where the passkey belongs to the extension and not to any
   website.
2. **Phase 1: the wallet.** The UP Wallet page packaged in the extension, as the Android app packages it;
   its own secp256k1 key, created in the extension, encrypted with the passkey's secret, signed with in the
   extension; dApps connected through WalletConnect. The key is authorized on the UP from the site's Backup
   page with no admin permissions, as the phone key (it can use the UP's funds, never manage its
   controllers). Admin operations keep using an external wallet such as MetaMask. If a browser cannot give a
   passkey secret, the fallback is a password, with the key encrypted in the extension.
3. **Phase 2: no WalletConnect.** The UP offered to dApps in the browser's tabs as an injected wallet
   (EIP-1193, announced through EIP-6963), every request through the same checks and confirmation window.

Non-custodial throughout: the key is created on the computer, never leaves the extension and has no copy;
a lost computer or a removed extension is handled by revoking the key from another controller of the UP.

## Phase 0: try the passkey test

Chrome, Edge or Brave on Windows 11 (Windows Hello set up: fingerprint, face or PIN):

1. Download this repository ("Code" → "Download ZIP") and unzip it.
2. Open `chrome://extensions`, turn on "Developer mode", press "Load unpacked" and choose the folder
   `spike/passkey-prf`.
3. Press the extension's button in the toolbar (the puzzle icon, "UP Wallet — passkey PRF test"): a page
   opens.
4. Press **1** (create a test passkey, with Windows Hello), then **2** twice (unlock), then "Copy result".

Firefox: `about:debugging` → "This Firefox" → "Load Temporary Add-on…" →
`spike/passkey-prf-firefox/manifest.json` (the same test with Firefox's background script and add-on id);
then the same steps.

The test creates a passkey named "UP Wallet extension test", which can be deleted afterwards (Windows:
Settings → Accounts → Passkeys; Chrome: Password Manager). It creates no wallet and no key, reads nothing of
yours and sends nothing anywhere. Tested in Chromium 153 with a virtual authenticator that supports PRF,
then on Windows 11 with Chrome 156 (2026-10-28): the passkey works from the extension's page (its relying
party is the extension's id) and the PRF value is the same at every unlock. Chrome offered to save the
passkey in Google Password Manager (synced to the Google account); "Save another way" offers Windows Hello
(on this computer only), which the wallet will prefer.

A note for phase 1: the passkey belongs to the extension's id. An unpacked extension's id depends on its
folder, so the wallet will fix its id (the manifest's `key`), or a reinstall from another folder would not
find its passkey.

## License

MIT for this repository's code ([LICENSE](LICENSE)). Third-party code the extension will include keeps its
own license and will be listed in `THIRD_PARTY_NOTICES.md` (the WalletConnect bundle among it, under the
WalletConnect Community License). The ChainIntegrate name and logo are not covered by the license.
Provided "as is", without warranty of any kind: experimental, at your own risk.
