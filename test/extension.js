// The extension in Chromium, from dist/ (run `npm run build` first), with a virtual WebAuthn authenticator that
// supports PRF (Chrome DevTools Protocol): the page loads with the computer key as its only wallet, the key is
// created in the signing window (passkey, then password), and messages, typed data, transactions and gas-relay
// operations are signed there; refusals and cancellations. Network calls to the RPCs are mocked.
//   PLAYWRIGHT=/path/to/playwright node test/extension.js
"use strict";
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const { ethers } = require("ethers");

const DIST = path.join(__dirname, "..", "dist");
const res = []; const ck = (n, c, x = "") => res.push(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : "\n      " + String(x).slice(0, 1500)}`);
const UP = "0x4a2605796e0d91A9667d6E30365aEEC384C48c27", TO = "0x" + "77".repeat(20);

(async () => {
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  const errs = [], csp = [], raws = [];
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
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
          default: return ok("0x");
        }
      };
      return r.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)) });
    }
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
  await p.goto(`chrome-extension://${id}/up-wallet.html`);
  await p.waitForFunction(() => typeof ethers !== "undefined" && document.getElementById("connectSigner") && typeof GasRelayClient !== "undefined");
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

  const seen = await p.evaluate(() => new Promise((ok) => {
    const got = []; window.addEventListener("eip6963:announceProvider", (e) => got.push(e.detail.info.name));
    window.dispatchEvent(new Event("eip6963:requestProvider")); setTimeout(() => ok(got), 50);
  }));
  ck("the page loads in the extension, the computer key announced as its only wallet (EIP-6963)", seen.length === 1 && seen[0] === "Computer key (UP Wallet)", JSON.stringify(seen));
  const sp = await p.evaluate(async () => ({ b: await chrome.sidePanel.getPanelBehavior(), m: chrome.runtime.getManifest() }));
  ck("the toolbar button opens the wallet in the side panel (side_panel in the manifest, panel behaviour set)", sp.b.openPanelOnActionClick === true && sp.m.side_panel.default_path === "up-wallet.html", JSON.stringify(sp.b));
  ck("no inline script left in the page; nothing refused by the Content-Security-Policy", await p.evaluate(() => [...document.scripts].every((s) => s.src)) && csp.length === 0, csp.join(" | "));
  const v = await p.$eval("#pageVersion", (e) => e.textContent);
  ck("the version line names the page version", /UP Wallet · (versione della pagina|page version) 2026-/.test(v), v);
  const texts = await p.evaluate(() => ({ cls: document.documentElement.classList.contains("computer-key"), p3: document.querySelector('[data-i18n="panel3Title"]').textContent, ready: t("readyToSend"), perms: t("permsNone"), relay: GasRelayClient.text("optionNote", { pm: "PM" }), body: document.body.innerText }));
  const leftover = (texts.body.replace(/Nessuna affiliazione[^.]*\./, "").match(/.{0,60}(MetaMask|telefono|impronta).{0,60}/g) || []).filter((x) => !/Questo telefono|Autorizza un dispositivo/.test(x));
  ck("the page's texts name the computer key and the signing window, not MetaMask, the phone or the fingerprint", texts.cls && texts.p3 === "3 · Controller (chiave del computer) e verifica" && /conferma nella finestra di firma/.test(texts.ready) && /Autorizza un dispositivo/.test(texts.perms) && /chiave del computer\) firma un messaggio nella finestra di firma/.test(texts.relay) && leftover.length === 0, JSON.stringify({ ...texts, body: leftover }));
  const warn = await p.evaluate(() => (document.getElementById("pkWarn") || {}).innerText || "");
  ck("first start: the warning (experimental, the maintainer's wallet, can move the funds, no copy)", /wallet sperimentale/.test(warn) && /muoverne i fondi/.test(warn) && /non ha copie/.test(warn), warn);
  await p.click("#pkWarnOk");

  // ---- create with a passkey
  await p.selectOption("#network", "base");
  await p.fill("#upAddress", UP);
  mark();
  await p.click("#connectSigner");
  let txt = await shown();
  ck("connect: the signing window offers to create the key with a passkey or a password", /Crea la chiave di questo computer/.test(txt) && /Crea con una passkey/.test(txt) && /Usa una password/.test(txt), txt);
  await click("#sign");
  await p.waitForFunction(() => typeof signerAddress !== "undefined" && signerAddress, null, { timeout: 15000 })
    .catch(async (e) => { console.log("SIGNER:", await signer.evaluate(() => document.body.innerText), "PAGE:", await p.evaluate(() => [document.getElementById("pkPanel").innerText, (document.getElementById("log") || {}).innerText].join(" / ")), errs); throw e; });
  const pos = await p.evaluate(async () => ({ c: window.__lastCreate, w: await chrome.windows.getCurrent() }));
  ck("the signing window is a small popup at the top right of the browser window, focused", pos.c.type === "popup" && pos.c.width === 400 && pos.c.focused === true && pos.c.left === pos.w.left + pos.w.width - 412 && pos.c.top === pos.w.top + 72, JSON.stringify(pos));
  const k1 = await signer.evaluate(async () => (await chrome.storage.local.get("deviceKey")).deviceKey);
  const addr = await p.evaluate(() => signerAddress);
  ck("passkey key: created and stored encrypted (no private key in storage), the page uses its address", k1 && k1.method === "passkey" && ethers.getAddress(k1.address) === ethers.getAddress(addr) && !/^0x[0-9a-f]{64}$/i.test(JSON.stringify(k1)) && k1.ct && k1.credId && k1.prfSalt, JSON.stringify(k1));
  const panel = await p.$eval("#pkPanel", (e) => e.innerText);
  ck("the panel shows the address, passkey, and how to authorize it", panel.includes(addr) && /passkey/.test(panel) && /Autorizza un dispositivo/.test(panel), panel);

  // ---- signatures
  const ask = (fn, arg) => p.evaluate(fn, arg).then((r) => r, (e) => ({ err: e.message }));
  mark();
  let pr = p.evaluate(async () => { try { return await signerProvider.request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes("ciao UP")), signerAddress] }); } catch (e) { return { code: e.code }; } });
  txt = await shown();
  ck("personal_sign: the window shows the message text and the key", /Firma di un messaggio/.test(txt) && /ciao UP/.test(txt) && txt.includes(addr), txt);
  await click("#sign");
  let sig = await pr;
  ck("personal_sign: signed with the computer key (recovers to its address)", typeof sig === "string" && ethers.verifyMessage("ciao UP", sig) === addr, JSON.stringify(sig));

  const dom = { name: "T", version: "1", chainId: 8453, verifyingContract: "0x" + "11".repeat(20) }, types = { Mail: [{ name: "to", type: "address" }, { name: "body", type: "string" }] }, msg = { to: "0x" + "22".repeat(20), body: "hi" };
  mark();
  pr = p.evaluate(async ([dom, types, msg]) => { try { return await new ethers.BrowserProvider(signerProvider).getSigner().then((s) => s.signTypedData(dom, types, msg)); } catch (e) { return { code: e.code, m: e.message }; } }, [dom, types, msg]);
  txt = await shown();
  ck("typed data: the window shows the type, the domain (name, chain, contract) and the content", /Firma di dati strutturati \(Mail\)/.test(txt) && /T · rete 8453 · 0x1111/.test(txt) && /"body": "hi"/.test(txt), txt);
  await click("#sign");
  sig = await pr;
  ck("typed data: EIP-712 signed by the computer key", typeof sig === "string" && ethers.verifyTypedData(dom, types, msg, sig) === addr, JSON.stringify(sig));

  mark();
  pr = p.evaluate(async (TO) => { try { return await signerProvider.request({ method: "eth_sendTransaction", params: [{ from: signerAddress, to: TO, value: "0x2386f26fc10000", data: "0x12345678aa", chainId: "0x2105", gas: "0x9c40" }] }); } catch (e) { return { code: e.code, m: e.message }; } }, TO);
  txt = await shown();
  ck("transaction: the window shows network, recipient, value, function and maximum gas", /Transazione su Base/.test(txt) && txt.includes(ethers.getAddress(TO)) && /0\.01 ETH/.test(txt) && /0x12345678/.test(txt) && /Gas massimo/.test(txt) && /8453/.test(txt), txt);
  await click("#sign");
  const h = await pr;
  const t = ethers.Transaction.from(raws[0] || "0x");
  ck("transaction: signed for Base by the computer key and sent raw by the page", raws.length === 1 && t.from === addr && t.chainId === 8453n && t.to === ethers.getAddress(TO) && t.value === 10n ** 16n && t.nonce === 7 && h === ethers.keccak256(raws[0]), JSON.stringify({ h, from: t.from }));

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
  pr = p.evaluate(async ([o, H]) => {
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

  // ---- refusals
  const call = (m, params) => p.evaluate(async ([m, params]) => { try { await signerProvider.request({ method: m, params }); return "signed"; } catch (e) { return [e.code, e.message]; } }, [m, params]);
  let r = await call("personal_sign", [ethers.hexlify(ethers.randomBytes(32)), addr]);
  ck("an opaque 32-byte message is refused by the signing window, before any passkey", Array.isArray(r) && r[0] === 4100 && /32 byte/.test(r[1]), JSON.stringify(r));
  r = await call("personal_sign", ["0x01", "0x" + "99".repeat(20)]);
  ck("a signature for another account is refused", Array.isArray(r) && r[0] === 4100, JSON.stringify(r));
  r = await p.evaluate(async ([o]) => { try { await signerProvider.request({ method: "upwallet_signUserOperation", params: [{ op: { ...o, sender: "0x" + "55".repeat(20) }, entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", chainId: 8453 }] }); return "signed"; } catch (e) { return [e.code]; } }, [ser]);
  ck("an operation of another UP is refused", Array.isArray(r) && r[0] === 4100, JSON.stringify(r));
  r = await call("eth_sign", []);
  const r2 = await call("debug_traceTransaction", ["0x00"]);
  ck("eth_sign and non-read methods: not supported (4200)", r[0] === 4200 && r2[0] === 4200, JSON.stringify([r, r2]));
  mark();
  pr = call("personal_sign", ["0x" + Buffer.from("rifiutami").toString("hex"), addr]);
  await shown(); await click("#cancel");
  r = await pr;
  ck("rejected in the signing window: 4001, as a wallet answers", Array.isArray(r) && r[0] === 4001, JSON.stringify(r));

  // ---- a password key
  mark();
  pr = p.evaluate(async () => { [...document.querySelectorAll("#pkPanel button")].find((b) => /Elimina/.test(b.textContent)).click(); });
  txt = await shown();
  ck("delete: the window says to revoke the key on every network first", /Elimina la chiave di questo computer/.test(txt) && /revocala su ogni rete/.test(txt), txt);
  await click("#sign");
  await p.waitForFunction(() => /Nessuna chiave/.test(document.getElementById("pkPanel").innerText), null, { timeout: 10000 });
  ck("deleted: no key left", !(await signer.evaluate(async () => (await chrome.storage.local.get("deviceKey")).deviceKey)));
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });   // no passkey from here on
  mark();
  await p.click("#connectSigner");
  await shown();
  await click("#alt");   // shows the password fields
  await signer.fill("#pw", "corta"); await signer.fill("#pw2", "corta");
  await click("#alt");
  const shortErr = await signer.$eval("#err", (e) => e.textContent);
  ck("password: too short is refused", /almeno 12 caratteri/.test(shortErr), shortErr);
  await signer.fill("#pw", "una password lunga abbastanza"); await signer.fill("#pw2", "una password lunga abbastanza");
  await click("#alt");
  await p.waitForFunction((old) => typeof signerAddress !== "undefined" && signerAddress && signerAddress !== old, addr, { timeout: 15000 });
  const k2 = await signer.evaluate(async () => (await chrome.storage.local.get("deviceKey")).deviceKey);
  const addr2 = await p.evaluate(() => signerAddress);
  ck("password key: created, PBKDF2 600,000 rounds, stored encrypted", k2 && k2.method === "password" && k2.rounds === 600000 && ethers.getAddress(k2.address) === ethers.getAddress(addr2), JSON.stringify(k2));
  mark();
  pr = p.evaluate(async () => { try { return await signerProvider.request({ method: "personal_sign", params: ["0x" + Array.from(new TextEncoder().encode("con password"), (b) => b.toString(16).padStart(2, "0")).join(""), signerAddress] }); } catch (e) { return { code: e.code }; } });
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

  ck("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
  console.log(res.join("\n"));
  const fails = res.filter((x) => x.startsWith("FAIL")).length;
  console.log(fails ? `${fails} FAILED` : `${res.length}/${res.length}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log(res.join("\n")); console.error(e); process.exit(1); });
