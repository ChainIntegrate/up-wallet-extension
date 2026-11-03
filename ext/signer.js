// UP Wallet extension: the signing window. The only place where the extension's key is ever in clear.
//
// The key is a secp256k1 private key (a controller of the UP, authorized from the site's Backup page with no
// admin permissions), kept in chrome.storage.local only encrypted with AES-256-GCM. The AES key comes from:
//   - a passkey, through WebAuthn's PRF extension: HKDF-SHA256 of the PRF value; the passkey belongs to this
//     extension's id (its relying party), asks for the user (fingerprint, face, PIN) at every signature;
//   - or a password, the fallback for browsers or authenticators without PRF: PBKDF2-SHA256, 600,000 rounds.
// For each request this window shows what is signed, computed here from the request itself (not from the
// wallet page's words), asks for the passkey or the password, decrypts the key, signs, checks the signature,
// and answers the wallet page with the signature only. The wallet page (with WalletConnect and the decoders)
// never sees the key.
import { ethers } from "ethers";
import { plan } from "./sign-plan.js";

const api = globalThis.chrome;
const STORE = "deviceKey";
const HKDF_INFO = new TextEncoder().encode("up-wallet-extension key encryption v1");
const PBKDF2_ROUNDS = 600000;
const MIN_PASSWORD = 12;

const $ = (id) => document.getElementById(id);
// The wallet page's language, sent with each request; the browser's until then.
let lang = /^it\b/i.test(navigator.language || "") ? "it" : "en";
const en = () => lang !== "it";
const L = (it, eng) => (en() ? eng : it);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const wipe = (u8) => { if (u8 && u8.fill) u8.fill(0); };
const rpcError = (code, message) => ({ code, message });

// ---- the stored key
async function loadKey() { return (await api.storage.local.get(STORE))[STORE] || null; }
async function saveKey(k) { await api.storage.local.set({ [STORE]: k }); }

async function aesFromPrf(prf, salt) {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function aesFromPassword(password, salt, rounds) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// The PRF value of the stored passkey: asks for the user. Null when the authenticator gives none.
async function prfOf(credId, prfSalt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: credId ? [{ type: "public-key", id: credId }] : [],
    userVerification: "required",
    timeout: 120000,
    extensions: { prf: { eval: { first: prfSalt } } },
  } });
  const r = a.getClientExtensionResults().prf;
  return { prf: r && r.results && r.results.first ? new Uint8Array(r.results.first) : null, credId: new Uint8Array(a.rawId) };
}

async function unlockAes(k, password) {
  if (k.method === "passkey") {
    const { prf } = await prfOf(unb64(k.credId), unb64(k.prfSalt));
    if (!prf) throw new Error(L("La passkey non ha dato il segreto (PRF): non posso aprire la chiave.", "The passkey gave no secret (PRF): the key cannot be opened."));
    try { return await aesFromPrf(prf, unb64(k.hkdfSalt)); } finally { wipe(prf); }
  }
  return aesFromPassword(password, unb64(k.kdfSalt), k.rounds);
}

// The private key in clear, for one signature. The caller wipes it.
async function openKey(k, password) {
  const aes = await unlockAes(k, password);
  let raw;
  try { raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(k.iv) }, aes, unb64(k.ct))); }
  catch (e) { throw new Error(k.method === "password" ? L("Password sbagliata.", "Wrong password.") : L("La chiave non si apre con questa passkey.", "The key does not open with this passkey.")); }
  return raw;
}

async function signDigest(k, digest, password) {
  const raw = await openKey(k, password);
  try {
    const sig = new ethers.SigningKey(raw).sign(digest);
    // The signature must recover to the stored address, or nothing goes out.
    if (ethers.recoverAddress(digest, sig) !== k.address) throw new Error("signature check failed");
    return sig;
  } finally { wipe(raw); }
}

