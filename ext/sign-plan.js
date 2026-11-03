// UP Wallet: what a signing request signs, computed from the request itself and shown in plain words. Shared
// by the browser extension's signing window (ext/signer.js) and the Android app's (keep the two copies equal:
// the app's test compares them). No platform code here: no chrome.*, no DOM, no key; only ethers.
//
//   plan(req, address, lang) → { title, site, rows: [[label, value]], digest, finish(sig) → answer }
//   or throws { code, message } (EIP-1193 errors), for a request it refuses.
// req.kind: "message" (personal_sign), "typed" (eth_signTypedData_v4), "tx" (a transaction the key sends, with
// the Key Manager's execute(bytes) decoded), "userop" (an ERC-4337 operation of the UP, EntryPoint v0.6).
// Refused: a 32-byte message (it may be an operation hash), another account, typed data for another network,
// an operation of another UP or for another EntryPoint. Nothing here can produce an EIP-7702 authorization.
import { ethers } from "ethers";

const ENTRY_POINT = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const rpcError = (code, message) => ({ code, message });
let lang = "en";
const L = (it, eng) => (lang === "it" ? it : eng);

function messageBytes(m) { return typeof m === "string" && ethers.isHexString(m) ? ethers.getBytes(m) : ethers.toUtf8Bytes(String(m)); }
const oneLine = (t, n) => { const c = String(t).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").trim(); return c.length > n ? c.slice(0, n - 1) + "…" : c; };
function textOf(bytes) {
  try { const t = ethers.toUtf8String(bytes); if (!/[\u0000-\u0008\u000e-\u001f]/.test(t)) return t; } catch (e) { /* not UTF-8 */ }
  return null;
}
const UP_IFACE = new ethers.Interface(["function execute(uint256,address,uint256,bytes)", "function executeBatch(uint256[],address[],uint256[],bytes[])"]);
function userOpHash(op, chainId) {
  const enc = (t, v) => ethers.AbiCoder.defaultAbiCoder().encode(t, v);
  const packed = enc(
    ["address", "uint256", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
    [op.sender, op.nonce, ethers.keccak256(op.initCode), ethers.keccak256(op.callData), op.callGasLimit,
      op.verificationGasLimit, op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, ethers.keccak256(op.paymasterAndData)]);
  return ethers.keccak256(enc(["bytes32", "address", "uint256"], [ethers.keccak256(packed), ENTRY_POINT, chainId]));
}
const chainText = (c) => (/^(0x[0-9a-f]+|\d+)$/i.test(String(c)) ? BigInt(c).toString() : oneLine(c, 20));
const amount = (v, cur) => `${ethers.formatEther(v)} ${cur || ""}`.trim();
const selector = (data) => (ethers.dataLength(data) ? ethers.dataSlice(data, 0, Math.min(4, ethers.dataLength(data))) : "");
// What the UP does, from its execute / executeBatch call data: the operation type when it is not a plain call,
// and each call's recipient, value and function.
const OPS = ["CALL", "CREATE", "CREATE2", "STATICCALL", "DELEGATECALL"];
const opName = (o) => OPS[Number(o)] || String(o);
function upCalls(data, cur) {
  let d = null;
  try { d = UP_IFACE.parseTransaction({ data }); } catch (e) { /* not execute / executeBatch */ }
  if (!d) return [[L("Funzione della UP", "UP function"), selector(data) || "0x"]];
  if (d.name === "execute") {
    const [op, to, value, inner] = d.args;
    return [...(Number(op) ? [[L("Tipo", "Type"), opName(op)]] : []), [L("Verso", "To"), to], [L("Valore", "Value"), amount(value, cur)], [L("Funzione", "Function"), selector(inner) || "—"]];
  }
  const [ops, tos, values, datas] = d.args;
  const MAX = 20;
  const rows = [[L("Chiamate", "Calls"), L(`${tos.length} in un'operazione`, `${tos.length} in one operation`)]];
  tos.slice(0, MAX).forEach((to, i) => rows.push([`${i + 1}`, [Number(ops[i]) ? opName(ops[i]) : "", to, amount(values[i], cur), selector(datas[i]) || "—"].filter(Boolean).join(" · ")]));
  if (tos.length > MAX) rows.push(["…", L(`altre ${tos.length - MAX}`, `${tos.length - MAX} more`)]);
  return rows;
}
// A transaction to the UP's Key Manager: execute(bytes) runs the payload on the UP.
const KM_IFACE = new ethers.Interface(["function execute(bytes)"]);
const KM_EXECUTE = KM_IFACE.getFunction("execute").selector;

// Returns { title, rows: [[label, value]], digest, finish(sig) → answer } or throws { code, message }.
// address: the key's own address (checksummed); lang: "it" or "en".
export function plan(req, address, language = "en") {
  lang = language === "it" ? "it" : "en";
  const k = { address: ethers.getAddress(address) };
  const who = (a) => typeof a === "string" && ethers.isAddress(a) && ethers.getAddress(a) === k.address;
  if (req.kind === "message") {
    if (!who(req.account)) throw rpcError(4100, "not this extension's account");
    const bytes = messageBytes(req.message);
    // A 32-byte message may be an operation hash: it would authorize an operation of the UP wherever this key
    // has the 4337 permission (AUDIT 2026-10-02 H-2, 2026-10-26 PK-2). Operations come as "userop" instead.
    if (bytes.length === 32) throw rpcError(4100, L("La chiave non firma un messaggio opaco di 32 byte: potrebbe autorizzare un'operazione della UP su un'altra rete.", "The key does not sign an opaque 32-byte message: it could authorize an operation of the UP on another network."));
    const text = textOf(bytes);
    return { title: L("Firma di un messaggio", "Sign a message"), site: req.site,
      rows: [[L("Messaggio", "Message"), text !== null ? text : L(`${bytes.length} byte, non testo: ${ethers.hexlify(bytes)}`, `${bytes.length} bytes, not text: ${ethers.hexlify(bytes)}`)]],
      digest: ethers.hashMessage(bytes), finish: (sig) => sig.serialized };
  }
  if (req.kind === "typed") {
    if (!who(req.account)) throw rpcError(4100, "not this extension's account");
    const j = typeof req.data === "string" ? JSON.parse(req.data) : req.data;
    const types = { ...(j.types || {}) }; delete types.EIP712Domain;
    const dom = j.domain || {};
    if (req.chainId != null && dom.chainId != null && Number(dom.chainId) !== Number(req.chainId)) throw rpcError(4100, L(`Dati per la rete ${dom.chainId}, la pagina è su ${req.chainId}.`, `Data for network ${dom.chainId}, the page is on ${req.chainId}.`));
    return { title: L(`Firma di dati strutturati (${oneLine(j.primaryType || "EIP-712", 40)})`, `Sign typed data (${oneLine(j.primaryType || "EIP-712", 40)})`), site: req.site,
      rows: [[L("Dominio", "Domain"), [oneLine(dom.name || "?", 60), dom.chainId != null ? L(`rete ${chainText(dom.chainId)}`, `chain ${chainText(dom.chainId)}`) : L("nessuna rete", "no chain"), dom.verifyingContract ? oneLine(dom.verifyingContract, 42) : ""].filter(Boolean).join(" · ")],
        [L("Contenuto", "Content"), JSON.stringify(j.message || {}, null, 2)]],
      digest: ethers.TypedDataEncoder.hash(dom, types, j.message || {}), finish: (sig) => sig.serialized };
  }
  if (req.kind === "tx") {
    const t = ethers.Transaction.from({ ...req.tx, chainId: BigInt(req.tx.chainId) });
    let what = [[L("Verso", "To"), t.to || L("(nuovo contratto)", "(new contract)")], [L("Valore", "Value"), amount(t.value, req.net.currency)],
      [L("Funzione", "Function"), selector(t.data) || L("nessun dato: un semplice invio", "no data: a plain transfer")]];
    if (t.to && selector(t.data) === KM_EXECUTE) {
      try {
        const [payload] = KM_IFACE.decodeFunctionData("execute", t.data);
        what = [["Key Manager", t.to], [L("Valore", "Value"), amount(t.value, req.net.currency)],
          [L("Funzione", "Function"), L("execute(bytes): la UP esegue", "execute(bytes): the UP runs")], ...upCalls(payload, req.net.currency)];
      } catch (e) { /* shown as a plain call */ }
    }
    return { title: L(`Transazione su ${req.net.name}`, `Transaction on ${req.net.name}`), site: req.site,
      rows: [...what,
        [L("Gas massimo", "Maximum gas"), amount(t.gasLimit * (t.maxFeePerGas ?? t.gasPrice ?? 0n), req.net.currency)], [L("Rete", "Network"), `${req.net.name} (${t.chainId})`]],
      digest: t.unsignedHash, finish: (sig) => { t.signature = sig; if (t.from !== k.address) throw new Error("signature check failed"); return t.serialized; } };
  }
  if (req.kind === "userop") {
    const raw = req.op || {};
    if (!req.entryPoint || ethers.getAddress(req.entryPoint) !== ENTRY_POINT) throw rpcError(-32602, "not EntryPoint v0.6");
    const op = { sender: ethers.getAddress(raw.sender), nonce: BigInt(raw.nonce), initCode: raw.initCode, callData: raw.callData, callGasLimit: BigInt(raw.callGasLimit),
      verificationGasLimit: BigInt(raw.verificationGasLimit), preVerificationGas: BigInt(raw.preVerificationGas), maxFeePerGas: BigInt(raw.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(raw.maxPriorityFeePerGas), paymasterAndData: raw.paymasterAndData };
    for (const x of ["initCode", "callData", "paymasterAndData"]) if (!ethers.isHexString(op[x])) throw rpcError(-32602, "malformed bytes");
    if (!req.up || op.sender !== ethers.getAddress(req.up)) throw rpcError(4100, L("L'operazione non è della UP scelta nella pagina.", "The operation is not of the UP chosen in the page."));
    const what = upCalls(op.callData, req.net.currency);
    const h = userOpHash(op, Number(req.chainId));
    // Extension4337 checks a personal_sign of the operation hash.
    return { title: L(`Operazione della UP su ${req.net.name}`, `Operation of the UP on ${req.net.name}`), site: req.site,
      rows: [["UP", op.sender], ...what, ["Gas", L("pagato dal sito (relayer)", "paid by the site (relayer)")], [L("Rete", "Network"), `${req.net.name} (${req.chainId})`]],
      digest: ethers.hashMessage(ethers.getBytes(h)), finish: (sig) => sig.serialized };
  }
  throw rpcError(4200, "unknown request");
}

