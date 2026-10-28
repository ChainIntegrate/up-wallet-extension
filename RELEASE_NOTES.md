**UP Wallet for the browser, prototype.** The UP Wallet page as a desktop extension for Chrome, Edge and Brave, with this computer's own key, opened with a passkey (Windows Hello, Google Password Manager, a phone, a security key) or a password. Experimental: the maintainer's own wallet, small amounts, at your own risk. See the [README](https://github.com/ChainIntegrate/up-wallet-extension#readme).

### Install

1. Download **`up-wallet-extension-{{TAG}}.zip`** below (not "Source code").
2. Unzip it into a folder you will keep (Chrome loads the extension from there). The folder must contain `manifest.json` and `up-wallet.html` directly.
3. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and choose that folder.
4. Check: **UP Wallet**, version {{VERSION}}, id `bjndlbdefcelfamapgpimaiaboehehek`. Pin it from the puzzle icon.

To update from an earlier version: unzip the new zip over the same folder and press the reload button of UP Wallet on `chrome://extensions`. The key stays (same id). If the wallet was open, close and reopen it; no need to restart the browser. **Never remove the extension to update it**: removing it deletes its key, which has no copy.

### First use

1. Press the UP Wallet icon: the wallet opens in the browser's side panel (right click on the icon: "Open UP Wallet in a tab"). Accept the warning.
2. Settings: choose the network (1) and the UP (2); in **3 · Controller (computer key)** press **Use this computer's key**.
3. The signing window (at the top right) creates the key: **Create with a passkey** (Windows Hello where Windows supports it, or Google Password Manager), or **Use a password** (at least 12 characters, it cannot be recovered).
4. From the panel "This computer", **Open the Backup page** on the site: **Authorize a device**, with an admin controller (MetaMask), once per network. The address comes filled in (check it against the panel); give the computer a name ("Office PC · extension"), saved on the UP with the authorization, so you recognize it in the list of controllers.
5. Back in UP Wallet the check turns green: connect a dApp with WalletConnect. Every signature opens the signing window, which shows what is signed and asks for the passkey or the password. The dApp stays connected with the wallet closed, while the browser runs: a request opens the wallet by itself, in a window at the top right, which takes back the session's network and UP and checks the request as always.

Built from Cross_Chain `{{PAGE}}` and this repository at `{{COMMIT}}`.