// ---- creating the key
async function createWithPasskey() {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: "UP Wallet (browser)" },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "up-wallet-key", displayName: "UP Wallet key" },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: 120000,
    extensions: { prf: { eval: { first: prfSalt } } },
  } });
  const credId = new Uint8Array(cred.rawId);
  const ext = cred.getClientExtensionResults().prf;
  let prf = ext && ext.results && ext.results.first ? new Uint8Array(ext.results.first) : null;
  if (!prf) {
    if (ext && ext.enabled === false) throw new Error(L("Questa passkey non dà il segreto (PRF), che serve a cifrare la chiave: scegline un'altra (per esempio il Gestore password di Google, il telefono o una chiave di sicurezza) o usa una password.", "This passkey gives no secret (PRF), which encrypts the key: choose another one (for example Google Password Manager, a phone or a security key) or use a password."));
    // Some authenticators give the value only when the passkey is used: ask once more.
    prf = (await prfOf(credId, prfSalt)).prf;
    if (!prf) throw new Error(L("Questa passkey non dà il segreto (PRF): scegline un'altra o usa una password.", "This passkey gives no secret (PRF): choose another one or use a password."));
  }
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
  let aes;
  try { aes = await aesFromPrf(prf, hkdfSalt); } finally { wipe(prf); }
  return { method: "passkey", aes, extra: { credId: b64(credId), prfSalt: b64(prfSalt), hkdfSalt: b64(hkdfSalt) } };
}
async function createWithPassword(password) {
  if (password.length < MIN_PASSWORD) throw new Error(L(`La password deve avere almeno ${MIN_PASSWORD} caratteri.`, `The password needs at least ${MIN_PASSWORD} characters.`));
  const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
  return { method: "password", aes: await aesFromPassword(password, kdfSalt, PBKDF2_ROUNDS), extra: { kdfSalt: b64(kdfSalt), rounds: PBKDF2_ROUNDS } };
}
async function createKey(how, password) {
  if (await loadKey()) throw new Error(L("Una chiave esiste già in questa estensione.", "A key already exists in this extension."));
  const { method, aes, extra } = how === "password" ? await createWithPassword(password) : await createWithPasskey();
  let raw = new Uint8Array(32), wallet;
  for (;;) {
    crypto.getRandomValues(raw);
    const d = BigInt(ethers.hexlify(raw));
    if (d > 0n && d < ethers.N) break;
  }
  try {
    wallet = new ethers.SigningKey(raw);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, raw));
    const address = ethers.computeAddress(wallet.publicKey);
    await saveKey({ v: 1, address, method, iv: b64(iv), ct: b64(ct), created: new Date().toISOString(), ...extra });
    return address;
  } finally { wipe(raw); }
}

// ---- the window
const id = decodeURIComponent(location.hash.slice(1));
let answered = false;
function answer(msg) {
  if (answered) return;
  answered = true;
  api.runtime.sendMessage({ type: "signer-result", id, ...msg }).catch(() => null);
  setTimeout(() => window.close(), 50);
}
window.addEventListener("beforeunload", () => { if (!answered) api.runtime.sendMessage({ type: "signer-result", id, error: { code: 4001, message: "User rejected the request." } }).catch(() => null); });

function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function showError(e) { const box = $("err"); box.hidden = false; box.textContent = e && e.message ? e.message : String(e); }
function busy(on) { for (const b of document.querySelectorAll("button")) b.disabled = on; }
// The buttons answer only a moment after the request is shown, as browsers do in their own prompts: the
// window opens under the pointer (at the top right, over the side panel), and a second click meant for the
// page's own button must not press "Sign" here before the request can be read.
const ARM_MS = 1000;
function showActions() {
  busy(true);
  $("actions").hidden = false;
  setTimeout(() => { if (!answered) busy(false); }, ARM_MS);
}

