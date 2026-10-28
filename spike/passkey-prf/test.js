// Phase 0: can an extension page use a passkey with the WebAuthn PRF extension? The PRF output would be
// the key that decrypts the wallet's own key; here it is only fingerprinted (SHA-256, first 8 bytes) to
// check that two unlocks give the same value. Nothing is sent anywhere; only the test credential's id is
// kept, in this extension's localStorage.
const $ = (id) => document.getElementById(id);
const lines = [];
function log(text, cls) {
  lines.push(text);
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\n";
  $("out").appendChild(span);
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(data) { return crypto.subtle.digest("SHA-256", data); }
async function salt() { return sha256(new TextEncoder().encode("up-wallet-extension prf test v1")); }
const errText = (e) => `${e && e.name ? e.name : "Error"}: ${e && e.message ? e.message : String(e)}`;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* none */ } } };

async function info() {
  log("== Info");
  log(`origin: ${location.origin}`);
  log(`hostname (default rp id): ${location.hostname}`);
  log(`secure context: ${window.isSecureContext}`);
  log(`userAgent: ${navigator.userAgent}`);
  try {
    if (navigator.userAgentData) {
      const h = await navigator.userAgentData.getHighEntropyValues(["platformVersion", "fullVersionList"]);
      log(`platform: ${navigator.userAgentData.platform} ${h.platformVersion} (Windows 11 is 13 or more)`);
      log(`browser: ${(h.fullVersionList || []).map((x) => `${x.brand} ${x.version}`).join(", ")}`);
    }
  } catch (e) { log(`userAgentData: ${errText(e)}`); }
  log(`PublicKeyCredential: ${typeof PublicKeyCredential !== "undefined"}`);
  try { log(`platform authenticator (Windows Hello): ${await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()}`); }
  catch (e) { log(`platform authenticator: ${errText(e)}`); }
  try {
    if (PublicKeyCredential.getClientCapabilities) {
      const c = await PublicKeyCredential.getClientCapabilities();
      log(`client capabilities: ${Object.entries(c).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
    } else log("client capabilities: not available in this browser");
  } catch (e) { log(`client capabilities: ${errText(e)}`); }
  log(`stored test credential: ${store.get("prfTestId") ? "yes" : "no"}`);
}

async function create() {
  log("== Create");
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: "UP Wallet extension test" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "up-wallet-extension-test", displayName: "UP Wallet extension test" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
      timeout: 120000,
      extensions: { prf: { eval: { first: await salt() } } },
    } });
    store.set("prfTestId", b64u(cred.rawId));
    const ext = cred.getClientExtensionResults();
    log(`created: credential ${b64u(cred.rawId).slice(0, 16)}…`, "ok");
    log(`authenticator attachment: ${cred.authenticatorAttachment || "?"}`);
    log(`prf.enabled: ${ext.prf ? ext.prf.enabled : "no prf in the answer"}`, ext.prf && ext.prf.enabled ? "ok" : "err");
    if (ext.prf && ext.prf.results && ext.prf.results.first) log(`prf at creation: yes, fingerprint ${hex(await sha256(ext.prf.results.first)).slice(0, 16)}`, "ok");
    else log("prf at creation: no value (normal on some systems: step 2 is the real test)");
  } catch (e) { log(`create failed: ${errText(e)}`, "err"); }
}

async function unlock() {
  log("== Unlock");
  const id = store.get("prfTestId");
  if (!id) { log("no test credential: do step 1 first", "err"); return; }
  try {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: fromB64u(id) }],
      userVerification: "required",
      timeout: 120000,
      extensions: { prf: { eval: { first: await salt() } } },
    } });
    const ext = a.getClientExtensionResults();
    if (!ext.prf || !ext.prf.results || !ext.prf.results.first) { log("unlock: signed, but NO PRF value (the passkey works, PRF does not)", "err"); return; }
    const fp = hex(await sha256(ext.prf.results.first)).slice(0, 16);
    const prev = store.get("prfTestFp");
    log(`unlock: PRF value received, ${ext.prf.results.first.byteLength} bytes, fingerprint ${fp}`, "ok");
    if (!prev) { store.set("prfTestFp", fp); log("first unlock: press 2 again to check the value is the same"); }
    else log(prev === fp ? "same value as the previous unlock: PRF WORKS from the extension ✅" : `DIFFERENT from the previous unlock (${prev}) ❌`, prev === fp ? "ok" : "err");
  } catch (e) { log(`unlock failed: ${errText(e)}`, "err"); }
}

$("info").addEventListener("click", info);
$("create").addEventListener("click", create);
$("unlock").addEventListener("click", unlock);
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(lines.join("\n")); log("(copied)"); } catch (e) { log(`copy failed: ${errText(e)}: select the text and copy it by hand`, "err"); }
});
info();
