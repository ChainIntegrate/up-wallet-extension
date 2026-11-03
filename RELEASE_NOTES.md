**UP Wallet for the browser, prototype.** The UP Wallet page as a desktop extension for Chrome, Edge and Brave, with this computer's own key, opened with a passkey (Windows Hello, Google Password Manager, a phone, a security key) or a password. Experimental: the maintainer's own wallet, small amounts, at your own risk. See the [README](https://github.com/ChainIntegrate/up-wallet-extension#readme).

### Install

1. Download **`up-wallet-extension-{{TAG}}.zip`** below (not "Source code").
2. Extract it into **Documents** (not Downloads): the zip holds one folder, `UP-Wallet-Extension`, so you get `Documents/UP-Wallet-Extension`. Keep it for good: Chrome runs the extension from that folder, and a clean-up of Downloads would stop it. (In Windows' "Extract all", set the destination to your Documents folder.)
3. Open `chrome://extensions`, turn on **Developer mode** and press **Load unpacked**. The dialog shows only folders, that is normal: go to Documents, **click once** on `UP-Wallet-Extension` (do not open it) and press **Select**. The same on Windows, Mac and Linux.
4. Check: **UP Wallet**, version {{VERSION}}, id `bjndlbdefcelfamapgpimaiaboehehek`. Pin it from the puzzle icon.
5. In the extension's **Details**, **Site access** must allow `crosschain-lukso.chainintegrate.it` (the gas paid by the site goes through it). If Chrome limits it, the wallet says so at the top, with **Allow**.

To update from an earlier version: open the new zip, open the `UP-Wallet-Extension` folder inside it, and copy **everything in it** into the folder your extension already runs from (replace the files). Versions up to 0.1.8 had no folder inside the zip: copy the files into your existing folder all the same, never into a new one. Then on `chrome://extensions` press **Load unpacked** again and choose the same folder. The key stays (same id). The reload button alone may keep the old version: check the version on the extension's card, then close and reopen the wallet. **Never remove the extension to update it**: removing it deletes its key, which has no copy. If the folder was deleted by mistake, do not press "Remove" on the error: unzip the same version again into the same folder and press **Load unpacked** on it; the key, kept by the browser, is there again.

### First use

1. Press the UP Wallet icon: the wallet opens in the browser's side panel (right click on the icon: "Open UP Wallet in a tab"). Accept the warning.
2. Settings: choose the network (1) and the UP (2); in **3 · Controller (computer key)** press **Use this computer's key**.
3. The signing window (at the top right) creates the key: **Create with a passkey** (Windows Hello where Windows supports it, or Google Password Manager), or **Use a password** (at least 12 characters, it cannot be recovered).
4. Authorize the key on the UP, once per network. **On LUKSO**, the panel "This computer" opens **Authorize on LUKSO**: you sign with LUKSO's own wallet (the Universal Profile extension, or the Universal Profiles app), no MetaMask. **On the other networks** it opens the site's **Backup page**, "Authorize a device", signed by an admin controller (MetaMask). The address comes filled in (check it against the panel); give the computer a name ("Office PC · extension"), saved on the UP with the authorization, so you recognize it in the list of controllers.
5. Back in UP Wallet the check turns green: connect a dApp with WalletConnect. Every signature opens the signing window, which shows what is signed and asks for the passkey or the password. The dApp stays connected with the wallet closed, while the browser runs: a request opens the wallet by itself, in a window at the top right, which takes back the session's network and UP and checks the request as always.

Built from Cross_Chain `{{PAGE}}` and this repository at `{{COMMIT}}`.
