// The extension in Chromium, from dist/ (run `npm run build` first), with a virtual WebAuthn authenticator that
// supports PRF (Chrome DevTools Protocol): the page loads with the computer key as its only wallet, the key is
// created in the signing window (passkey, then password), and messages, typed data, transactions and gas-relay
// operations are signed there; refusals and cancellations. Network calls to the RPCs are mocked.
//   PLAYWRIGHT=/path/to/playwright node test/extension.js
"use strict";
// The service worker's requests routed too (its reads for the connected sites), as newer Playwright does by itself.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const { ethers } = require("ethers");

// The extension under test: a copy of dist/ whose manifest also allows https://dapp.test, the test's dApp. A real
// user grants a site with Chrome's prompt (optional_host_permissions), which a test cannot answer; the release
// zip is dist/ itself, unchanged.
const DIST = (() => {
  const fs = require("fs"), os = require("os");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "upw-ext-"));
  fs.cpSync(path.join(__dirname, "..", "dist"), out, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  m.host_permissions.push("https://dapp.test/*");
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 2));
  return out;
})();
const res = []; const ck = (n, c, x = "") => res.push(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : "\n      " + String(x).slice(0, 1500)}`);
const UP = "0x4a2605796e0d91A9667d6E30365aEEC384C48c27", TO = "0x" + "77".repeat(20);
const GDB = new ethers.Interface(["function getDataBatch(bytes32[]) view returns (bytes[])"]);
let named = null;   // the address whose name the mocked UP keeps

(async () => {
  const ctx = await chromium.launchPersistentContext("", { ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: "chromium" }), headless: true, args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  const errs = [], csp = [], raws = [];
  // The wallet page is sandboxed (origin "null"): the RPCs answer it as they answer any site, with CORS.
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, accept", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const relayOrigins = [], roninFrames = [], alchemyFrames = [];
  // What the site says is the latest extension: by default the version under test (nothing to announce).
  const OWN = "https://github.com/ChainIntegrate/up-wallet-extension/releases/";
  const myVersion = JSON.parse(require("fs").readFileSync(path.join(DIST, "manifest.json"), "utf8")).version;
  let versionsAnswer = () => ({ extension: { version: myVersion, download: OWN + `download/v${myVersion}/up-wallet-extension.zip`, notes: OWN + `tag/v${myVersion}` } });
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS, body: "" });
    const RPC = { "base-rpc.publicnode.com": 8453, "rpc.mainnet.lukso.network": 42, "rpc.testnet.lukso.network": 4201 };
    if (RPC[u.host]) {
      const q = JSON.parse(r.request().postData() || "{}");
      const one = (x) => {
        const ok = (v) => ({ jsonrpc: "2.0", id: x.id, result: v });
        switch (x.method) {
          case "eth_chainId": return ok("0x" + RPC[u.host].toString(16));
          case "eth_getTransactionCount": return ok("0x7");
          case "eth_estimateGas": return ok("0x5208");
          case "eth_gasPrice": return ok("0x3b9aca00");
          case "eth_maxPriorityFeePerGas": return ok("0x5f5e100");
          case "eth_getBlockByNumber": return ok({ number: "0x10", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x6700", nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x", baseFeePerGas: "0x3b9aca00", transactions: [] });
          case "eth_sendRawTransaction": raws.push(x.params[0]); return ok(ethers.keccak256(x.params[0]));
          case "eth_getBalance": return ok(u.host === "base-rpc.publicnode.com" ? "0x2386f26fc10000" : "0x0");   // 0.01 ETH on Base
          case "eth_call": {
            // ERC-1271: the UP accepts the computer key's signatures (the page checks it before answering a dApp).
            if (x.params[0].data && x.params[0].data.startsWith("0x1626ba7e")) return ok("0x1626ba7e" + "00".repeat(28));
            // The UP's controller names (Backup page): the computer key is "PC di prova" on Base.
            const c = x.params[0];
            if (u.host === "base-rpc.publicnode.com" && c.to && c.to.toLowerCase() === UP.toLowerCase() && c.data.startsWith(GDB.getFunction("getDataBatch").selector)) {
              const keys = GDB.decodeFunctionData("getDataBatch", c.data)[0];
              return ok(GDB.encodeFunctionResult("getDataBatch", [keys.map((k) => (named && k.toLowerCase() === "0x344e172b69e28979f8df0000" + named.slice(2).toLowerCase() ? ethers.hexlify(ethers.toUtf8Bytes("PC di prova")) : "0x"))]));
            }
            return ok("0x");
          }
          default: return ok("0x");
        }
      };
      return r.fulfill({ contentType: "application/json", headers: CORS, body: JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)) });
    }
    // Alchemy answers the site's key only for allowed origins, not a sandboxed page's "null": reached by the host.
    if (/\.g\.alchemy\.com$/.test(u.host)) { alchemyFrames.push((r.request().frame() && r.request().frame().url()) || "?"); return r.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "alchemy-ok" }) }); }
    // Ronin's RPC answers the site but not a sandboxed page (no CORS for origin "null"): reached by the host.
    if (u.host === "api.roninchain.com") { roninFrames.push((r.request().frame() && r.request().frame().url()) || "?"); const q = JSON.parse(r.request().postData() || "{}"); return r.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: q.id, result: "0x7e4" }) }); }
    // The site's relay service: the latest versions (a new release announced in the wallet).
    if (u.host === "crosschain-lukso.chainintegrate.it" && u.pathname === "/relay/versions") return r.fulfill({ contentType: "application/json", body: JSON.stringify(versionsAnswer()) });
    // The site's relay: reached only by the host (the extension's origin), for the wallet page.
    if (u.host === "crosschain-lukso.chainintegrate.it" && u.pathname === "/relay/info") { relayOrigins.push((r.request().frame() && r.request().frame().url()) || "?"); return r.fulfill({ contentType: "application/json", body: JSON.stringify({ test: "relay-info" }) }); }
    if (u.host === "dapp.test") return r.fulfill({ contentType: "text/html", body: "<!doctype html><title>dApp</title><body>a dApp</body>" });
    if (u.host === "envio.lukso-mainnet.universal.tech") return r.fulfill({ contentType: "application/json", headers: CORS, body: JSON.stringify({ data: { search_profiles: [{ id: UP.toLowerCase(), name: "simone", fullName: "Simone" }] } }) });
    if (u.protocol === "chrome-extension:") return r.continue();
    return r.fulfill({ status: 503, body: "" });
  });

  // The signing window, in one tab the test keeps (the virtual authenticator belongs to a tab): the wallet page's
  // chrome.windows.create is pointed at it.
  const signer = await ctx.newPage();
  signer.on("pageerror", (e) => errs.push("signer: " + e.message));
  await signer.addInitScript(() => { window.close = () => {}; });   // the test keeps this tab for every request
  await signer.goto(`chrome-extension://${id}/ext/signer.html`);
  const cdp = await ctx.newCDPSession(signer);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });

  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push("page: " + e.message));
  p.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load)/i.test(m.text())) csp.push(m.text()); });
  await p.addInitScript(() => { try { localStorage.setItem("upwallet.lang", "it"); localStorage.setItem("upwallet.riskAccepted", "1"); localStorage.setItem("upwallet.view", "all"); } catch (e) { /* none */ } });
  // The wallet is wallet.html (the host, privileged) with the wallet page in a sandboxed frame (EXT-01).
  const pageFrame = async (pg) => {
    for (let i = 0; i < 100; i++) { const fr = pg.frames().find((x) => /\/up-wallet\.html/.test(x.url())); if (fr) return fr; await new Promise((ok) => setTimeout(ok, 100)); }
    throw new Error("no wallet page frame");
  };
  await p.goto(`chrome-extension://${id}/wallet.html`);
  const f = await pageFrame(p);
  await f.waitForFunction(() => typeof ethers !== "undefined" && document.getElementById("connectSigner") && typeof GasRelayClient !== "undefined");
  const signerTab = await signer.evaluate(() => new Promise((ok) => chrome.tabs.getCurrent((t) => ok(t.id))));
  await p.evaluate((tabId) => {
    // A query makes each request a new document (a change of the #fragment alone would not reload the page).
    chrome.windows.create = async (o) => { window.__lastCreate = o; await chrome.tabs.update(tabId, { url: o.url.replace("signer.html#", `signer.html?t=${Date.now()}#`) }); return { id: -12345 }; };
  }, signerTab);
  // Waits for the signing window to show a request, and returns its text.
  // The URL of the request each step waits for: noted before the step starts, so that a request answered at once
  // (a refusal) is not taken for the next one.
  let lastUrl = "";
  const mark = () => { lastUrl = signer.url(); };
  const shown = async () => {
    for (let i = 0; ; i++) {
      try {
        await signer.waitForURL((u) => u.toString() !== lastUrl && u.hash.length > 1, { timeout: 10000 });
        await signer.waitForFunction(() => document.readyState === "complete" && !document.getElementById("actions").hidden, null, { timeout: 10000 });
        const text = await signer.evaluate(() => document.body.innerText);
        lastUrl = signer.url();
        return text;
      } catch (e) {
        if (i < 3 && /context was destroyed|navigation/i.test(e.message)) continue;
        console.log("SIGNER:", signer.url(), await signer.evaluate(() => document.body.innerText).catch(() => "?"), errs);
        throw e;
      }
    }
  };
  // WebAuthn needs the page in front, as the real signing window is when it opens.
  const click = async (sel) => { await signer.bringToFront(); await signer.click(sel); };

  const seen = await f.evaluate(() => new Promise((ok) => {
    const got = []; window.addEventListener("eip6963:announceProvider", (e) => got.push(e.detail.info.name));
    window.dispatchEvent(new Event("eip6963:requestProvider")); setTimeout(() => ok(got), 50);
  }));
  ck("the page loads in the extension, the computer key announced as its only wallet (EIP-6963)", seen.length === 1 && seen[0] === "Computer key (UP Wallet)", JSON.stringify(seen));
  const sp = await p.evaluate(async () => ({ b: await chrome.sidePanel.getPanelBehavior(), m: chrome.runtime.getManifest() }));
  // The button opens the panel from the service worker (action.onClicked), so the click also notes the tab's site.
  ck("the toolbar button opens the wallet in the side panel (side_panel in the manifest, opened by the extension on the click)", sp.b.openPanelOnActionClick === false && sp.m.side_panel.default_path === "wallet.html" && !sp.m.action.default_popup, JSON.stringify(sp.b));
  ck("the footer no longer names WalletConnect (not in the extension)", !(await f.evaluate(() => document.body.innerText)).includes("Reown"));
  ck("no inline script left in the page; nothing refused by the Content-Security-Policy", await f.evaluate(() => [...document.scripts].every((s) => s.src)) && csp.length === 0, csp.join(" | "));
  const v = await f.$eval("#pageVersion", (e) => e.textContent);
  const ver = JSON.parse(require("fs").readFileSync(path.join(DIST, "manifest.json"), "utf8")).version;
  ck("the version line names the extension's version, the page's version and its commit", new RegExp(`^UP Wallet · estensione ${ver.replace(/\./g, "\\.")} · pagina \\d+\\.\\d+\\.\\d+ \\(commit [0-9a-f]{7}\\)$`).test(v), v);
  ck("no \"Read the address from the UP extension\" button (it cannot reach an extension's page)", await f.$eval("#connectUp", (e) => getComputedStyle(e).display === "none"));
  const texts = await f.evaluate(() => ({ cls: document.documentElement.classList.contains("computer-key"), p3: document.querySelector('[data-i18n="panel3Title"]').textContent, ready: t("readyToSend"), perms: t("permsNone"), relay: GasRelayClient.text("optionNote", { pm: "PM" }), body: document.body.innerText }));
  const leftover = (texts.body.replace(/Nessuna affiliazione[^.]*\./, "").match(/.{0,60}(MetaMask|telefono|impronta).{0,60}/g) || []).filter((x) => !/Questo telefono|Autorizza un dispositivo/.test(x));
  ck("the page's texts name the computer key and the signing window, not MetaMask, the phone or the fingerprint", texts.cls && texts.p3 === "3 · Controller (chiave del computer) e verifica" && /conferma nella finestra di firma/.test(texts.ready) && /Autorizza un dispositivo/.test(texts.perms) && /chiave del computer\) firma un messaggio nella finestra di firma/.test(texts.relay) && leftover.length === 0, JSON.stringify({ ...texts, body: leftover }));
  const warn = await f.evaluate(() => (document.getElementById("pkWarn") || {}).innerText || "");
  ck("first start: the warning (experimental, the maintainer's wallet, can move the funds, no copy)", /wallet sperimentale/.test(warn) && /muoverne i fondi/.test(warn) && /non ha copie/.test(warn), warn);
  await f.click("#pkWarnOk");

  ck("with no network chosen before, the page starts on LUKSO", (await f.$eval("#network", (e) => e.value)) === "lukso");
  // ---- the UP by name (panel 2)
  await f.fill("#upAddress", "simo");
  await f.waitForSelector("#upAddressResults button", { timeout: 5000 });
  const found = await f.$eval("#upAddressResults", (e) => e.innerText);
  await f.click("#upAddressResults button");
  ck("panel 2: a name finds the UP in LUKSO's profile index, and picking it sets the address", /Usa: simone#/.test(found) && (await f.$eval("#upAddress", (e) => e.value)) === UP && (await f.$eval("#upAddressResults", (e) => e.textContent)) === "", found);
  // ---- create with a passkey
  await f.selectOption("#network", "base");
  await f.fill("#upAddress", UP);
  mark();
  await f.click("#connectSigner");
  let txt = await shown();
  ck("connect: the signing window offers to create the key with a passkey or a password", /Crea la chiave di questo computer/.test(txt) && /Crea con una passkey/.test(txt) && /Usa una password/.test(txt), txt);
  await click("#sign");
  await f.waitForFunction(() => typeof signerAddress !== "undefined" && signerAddress, null, { timeout: 15000 })
    .catch(async (e) => { console.log("SIGNER:", await signer.evaluate(() => document.body.innerText), "PAGE:", await f.evaluate(() => [document.getElementById("pkPanel").innerText, (document.getElementById("log") || {}).innerText].join(" / ")), errs); throw e; });
  const pos = await p.evaluate(async () => ({ c: window.__lastCreate, w: await chrome.windows.getCurrent() }));
  ck("the signing window is a small popup at the top right of the browser window, focused", pos.c.type === "popup" && pos.c.width === 520 && pos.c.height === 680 && pos.c.focused === true && pos.c.left === Math.max(0, pos.w.left + Math.max(0, pos.w.width - 532)) && pos.c.top === pos.w.top + 72, JSON.stringify(pos));
  const k1 = await signer.evaluate(async () => (await chrome.storage.local.get("deviceKey")).deviceKey);
  const addr = await f.evaluate(() => signerAddress);
  ck("passkey key: created and stored encrypted (no private key in storage), the page uses its address", k1 && k1.method === "passkey" && ethers.getAddress(k1.address) === ethers.getAddress(addr) && !/^0x[0-9a-f]{64}$/i.test(JSON.stringify(k1)) && k1.ct && k1.credId && k1.prfSalt, JSON.stringify(k1));
  const panel = await f.$eval("#pkPanel", (e) => e.innerText);
  ck("the panel shows the address, passkey, and how to authorize it", panel.includes(addr) && /passkey/.test(panel) && /Autorizza un dispositivo/.test(panel), panel);
  const link = await f.$eval("#pkPanel a", (e) => e.href);
  ck("the link to the Backup page names the key, the UP, the network and the kind of device", link.includes("phone=" + addr) && link.includes("up=" + UP) && link.includes("network=base") && link.includes("device=computer"), link);
  // On LUKSO: the page that authorizes the key with LUKSO's own wallet, with the key and the network.
  await f.selectOption("#network", "lukso");
  await f.waitForFunction(() => /up-authorize-lukso/.test((document.querySelector("#pkPanel a") || {}).href || ""), null, { timeout: 10000 }).catch(() => null);
  const lk = await f.$eval("#pkPanel a", (e) => [e.href, e.textContent]), lkPanel = await f.$eval("#pkPanel", (e) => e.innerText);
  ck("on LUKSO the panel links the LUKSO authorization page (key, network, device), said so", /\/up-authorize-lukso\.html\?/.test(lk[0]) && lk[0].includes("phone=" + addr) && lk[0].includes("network=lukso") && lk[0].includes("device=computer") && !lk[0].includes("up=") && /Autorizza su LUKSO/.test(lk[1]) && /wallet di LUKSO/.test(lkPanel), JSON.stringify(lk) + lkPanel);
  await f.selectOption("#network", "base");
  // its name kept on the UP (Backup page), on the page's network
  await f.waitForFunction(() => /Nessun nome sulla UP su Base/.test(document.getElementById("pkPanel").innerText), null, { timeout: 10000 }).catch(() => null);
  const unnamed = await f.$eval("#pkPanel", (e) => e.innerText);
  named = addr;
  await f.selectOption("#network", "lukso"); await f.selectOption("#network", "base");
  await f.waitForFunction(() => /Nome sulla UP \(Base\): PC di prova/.test(document.getElementById("pkPanel").innerText), null, { timeout: 10000 }).catch(() => null);
  const namedTxt = await f.$eval("#pkPanel", (e) => e.innerText);
  ck("the panel shows the key's name kept on the UP on the page's network, or that it has none", /Nessun nome sulla UP su Base/.test(unnamed) && /Nome sulla UP \(Base\): PC di prova/.test(namedTxt), unnamed + " / " + namedTxt);

  // ---- signatures
  let r;
  const ask = (fn, arg) => f.evaluate(fn, arg).then((r) => r, (e) => ({ err: e.message }));
  mark();
  let pr = f.evaluate(async () => { try { return await signerProvider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes("ciao UP")), signerAddress] }); } catch (e) { return { code: e.code }; } });
  txt = await shown();
  const armed = await signer.evaluate(() => [document.getElementById("sign").disabled, document.getElementById("cancel").disabled]);
  ck("the signing window's buttons answer only a moment after the request is shown (a click meant for the page cannot sign)", armed[0] === true && armed[1] === true, JSON.stringify(armed));
  ck("personal_sign: the window shows the message text and the key", /Firma di un messaggio/.test(txt) && /ciao UP/.test(txt) && txt.includes(addr), txt);
  await click("#sign");
  let sig = await pr;
  ck("personal_sign: signed with the computer key (recovers to its address)", typeof sig === "string" && ethers.verifyMessage("ciao UP", sig) === addr, JSON.stringify(sig));

  const dom = { name: "T", version: "1", chainId: 8453, verifyingContract: "0x" + "11".repeat(20) }, types = { Mail: [{ name: "to", type: "address" }, { name: "body", type: "string" }] }, msg = { to: "0x" + "22".repeat(20), body: "hi" };
  mark();
  pr = f.evaluate(async ([dom, types, msg]) => { try { return await new ethers.BrowserProvider(signerProvider).getSigner().then((s) => s.signTypedData(dom, types, msg)); } catch (e) { return { code: e.code, m: e.message }; } }, [dom, types, msg]);
  txt = await shown();
  ck("typed data: the window shows the type, the domain (name, chain, contract) and the content", /Firma di dati strutturati \(Mail\)/.test(txt) && /T · rete 8453 · 0x1111/.test(txt) && /"body": "hi"/.test(txt), txt);
  await click("#sign");
  sig = await pr;
  ck("typed data: EIP-712 signed by the computer key", typeof sig === "string" && ethers.verifyTypedData(dom, types, msg, sig) === addr, JSON.stringify(sig));

  mark();
  pr = f.evaluate(async (TO) => { try { return await signerProvider.request({ method: "eth_sendTransaction", params: [{ from: signerAddress, to: TO, value: "0x2386f26fc10000", data: "0x12345678aa", chainId: "0x2105", gas: "0x9c40" }] }); } catch (e) { return { code: e.code, m: e.message }; } }, TO);
  txt = await shown();
  ck("transaction: the window shows network, recipient, value, function and maximum gas", /Transazione su Base/.test(txt) && txt.includes(ethers.getAddress(TO)) && /0\.01 ETH/.test(txt) && /0x12345678/.test(txt) && /Gas massimo/.test(txt) && /8453/.test(txt), txt);
  await click("#sign");
  const h = await pr;
  const t = ethers.Transaction.from(raws[0] || "0x");
  ck("transaction: signed for Base by the computer key and sent raw by the page", raws.length === 1 && t.from === addr && t.chainId === 8453n && t.to === ethers.getAddress(TO) && t.value === 10n ** 16n && t.nonce === 7 && h === ethers.keccak256(raws[0]), JSON.stringify({ h, from: t.from }));

  // a transaction to the UP's Key Manager: execute(bytes) with the UP's executeBatch inside
  const KM = "0x" + "4b".repeat(20), TO2 = "0x" + "88".repeat(20);
  const batch = new ethers.Interface(["function executeBatch(uint256[],address[],uint256[],bytes[])"]).encodeFunctionData("executeBatch", [[0, 0], [TO, TO2], [10n ** 16n, 0], ["0x", "0xa9059cbb" + "00".repeat(64)]]);
  const kmData = new ethers.Interface(["function execute(bytes)"]).encodeFunctionData("execute", [batch]);
  mark();
  pr = f.evaluate(async ([KM, data]) => { try { return await signerProvider.request({ method: "eth_sendTransaction", params: [{ from: signerAddress, to: KM, data, chainId: "0x2105", gas: "0x9c40" }] }); } catch (e) { return { code: e.code }; } }, [KM, kmData]);
  txt = await shown();
  ck("a transaction to the Key Manager: the window names what the UP does (execute(bytes), each call's recipient, value and function)", /Key Manager/.test(txt) && txt.includes(ethers.getAddress(KM)) && /la UP esegue/.test(txt) && /2 in un'operazione/.test(txt) && txt.includes(ethers.getAddress(TO)) && /0\.01 ETH/.test(txt) && txt.includes(`Invia 0.01 ETH a ${ethers.getAddress(TO)}`) && txt.includes(ethers.getAddress(TO2)) && /Trasferisce 0 \(unità minime del token\) del token/.test(txt), txt);
  await click("#cancel");
  r = await pr;
  ck("rejected: nothing sent", r && r.code === 4001 && raws.length === 1, JSON.stringify(r));

  // a gas-relay operation through the page's own client (upwallet_signUserOperation)
  const EP = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
  const upIface = new ethers.Interface(["function execute(uint256,address,uint256,bytes)"]);
  const op = { sender: UP, nonce: 3n, initCode: "0x", callData: upIface.encodeFunctionData("execute", [0, TO, 10n ** 16n, "0x12345678"]), callGasLimit: 100000n, verificationGasLimit: 300000n,
    preVerificationGas: 60000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000n, paymasterAndData: "0x" + "ab".repeat(20), signature: "0x" };
  const enc = (ty, va) => ethers.AbiCoder.defaultAbiCoder().encode(ty, va);
  const H = ethers.keccak256(enc(["bytes32", "address", "uint256"], [ethers.keccak256(enc(
    ["address", "uint256", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
    [op.sender, op.nonce, ethers.keccak256(op.initCode), ethers.keccak256(op.callData), op.callGasLimit, op.verificationGasLimit, op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, ethers.keccak256(op.paymasterAndData)])), EP, 8453n]));
  const ser = Object.fromEntries(Object.entries(op).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x]));
  mark();
  pr = f.evaluate(async ([o, H]) => {
    const op = Object.fromEntries(Object.entries(o).map(([k, x]) => [k, /^\d+$/.test(x) ? BigInt(x) : x]));
    const prep = { chainId: 8453, op, hash: H, view: {}, sponsor: null };
    const logs = []; let err = null;
    try { await GasRelayClient.signAndSend(signerProvider, { chainId: 8453, prep, signer: signerAddress, log: (m) => logs.push(m) }); } catch (e) { err = e.message; }
    return { sig: prep.op.signature, logs, err };
  }, [ser, H]);
  txt = await shown();
  ck("gas relay: the window shows the UP's operation (recipient, value, function, gas paid by the site)", /Operazione della UP su Base/.test(txt) && txt.includes(ethers.getAddress(TO)) && /0\.01 ETH/.test(txt) && /0x12345678/.test(txt) && /pagato dal sito/.test(txt), txt);
  await click("#sign");
  const relay = await pr;
  ck("gas relay: the operation hash computed in the signing window, personal_sign by the computer key", ethers.isHexString(relay.sig, 65) && ethers.verifyMessage(ethers.getBytes(H), relay.sig) === addr, JSON.stringify(relay));

  // ---- the key's own balance, sent to the UP
  await f.waitForFunction(() => /Saldo della chiave su Base: 0\.01 ETH/.test(document.getElementById("pkPanel").innerText), null, { timeout: 10000 }).catch(() => null);
  const balTxt = await f.$eval("#pkPanel", (e) => e.innerText);
  ck("the panel shows the key's own balance on the page's network, and the button that sends it to the UP", /Saldo della chiave su Base: 0\.01 ETH/.test(balTxt) && /Manda il saldo della chiave alla UP/.test(balTxt), balTxt);
  mark();
  await f.evaluate(() => [...document.querySelectorAll("#pkPanel button")].find((b) => /Manda il saldo/.test(b.textContent)).click());
  txt = await shown();
  ck("sending the balance: the signing window shows a plain transfer to the UP", /Transazione su Base/.test(txt) && txt.includes(UP) && txt.includes(`a ${UP}`) && /Invia 0\.0\d+ ETH a/.test(txt), txt);
  await click("#sign");
  await f.waitForFunction(() => /Inviato alla UP: 0x[0-9a-f]{64}/.test(document.getElementById("pkPanel").innerText), null, { timeout: 15000 }).catch(() => null);
  const swept = raws.length >= 2 ? ethers.Transaction.from(raws[raws.length - 1]) : null;
  const maxFee = swept ? (swept.maxFeePerGas ?? swept.gasPrice) : 0n;
  ck("sent: to the page's UP, the balance minus the transfer's maximum fee, signed by the computer key", swept && swept.to === UP && swept.from === addr && swept.value + swept.gasLimit * maxFee === 10n ** 16n && swept.value > 0n, swept ? JSON.stringify({ to: swept.to, value: String(swept.value), gas: String(swept.gasLimit), fee: String(maxFee) }) : "no transaction");

  // ---- at every opening: the last UP, the computer key and "Only simulation" come back; the compact header
  await f.evaluate(() => { const c = document.getElementById("simulateOnly"); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); });
  const p3 = await ctx.newPage();
  p3.on("pageerror", (e) => errs.push("page3: " + e.message));
  await p3.setViewportSize({ width: 400, height: 900 });
  await p3.goto(`chrome-extension://${id}/wallet.html`);
  const f3 = await pageFrame(p3);
  await f3.waitForFunction(() => typeof signerAddress !== "undefined" && signerAddress, null, { timeout: 15000 }).catch(() => null);
  const back3 = await f3.evaluate(() => ({ up: document.getElementById("upAddress").value, net: document.getElementById("network").value, signer: typeof signerAddress !== "undefined" ? signerAddress : null, sim: document.getElementById("simulateOnly").checked }));
  ck("at every opening: the last UP, the network, the computer key (no signature) and the \"Only simulation\" choice come back", back3.up === UP && back3.net === "base" && back3.signer === addr && back3.sim === false, JSON.stringify(back3));
  await f3.evaluate(() => { const c = document.getElementById("simulateOnly"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); });
  const head = await f3.evaluate(() => ({ sub: getComputedStyle(document.querySelector(".subtitle")).display, banner: document.querySelector(".brand-logo").getBoundingClientRect().height, card: document.getElementById("upCard").getBoundingClientRect().top, focus: typeof window.__upwalletFocus }));
  ck("side panel: a compact header (the banner smaller, no introduction), the UP's card in the first screen; the notification's click can bring the wallet back", head.sub === "none" && head.banner > 30 && head.banner <= 64 && head.card < 300 && head.focus === "function", JSON.stringify(head));
  await p3.screenshot({ path: process.env.SHOT || require("os").tmpdir() + "/up-wallet-panel.png" });
  const eur = await f3.evaluate(() => [eurToken(42161, "0x0c06cCF38114ddfc35e07427B9424adcca9F44F8", "EURe"), eurToken(42161, "0x0c06cCF38114ddfc35e07427B9424adcca9F44F8", "EURX"), eurToken(42161, "0x" + "11".repeat(20), "EURe"), UsdPrice.tokenUsd("10", { price: 108000000n, decimals: 8 })]);
  ck("euro stablecoins: recognised by address and symbol together, priced at the EUR / USD rate", eur[0] === true && eur[1] === false && eur[2] === false && Math.abs(eur[3] - 10.8) < 1e-9, JSON.stringify(eur));
  await p3.close();
  // Chrome's "Site access" limited: the wallet says so, with a button that asks for it
  const p4 = await ctx.newPage();
  p4.on("pageerror", (e) => errs.push("page4: " + e.message));
  await p4.addInitScript(() => { if (globalThis.chrome && chrome.permissions) chrome.permissions.contains = async () => false; });
  await p4.goto(`chrome-extension://${id}/wallet.html`);
  await p4.waitForSelector("#banner:not([hidden])", { timeout: 10000 }).catch(() => null);
  const acc = await p4.evaluate(() => (document.getElementById("banner") || {}).innerText || "");
  ck("site access withheld by Chrome: the wallet (its host) says so, with a button that asks for it", /Accesso ai siti/.test(acc) && /Consenti/.test(acc), acc);
  await p4.close();

  // ---- a new version announced above the wallet (the site's relay service says which is the latest)
  const updateBox = async (answer) => {
    versionsAnswer = () => answer;
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errs.push("update: " + e.message));
    await pg.goto(`chrome-extension://${id}/wallet.html`);
    await pg.waitForTimeout(1500);
    const out = await pg.evaluate(() => { const b = document.getElementById("update"); return { shown: !b.hidden, text: b.innerText, links: [...b.querySelectorAll("a")].map((a) => [a.textContent, a.href, a.target, a.rel]) }; });
    return { pg, out };
  };
  let up = await updateBox({ extension: { version: "9.9.9", download: OWN + "download/v9.9.9/up-wallet-extension.zip", notes: OWN + "tag/v9.9.9" } });
  ck("a newer version: announced above the wallet, with how to update (same folder, never remove) and its own release links", up.out.shown && /È disponibile UP Wallet 9\.9\.9/.test(up.out.text) && up.out.text.includes(`questa è la ${myVersion}`) && /stessa cartella/.test(up.out.text) && /Non rimuovere mai/.test(up.out.text)
    && up.out.links.length === 2 && up.out.links[0][1] === OWN + "download/v9.9.9/up-wallet-extension.zip" && up.out.links[0][2] === "_blank" && /noopener/.test(up.out.links[0][3]) && up.out.links[1][1] === OWN + "tag/v9.9.9", JSON.stringify(up.out));
  await up.pg.evaluate(() => [...document.querySelectorAll("#update button")].find((b) => /Più tardi/.test(b.textContent)).click());
  const later = await up.pg.evaluate(() => document.getElementById("update").hidden);
  await up.pg.close();
  up = await updateBox({ extension: { version: "9.9.9", download: OWN + "download/v9.9.9/up-wallet-extension.zip", notes: OWN + "tag/v9.9.9" } });
  ck("\"Later\": the same version not announced again for three days", later === true && !up.out.shown, JSON.stringify({ later, out: up.out }));
  await up.pg.close();
  up = await updateBox({ extension: { version: "9.9.10", download: "https://evil.example/up-wallet.zip", notes: "https://github.com/someone/else/releases/tag/v9.9.10" } });
  ck("a link that is not one of this extension's own releases is not shown (the announcement only)", up.out.shown && /9\.9\.10/.test(up.out.text) && up.out.links.length === 0, JSON.stringify(up.out));
  await up.pg.close();
  up = await updateBox({ extension: { version: myVersion, download: OWN + "x", notes: OWN + "y" } });
  const up2 = await updateBox({ extension: { version: "0.0.1", download: OWN + "x", notes: OWN + "y" } });
  ck("the same or an older version: nothing announced", !up.out.shown && !up2.out.shown, JSON.stringify([up.out, up2.out]));
  await up.pg.close(); await up2.pg.close();
  versionsAnswer = () => ({ extension: { version: myVersion, download: OWN + "x", notes: OWN + "y" } });

  // ---- refusals
  const call = (m, params) => f.evaluate(async ([m, params]) => { try { await signerProvider.request({ method: m, params }); return "signed"; } catch (e) { return [e.code, e.message]; } }, [m, params]);
  r = await call("personal_sign", [ethers.hexlify(ethers.randomBytes(32)), addr]);
  ck("an opaque 32-byte message is refused by the signing window, before any passkey", Array.isArray(r) && r[0] === 4100 && /32 byte/.test(r[1]), JSON.stringify(r));
  r = await call("personal_sign", ["0x01", "0x" + "99".repeat(20)]);
  ck("a signature for another account is refused", Array.isArray(r) && r[0] === 4100, JSON.stringify(r));
  r = await f.evaluate(async ([o]) => { try { await signerProvider.request({ method: "upwallet_signUserOperation", params: [{ op: { ...o, sender: "0x" + "55".repeat(20) }, entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", chainId: 8453 }] }); return "signed"; } catch (e) { return [e.code]; } }, [ser]);
  ck("an operation of another UP is refused", Array.isArray(r) && r[0] === 4100, JSON.stringify(r));
  // EXT-02 in the real signing window: a permit warned on top; a declared type that is not the one signed refused.
  const permitTd = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }], Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }] }, primaryType: "Permit", domain: { name: "Tok", chainId: 8453 }, message: { owner: UP, spender: TO, value: "5" } };
  mark();
  pr = call("eth_signTypedData_v4", [addr, JSON.stringify(permitTd)]);
  txt = await shown();
  const warnBox = await signer.evaluate(() => [...document.querySelectorAll("#rows .warn")].map((e) => e.textContent));
  ck("EXT-02: a permit: the signing window warns first (PERMESSO DI SPESA), by the type that is signed", warnBox.length >= 1 && /^⚠️ PERMESSO DI SPESA/.test(warnBox[0]) && /Tipo firmato\s*Permit/.test(txt), JSON.stringify(warnBox) + txt);
  await click("#cancel"); await pr;
  r = await call("eth_signTypedData_v4", [addr, JSON.stringify({ ...permitTd, primaryType: "Login" })]);
  ck("EXT-02: a declared primaryType that is not the one signed: refused before anything is shown (4100)", Array.isArray(r) && r[0] === 4100 && /Login/.test(r[1]), JSON.stringify(r));
  r = await call("eth_sign", []);
  const r2 = await call("debug_traceTransaction", ["0x00"]);
  ck("eth_sign and non-read methods: not supported (4200)", r[0] === 4200 && r2[0] === 4200, JSON.stringify([r, r2]));
  mark();
  pr = call("personal_sign", ["0x" + Buffer.from("rifiutami").toString("hex"), addr]);
  await shown(); await click("#cancel");
  r = await pr;
  ck("rejected in the signing window: 4001, as a wallet answers", Array.isArray(r) && r[0] === 4001, JSON.stringify(r));

  // ---- the wallet page's isolation (review of 2026-11-04, EXT-01): the steps of the review's proof of concept,
  // run in the wallet page, now fail; the host answers only its structured requests.
  const iso = await f.evaluate(async () => {
    const out = {};
    out.chrome = typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id ? "none" : Object.keys(chrome).join();
    out.storageHasKey = JSON.stringify(Object.fromEntries([...Array(localStorage.length)].map((_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))]))).includes("deviceKey");
    try { out.parent = !!window.parent.document; } catch (e) { out.parent = "blocked"; }
    try { out.top = !!window.top.location.href; } catch (e) { out.top = "blocked"; }
    try {
      await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: "required", timeout: 3000, extensions: { prf: { eval: { first: new Uint8Array(32) } } } } });
      out.passkey = "answered";
    } catch (e) { out.passkey = e.name; }
    // The signing window opened by the page itself (a guess of its address): nothing to sign, no reference to it.
    const w = window.open(location.href.replace(/up-wallet\.html.*$/, "ext/signer.html#x"), "_blank");
    try { out.signerDoc = !!(w && w.document); } catch (e) { out.signerDoc = "blocked"; }
    try { if (w) w.close(); } catch (e) { /* none */ }
    const b = window.__upwBridge;
    const tryCall = async (t, a) => { try { return { ok: await b.call(t, a) }; } catch (e) { return { code: e.code, m: e.message }; } };
    out.key = await tryCall("key");
    out.unknown = await tryCall("storage.local.get", { keys: null });
    out.badKind = await tryCall("sign", { kind: "export" });
    out.badRelay = await tryCall("relay", { path: "../../evil", method: "GET" });
    out.otherSite = await tryCall("relay", { path: "relay/info@evil.example/x", method: "GET" });
    out.relay = await fetch("relay/info").then((r) => r.json(), (e) => e.message);
    out.ronin = await new ethers.JsonRpcProvider("https://api.roninchain.com/rpc", 2020, { staticNetwork: true }).send("eth_chainId", []).catch((e) => "err " + e.message);
    out.notProxied = await tryCall("rpc", { url: "https://evil.example/rpc", body: "{}" });
    out.alchemy = await fetch("https://arb-mainnet.g.alchemy.com/v2/testkey1234", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params: [] }) }).then((r) => r.json(), (e) => e.message);
    out.notAlchemy = await tryCall("alchemy", { url: "https://evil.example/v2/testkey1234", method: "GET" });
    out.pair = await WalletKitBundle.WalletKit.init().then((k) => k.pair({ uri: "wc:x" })).then(() => "paired", (e) => e.message);
    out.wcUri = getComputedStyle(document.getElementById("wcUri")).display;
    return out;
  });
  ck("EXT-01: the wallet page has no chrome.* API, and its storage holds no key", iso.chrome === "none" && iso.storageHasKey === false, JSON.stringify(iso));
  ck("EXT-01: the wallet page cannot reach the host's document or the top window", iso.parent === "blocked" && iso.top === "blocked", JSON.stringify(iso));
  ck("EXT-01: the wallet page cannot use the passkey (no PRF, no assertion)", iso.passkey === "NotAllowedError", JSON.stringify(iso));
  ck("EXT-01: a signing window opened by the wallet page is out of its reach", iso.signerDoc !== true, JSON.stringify(iso));
  ck("EXT-01: the host gives the key's address and method only", iso.key.ok && Object.keys(iso.key.ok).sort().join() === "address,method" && iso.key.ok.address === addr, JSON.stringify(iso.key));
  ck("EXT-01: the host refuses anything else (unknown requests, kinds, relay paths)", iso.unknown.code === 4200 && iso.badKind.code === -32602 && iso.badRelay.code === -32602 && iso.otherSite.code === -32602, JSON.stringify(iso));
  ck("the site's relay is reached through the host (wallet.html), not from the sandboxed page", iso.relay && iso.relay.test === "relay-info" && relayOrigins.length > 0 && relayOrigins.every((o) => o === `chrome-extension://${id}/wallet.html`), JSON.stringify({ relay: iso.relay, relayOrigins }));
  ck("Alchemy (the site's key: allowed origins only) reached through the host; no other URL", iso.alchemy && iso.alchemy.result === "alchemy-ok" && alchemyFrames.length > 0 && alchemyFrames.every((x) => x === `chrome-extension://${id}/wallet.html`) && iso.notAlchemy.code === -32602, JSON.stringify({ a: iso.alchemy, alchemyFrames, n: iso.notAlchemy }));
  ck("Ronin's RPC (no CORS for a sandboxed page) reached through the host; no other URL", iso.ronin === "0x7e4" && roninFrames.length > 0 && roninFrames.every((x) => x === `chrome-extension://${id}/wallet.html`) && iso.notProxied.code === -32602, JSON.stringify({ ronin: iso.ronin, roninFrames, np: iso.notProxied }));
  ck("no WalletConnect in the extension: the page's client is the connected sites' stand-in, pairing refused, its link field hidden", /niente WalletConnect/i.test(iso.pair) && iso.wcUri === "none", JSON.stringify(iso));
  const direct = await ctx.newPage();
  await direct.goto(`chrome-extension://${id}/up-wallet.html`, { waitUntil: "commit" });   // stopped: no "load"
  await direct.waitForFunction(() => document.body && /UP Wallet/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => null);
  const alone = await direct.evaluate(() => ({ text: document.body.innerText, wallet: typeof signerProvider }));
  ck("the wallet page opened by itself (outside its host) runs nothing and says where the wallet is", /pulsante dell'estensione|extension's button/.test(alone.text) && alone.wallet === "undefined", JSON.stringify(alone));
  await direct.close();

  // ---- phase 2: the wallet offered to a connected site (EIP-1193 / EIP-6963)
  const DAPP = "https://dapp.test";
  // The site in the signing window is the host's, never the page's word.
  await f.evaluate(() => { window.__upwalletRequestSite = "https://uniswap.org"; });
  mark();
  pr = f.evaluate(async () => { try { return await signerProvider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes("solo mio")), signerAddress] }); } catch (e) { return { code: e.code }; } });
  txt = await shown();
  ck("the signing window names no site the wallet page claims (the host decides it)", !/uniswap/i.test(txt) && !/Richiesta da/.test(txt), txt);
  await click("#cancel"); await pr;
  await f.evaluate(() => { delete window.__upwalletRequestSite; });
  // Chrome's permission for the site: in the test's copy of the manifest (see DIST), as after the user's yes.
  const granted = "ok";
  const dapp = await ctx.newPage();
  dapp.on("pageerror", (e) => errs.push("dapp: " + e.message));
  await dapp.goto(DAPP + "/");
  const dappTab = await p.evaluate(async () => (await chrome.tabs.query({ url: "https://dapp.test/*" }))[0].id);
  // As in the side panel: the active tab's address is not readable (no activeTab grant from the panel itself).
  await p.evaluate(() => { chrome.tabs.query = async () => []; chrome.permissions.request = async () => true; });
  await f.evaluate(() => document.getElementById("upwConnectSite").click());
  await f.waitForFunction(() => /premi il pulsante di UP Wallet/.test(document.querySelector(".upw-dapps").innerText), null, { timeout: 10000 }).catch(() => null);
  const noTab = await f.evaluate(() => document.querySelector(".upw-dapps").innerText);
  ck("no site known (the toolbar button not pressed on it): the panel says to press it there, nothing connected", /premi il pulsante di UP Wallet/.test(noTab) && /Nessun sito collegato/.test(noTab), noTab);
  // The toolbar button pressed on the dApp's tab: the service worker notes that tab's site (action.onClicked).
  await sw.evaluate((tabId) => chrome.storage.session.set({ actionTab: { id: tabId, origin: "https://dapp.test", at: Date.now() } }), dappTab);
  await f.evaluate(() => document.getElementById("upwConnectSite").click());
  await f.waitForFunction(() => /Collegato: https:\/\/dapp\.test/.test(document.querySelector(".upw-dapps").innerText), null, { timeout: 10000 }).catch(() => null);
  const sitesTxt = await f.evaluate(() => document.querySelector(".upw-dapps").innerText);
  ck("panel 4: the active tab's site connected with Chrome's permission for that site only, listed", granted === "ok" && /Collegato: https:\/\/dapp\.test/.test(sitesTxt) && /https:\/\/dapp\.test — non connesso alla UP ora/.test(sitesTxt), granted + " / " + sitesTxt);
  const announced = async () => dapp.evaluate(() => new Promise((ok) => {
    const got = []; window.addEventListener("eip6963:announceProvider", (e) => got.push(e.detail));
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => { window.__upw = (got.find((d) => d.info.rdns === "it.chainintegrate.upwallet") || {}).provider; ok({ list: got.map((d) => [d.info.name, d.info.rdns, d.info.icon.slice(0, 22)]), eth: typeof window.ethereum }); }, 100);
  }));
  let ann = await announced();
  ck("the connected site's page gets UP Wallet at once, announced through EIP-6963 (not window.ethereum)", ann.list.length === 1 && ann.list[0][0] === "UP Wallet" && ann.list[0][1] === "it.chainintegrate.upwallet" && ann.list[0][2] === "data:image/png;base64," && ann.eth === "undefined", JSON.stringify(ann));
  await dapp.reload();
  ann = await announced();
  ck("and at every load (a content script registered for that site only)", ann.list.length === 1 && ann.list[0][0] === "UP Wallet", JSON.stringify(ann));
  const req = (method, params) => dapp.evaluate(async ([method, params]) => { try { return { r: await window.__upw.request({ method, params }) }; } catch (e) { return { code: e.code, m: e.message }; } }, [method, params]);
  let d1 = await req("eth_chainId"), d2 = await req("eth_accounts"), d3 = await req("personal_sign", ["0x01", UP]);
  ck("before connecting: the wallet's network, no account, nothing signed (4100)", d1.r === "0x2105" && Array.isArray(d2.r) && d2.r.length === 0 && d3.code === 4100, JSON.stringify([d1, d2, d3]));
  // The page's check of panel 3 green (the mocked network gives no real permissions): the UP on Base, with SIGN.
  await f.evaluate(([UP, signer]) => {
    const net = NETWORKS.find((n) => n.key === "base");
    compliance = { caip: "eip155:8453", up: UP, chainId: 8453, net, provider: new ethers.JsonRpcProvider(net.rpc, 8453, { staticNetwork: true }), perms: P.SIGN | P.CALL | P.TRANSFERVALUE, signer, km: "0x" + "4b".repeat(20) };
    // Fixed: the page's own check, run again by itself on the mocked network, would turn it back to null.
    const fixed = compliance;
    window.freshCompliance = async () => fixed;
  }, [UP, addr]);
  await dapp.evaluate(() => { window.__ev = []; window.__upw.on("accountsChanged", (a) => window.__ev.push(["accountsChanged", a])); window.__upw.on("chainChanged", (c) => window.__ev.push(["chainChanged", c])); });
  d1 = await req("eth_requestAccounts");
  d2 = await req("eth_accounts");
  const ev = await dapp.evaluate(() => window.__ev);
  const logTxt = await f.evaluate(() => document.getElementById("log").textContent);
  ck("connect (eth_requestAccounts): the wallet page's check approves it, the site gets the UP and the events", d1.r && d1.r[0] === UP && d2.r[0] === UP && ev.some((e) => e[0] === "accountsChanged" && e[1][0] === UP) && /Richiesta di connessione da: dapp\.test/.test(logTxt) && /indirizzo dato dal browser/.test(logTxt), JSON.stringify({ d1, d2, ev, log: logTxt.slice(-1500) }));
  const sitesNow = await f.evaluate(() => document.querySelector(".upw-dapps").innerText);
  ck("panel 4 shows the site using the UP on its network", sitesNow.includes(`https://dapp.test — usa la UP ${UP} su chainId 8453`), sitesNow);
  d1 = await req("eth_getBalance", [UP, "latest"]);
  d2 = await req("wallet_watchAsset", [{}]);
  d3 = await req("wallet_switchEthereumChain", [{ chainId: "0x2a" }]);
  const d4 = await req("wallet_addEthereumChain", [{ chainId: "0x1" }]);
  ck("reads answered from the network's RPC; other methods refused (4200); another network refused with 4901, not 4001 (wagmi's connect drops the connection on 4001)", d1.r === "0x2386f26fc10000" && d2.code === 4200 && d3.code === 4901 && d4.code === 4901, JSON.stringify([d1, d2, d3, d4]));
  // EXT-02 in the page (0.14.1): a site's typed data whose declared type is not the one signed is rejected there.
  const lie = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }], TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }] }, primaryType: "Login", domain: { name: "USD Coin", chainId: 8453 }, message: { from: UP, to: TO, value: "1000000" } };
  d1 = await req("eth_signTypedData_v4", [UP, JSON.stringify(lie)]);
  const lieLog = await f.evaluate(() => document.getElementById("log").textContent);
  ck("EXT-02 (page): a site's typed data declared \"Login\" but signing a TransferWithAuthorization: rejected by the page (4001)", d1.code === 4001 && /dichiara il tipo "Login" ma si firmerebbe "TransferWithAuthorization"/.test(lieLog), JSON.stringify(d1) + lieLog.slice(-300));
  // personal_sign from the site: the page's request window, then the signing window, which names the site.
  const dsig = dapp.evaluate(async (UP) => { try { return { r: await window.__upw.request({ method: "personal_sign", params: ["0x" + Array.from(new TextEncoder().encode("hello dApp"), (b) => b.toString(16).padStart(2, "0")).join(""), UP] }) }; } catch (e) { return { code: e.code, m: e.message }; } }, UP);
  await f.waitForFunction(() => !document.getElementById("requestModal").hidden && !document.getElementById("signBtn").disabled, null, { timeout: 15000 });
  const modal = await f.evaluate(() => document.getElementById("requestModal").innerText);
  mark();
  // Pressed from the page's code: Playwright 1.56 (CI) does not deliver a mouse click inside the sandboxed frame.
  await f.$eval("#signBtn", (b) => b.click());
  txt = await shown();
  ck("a site's message: the wallet's request window names the site, the signing window names it as Chrome gave it", /dapp\.test/.test(modal) && /hello dApp/.test(modal) && /Richiesta da: https:\/\/dapp\.test/.test(txt) && /hello dApp/.test(txt), modal.slice(0, 300) + " / " + txt);
  await click("#sign");
  const ds = await dsig;
  ck("the site gets the signature of the computer key, checked by the UP (ERC-1271) before it goes", typeof ds.r === "string" && ethers.verifyMessage("hello dApp", ds.r) === addr, JSON.stringify(ds));
  // disconnecting the site: no account, no permission, nothing reaches the wallet
  await dapp.evaluate(() => { window.__ev = []; });
  await f.evaluate(() => [...document.querySelectorAll(".upw-dapps button")].find((b) => /Scollega/.test(b.textContent)).click());
  await f.waitForFunction(() => /Nessun sito collegato/.test(document.querySelector(".upw-dapps").innerText), null, { timeout: 10000 }).catch(() => null);
  const evOff = await dapp.evaluate(() => window.__ev);
  d1 = await req("eth_accounts");
  ck("disconnected: the site is told (no account) and refused afterwards (4100)", evOff.some((e) => e[0] === "accountsChanged" && e[1].length === 0) && d1.code === 4100, JSON.stringify({ evOff, d1 }));
  await dapp.reload();
  ann = await announced();
  ck("a disconnected site's page no longer gets UP Wallet", ann.list.length === 0, JSON.stringify(ann));
  await dapp.close();

  // ---- a password key
  mark();
  pr = f.evaluate(async () => { [...document.querySelectorAll("#pkPanel button")].find((b) => /Elimina/.test(b.textContent)).click(); });
  txt = await shown();
  ck("delete: the window says to revoke the key on every network first", /Elimina la chiave di questo computer/.test(txt) && /revocala su ogni rete/.test(txt), txt);
  await click("#sign");
  await f.waitForFunction(() => /Nessuna chiave/.test(document.getElementById("pkPanel").innerText), null, { timeout: 10000 });
  ck("deleted: no key left", !(await signer.evaluate(async () => (await chrome.storage.local.get("deviceKey")).deviceKey)));
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });   // no passkey from here on
  mark();
  await f.click("#connectSigner");
  await shown();
  await click("#alt");   // shows the password fields
  await signer.fill("#pw", "corta"); await signer.fill("#pw2", "corta");
  await click("#alt");
  const shortErr = await signer.$eval("#err", (e) => e.textContent);
  ck("password: too short is refused", /almeno 12 caratteri/.test(shortErr), shortErr);
  await signer.fill("#pw", "una password lunga abbastanza"); await signer.fill("#pw2", "una password lunga abbastanza");
  await click("#alt");
  await f.waitForFunction((old) => typeof signerAddress !== "undefined" && signerAddress && signerAddress !== old, addr, { timeout: 15000 });
  const k2 = await signer.evaluate(async () => (await chrome.storage.local.get("deviceKey")).deviceKey);
  const addr2 = await f.evaluate(() => signerAddress);
  ck("password key: created, PBKDF2 600,000 rounds, stored encrypted", k2 && k2.method === "password" && k2.rounds === 600000 && ethers.getAddress(k2.address) === ethers.getAddress(addr2), JSON.stringify(k2));
  mark();
  pr = f.evaluate(async () => { try { return await signerProvider.request({ method: "personal_sign", params: ["0x" + Array.from(new TextEncoder().encode("con password"), (b) => b.toString(16).padStart(2, "0")).join(""), signerAddress] }); } catch (e) { return { code: e.code }; } });
  await shown();
  await signer.fill("#pw", "sbagliata sbagliata");
  await click("#sign");
  await signer.waitForFunction(() => !document.getElementById("err").hidden);
  const wrong = await signer.$eval("#err", (e) => e.textContent);
  ck("password key: a wrong password opens nothing", /Password sbagliata/.test(wrong), wrong);
  await signer.fill("#pw", "una password lunga abbastanza");
  await click("#sign");
  sig = await pr;
  ck("password key: the right password signs", typeof sig === "string" && ethers.verifyMessage("con password", sig) === addr2, JSON.stringify(sig));

  // ---- a site's request with the wallet closed: the wallet opens by itself, the request waits for it; closed
  // with the request open, the site is refused (4001)
  const dapp2 = await ctx.newPage();
  dapp2.on("pageerror", (e) => errs.push("dapp2: " + e.message));
  await dapp2.goto(DAPP + "/");
  const dapp2Tab = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://dapp.test/*" }))[0].id);
  await sw.evaluate((tabId) => chrome.storage.session.set({ actionTab: { id: tabId, origin: "https://dapp.test", at: Date.now() } }), dapp2Tab);
  await f.evaluate(() => document.getElementById("upwConnectSite").click());
  await f.waitForFunction(() => /Collegato: https:\/\/dapp\.test/.test(document.querySelector(".upw-dapps").innerText), null, { timeout: 10000 }).catch(() => null);
  const got = await dapp2.evaluate(() => new Promise((ok) => { window.addEventListener("eip6963:announceProvider", (e) => { window.__upw = e.detail.provider; ok(true); }); window.dispatchEvent(new Event("eip6963:requestProvider")); setTimeout(() => ok(false), 5000); }));
  if (!got) throw new Error("the provider was not injected in the second dApp page");
  const req2 = (method, params) => dapp2.evaluate(async ([method, params]) => { try { return { r: await window.__upw.request({ method, params }) }; } catch (e) { return { code: e.code, m: e.message }; } }, [method, params]);
  const setCompliance = (fr) => fr.evaluate(([UP, signer]) => {
    const net = NETWORKS.find((n) => n.key === "base");
    compliance = { caip: "eip155:8453", up: UP, chainId: 8453, net, provider: new ethers.JsonRpcProvider(net.rpc, 8453, { staticNetwork: true }), perms: P.SIGN | P.CALL | P.TRANSFERVALUE, signer, km: "0x" + "4b".repeat(20) };
    const fixed = compliance;
    window.freshCompliance = async () => fixed;
  }, [UP, addr2]);
  await setCompliance(f);
  const c2 = await req2("eth_requestAccounts");
  await sw.evaluate(() => { self.__opened = []; chrome.windows.create = async (o) => { self.__opened.push(o); return { id: -7 }; }; });
  await p.close();
  const waitingSig = req2("personal_sign", ["0x" + Buffer.from("mentre chiuso").toString("hex"), UP]);
  let opened = null;
  for (let i = 0; i < 50 && !opened; i++) { opened = await sw.evaluate(() => self.__opened[0] || null); if (!opened) await new Promise((ok) => setTimeout(ok, 100)); }
  ck("a site's request with the wallet closed: the wallet opens by itself, in a window at the top right", c2.r && c2.r[0] === UP && opened && opened.type === "popup" && /wallet\.html\?dapp=1$/.test(opened.url) && opened.focused === true, JSON.stringify({ c2, opened }));
  const w2 = await ctx.newPage();
  w2.on("pageerror", (e) => errs.push("wallet2: " + e.message));
  await w2.goto(`chrome-extension://${id}/wallet.html?dapp=1`);
  const f2 = await pageFrame(w2);
  await f2.waitForFunction(() => typeof ethers !== "undefined" && typeof NETWORKS !== "undefined" && typeof P !== "undefined", null, { timeout: 15000 });
  // The page's own check runs at load (and fails on the mocked network): set it green until the request shows.
  for (let i = 0; i < 40; i++) {
    await setCompliance(f2);
    if (await f2.evaluate(() => !document.getElementById("requestModal").hidden)) break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const m2 = await f2.evaluate(() => document.getElementById("requestModal").innerText);
  ck("the opened wallet takes the waiting request once its checks are green", /mentre chiuso/.test(m2) && /dapp\.test/.test(m2), m2.slice(0, 300));
  await w2.close();
  const closed = await waitingSig;
  ck("the wallet closed with the site's request open: the site is refused (4001)", closed.code === 4001, JSON.stringify(closed));
  await dapp2.close();

  ck("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
  console.log(res.join("\n"));
  const fails = res.filter((x) => x.startsWith("FAIL")).length;
  console.log(fails ? `${fails} FAILED` : `${res.length}/${res.length}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log(res.join("\n")); console.error(e); process.exit(1); });