async function main() {
  const req = id ? (await api.storage.session.get("req:" + id))["req:" + id] : null;
  if (req && (req.lang === "it" || req.lang === "en")) lang = req.lang;
  document.documentElement.lang = lang;
  if (!req) { $("title").textContent = L("Nessuna richiesta.", "No request."); return; }
  const k = await loadKey();
  if (req.kind === "create") return showCreate();
  if (req.kind === "remove") return showRemove(k);
  if (!k) { answer({ error: { code: 4100, message: L("Nessuna chiave in questa estensione.", "No key in this extension.") } }); return; }
  let p;
  try { p = plan(req, k.address, lang); } catch (e) { answer({ error: e && e.code ? e : { code: -32602, message: e.message } }); return; }
  $("title").textContent = p.title;
  if (p.site) $("site").textContent = L(`Richiesta da: ${p.site}`, `Requested by: ${p.site}`);
  const rows = $("rows");
  for (const [label, value] of p.rows) { const r = el("div", undefined, "row"); r.append(el("div", label, "label"), el("div", value, "value")); rows.appendChild(r); }
  $("account").textContent = L(`Chiave: ${k.address} · ${k.method === "passkey" ? "passkey" : "password"}`, `Key: ${k.address} · ${k.method === "passkey" ? "passkey" : "password"}`);
  if (k.method === "password") $("pwRow").hidden = false;
  $("sign").textContent = L("Firma", "Sign");
  $("cancel").textContent = L("Rifiuta", "Reject");
  $("cancel").onclick = () => answer({ error: { code: 4001, message: "User rejected the request." } });
  $("sign").onclick = async () => {
    busy(true); $("err").hidden = true;
    try {
      const sig = await signDigest(k, p.digest, $("pw").value);
      $("pw").value = "";
      answer({ result: p.finish(sig) });
    } catch (e) { busy(false); showError(e); }
  };
  showActions();
}

function showCreate() {
  $("title").textContent = L("Crea la chiave di questo computer", "Create this computer's key");
  const rows = $("rows");
  rows.append(el("p", L("La chiave resta in questa estensione, cifrata. Per ogni firma serve la passkey (impronta, volto, PIN o telefono) o, se il tuo sistema non la supporta, una password. Non ha copie: se perdi il computer o togli l'estensione, revocala da un altro controller della UP (sito, pagina Backup).", "The key stays in this extension, encrypted. Every signature needs the passkey (fingerprint, face, PIN or a phone) or, where your system does not support it, a password. It has no copy: if you lose the computer or remove the extension, revoke it from another controller of the UP (site, Backup page)."), "note"));
  $("sign").textContent = L("Crea con una passkey", "Create with a passkey");
  $("alt").textContent = L("Usa una password", "Use a password");
  $("alt").hidden = false;
  $("cancel").textContent = L("Annulla", "Cancel");
  $("cancel").onclick = () => answer({ error: { code: 4001, message: "User rejected the request." } });
  const run = async (how) => {
    busy(true); $("err").hidden = true;
    try {
      const pw = $("pw").value, pw2 = $("pw2").value;
      if (how === "password" && pw !== pw2) throw new Error(L("Le due password non coincidono.", "The two passwords differ."));
      const address = await createKey(how, pw);
      $("pw").value = ""; $("pw2").value = "";
      answer({ result: address });
    } catch (e) { busy(false); showError(e); }
  };
  $("sign").onclick = () => run("passkey");
  $("alt").onclick = () => {
    if ($("pwRow").hidden) { $("pwRow").hidden = false; $("pw2Row").hidden = false; $("pwHint").textContent = L(`Almeno ${MIN_PASSWORD} caratteri. Non si può recuperare.`, `At least ${MIN_PASSWORD} characters. It cannot be recovered.`); $("pw").focus(); return; }
    run("password");
  };
  showActions();
}

function showRemove(k) {
  $("title").textContent = L("Elimina la chiave di questo computer", "Delete this computer's key");
  $("rows").append(el("p", k ? L(`Chiave ${k.address}. Non si può recuperare: prima manda alla UP il suo saldo (pannello "Questo computer", su ogni rete dove ne ha) e revocala su ogni rete (sito, pagina Backup), altrimenti resta un controller della UP che nessuno può usare.`, `Key ${k.address}. It cannot be recovered: first send its balance to the UP (panel "This computer", on every network where it has some) and revoke it on every network (site, Backup page), or it stays a controller of the UP that nobody can use.`) : L("Nessuna chiave.", "No key."), "note"));
  $("sign").textContent = L("Elimina", "Delete");
  $("sign").className = "danger";
  $("cancel").textContent = L("Annulla", "Cancel");
  $("cancel").onclick = () => answer({ error: { code: 4001, message: "User rejected the request." } });
  $("sign").onclick = async () => { await api.storage.local.remove(STORE); answer({ result: true }); };
  showActions();
}

main().catch((e) => showError(e));
