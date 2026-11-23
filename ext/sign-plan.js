// UP Wallet: what a signing request signs, computed from the request itself and shown in plain words. Shared
// by the browser extension's signing window (ext/signer.js) and the Android app's (keep the two copies equal:
// the app's test compares them). No platform code here: no chrome.*, no DOM, no key; only ethers.
//
//   plan(req, address, lang) → { title, site, rows: [[label, value]], warnings: [text], digest, finish(sig) → answer }
//   or throws { code, message } (EIP-1193 errors), for a request it refuses.
// req.kind: "message" (personal_sign), "typed" (eth_signTypedData_v4), "tx" (a transaction the key sends, with
// the Key Manager's execute(bytes) decoded), "userop" (an ERC-4337 operation of the UP, EntryPoint v0.6).
// Refused: a 32-byte message (it may be an operation hash), another account, typed data for another network or
// whose declared primaryType is not the one signed, an operation of another UP or for another EntryPoint.
// Nothing here can produce an EIP-7702 authorization.
// Shown (review of 2026-11-04, EXT-02 and EXT-03): typed data by the type that is signed (the one computed from
// `types`), only its typed fields, with warnings for permits, signed transfers and orders; the arguments of the
// token calls the UP makes (transfers and approvals of ERC-20, LSP7, ERC-721, LSP8, ERC-1155, Permit2), with
// "unlimited" approvals flagged; every call of a batch; a function this file does not know, said so.
import { ethers } from "ethers";

const ENTRY_POINT = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
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

// ---- token calls (EXT-03): what a call to a token contract does, with its arguments. Amounts are in the
// token's smallest unit (this file reads no chain, so it does not know the decimals).
const TOKEN_IFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 amount)",
  "function transfer(address from, address to, uint256 amount, bool force, bytes data)",
  "function authorizeOperator(address operator, uint256 amount, bytes data)",
  "function increaseAllowance(address operator, uint256 addedAmount, bytes data)",
  "function transfer(address from, address to, bytes32 tokenId, bool force, bytes data)",
  "function authorizeOperator(address operator, bytes32 tokenId, bytes data)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const UNLIMITED = (v) => v >= (1n << 128n);   // max uint256, uint160 (Permit2) and the like: no real amount is that large
const units = (v) => (UNLIMITED(v) ? L("ILLIMITATO", "UNLIMITED") : L(`${v} (unità minime del token)`, `${v} (the token's smallest units)`));
const approveWarn = (who, v) => (UNLIMITED(v)
  ? L(`Autorizzazione ILLIMITATA: ${who} potrà spendere tutto questo token della UP, ora e in futuro, finché non la revochi.`, `UNLIMITED approval: ${who} will be able to spend all of this token of the UP, now and later, until you revoke it.`)
  : L(`Autorizzazione a spendere: ${who} potrà muovere questo token della UP fino all'importo indicato.`, `Spending approval: ${who} will be able to move this token of the UP up to the amount shown.`));
// → { text, warn } for a known token call, or null.
function tokenCall(to, data) {
  let d = null;
  try { d = TOKEN_IFACE.parseTransaction({ data }); } catch (e) { return null; }
  if (!d) return null;
  const a = d.args, tok = L(`del token ${to}`, `of the token ${to}`);
  switch (d.signature) {
    case "transfer(address,uint256)":
      return { text: L(`Trasferisce ${units(a[1])} ${tok} a ${a[0]}`, `Transfers ${units(a[1])} ${tok} to ${a[0]}`) };
    case "transferFrom(address,address,uint256)":
      return { text: L(`Trasferisce da ${a[0]} a ${a[1]}: ${units(a[2])} (o il token numero ${a[2]}) ${tok}`, `Transfers from ${a[0]} to ${a[1]}: ${units(a[2])} (or token number ${a[2]}) ${tok}`) };
    case "approve(address,uint256)":
    case "increaseAllowance(address,uint256)":
      return { text: L(`Autorizza ${a[0]} a spendere ${units(a[1])} ${tok}`, `Allows ${a[0]} to spend ${units(a[1])} ${tok}`), warn: approveWarn(a[0], a[1]) };
    case "transfer(address,address,uint256,bool,bytes)":
      return { text: L(`LSP7: trasferisce ${units(a[2])} ${tok} da ${a[0]} a ${a[1]}`, `LSP7: transfers ${units(a[2])} ${tok} from ${a[0]} to ${a[1]}`) };
    case "authorizeOperator(address,uint256,bytes)":
    case "increaseAllowance(address,uint256,bytes)":
      return { text: L(`LSP7: autorizza ${a[0]} a spendere ${units(a[1])} ${tok}`, `LSP7: allows ${a[0]} to spend ${units(a[1])} ${tok}`), warn: approveWarn(a[0], a[1]) };
    case "transfer(address,address,bytes32,bool,bytes)":
      return { text: L(`LSP8: trasferisce il token ${a[2]} ${tok} da ${a[0]} a ${a[1]}`, `LSP8: transfers token ${a[2]} ${tok} from ${a[0]} to ${a[1]}`) };
    case "authorizeOperator(address,bytes32,bytes)":
      return { text: L(`LSP8: autorizza ${a[0]} a muovere il token ${a[1]} ${tok}`, `LSP8: allows ${a[0]} to move token ${a[1]} ${tok}`),
        warn: L(`Autorizzazione: ${a[0]} potrà trasferire questo NFT della UP.`, `Approval: ${a[0]} will be able to transfer this NFT of the UP.`) };
    case "safeTransferFrom(address,address,uint256)":
    case "safeTransferFrom(address,address,uint256,bytes)":
      return { text: L(`NFT (ERC-721): trasferisce il token ${a[2]} ${tok} da ${a[0]} a ${a[1]}`, `NFT (ERC-721): transfers token ${a[2]} ${tok} from ${a[0]} to ${a[1]}`) };
    case "setApprovalForAll(address,bool)":
      return a[1]
        ? { text: L(`Autorizza ${a[0]} a muovere TUTTI gli NFT della collezione ${to}`, `Allows ${a[0]} to move ALL the NFTs of the collection ${to}`),
          warn: L(`Autorizzazione su TUTTA la collezione: ${a[0]} potrà trasferire ogni NFT di questa collezione della UP, ora e in futuro.`, `Approval for the WHOLE collection: ${a[0]} will be able to transfer every NFT of this collection of the UP, now and later.`) }
        : { text: L(`Revoca l'autorizzazione di ${a[0]} sulla collezione ${to}`, `Revokes ${a[0]}'s approval on the collection ${to}`) };
    case "safeTransferFrom(address,address,uint256,uint256,bytes)":
      return { text: L(`ERC-1155: trasferisce ${a[3]} del token ${a[2]} (contratto ${to}) da ${a[0]} a ${a[1]}`, `ERC-1155: transfers ${a[3]} of token ${a[2]} (contract ${to}) from ${a[0]} to ${a[1]}`) };
    case "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)": {
      const list = a[2].map((id, i) => `${a[3][i]} × ${id}`).join(", ");
      return { text: L(`ERC-1155: trasferisce ${a[2].length} tipi di token (contratto ${to}) da ${a[0]} a ${a[1]}: ${list}`, `ERC-1155: transfers ${a[2].length} kinds of token (contract ${to}) from ${a[0]} to ${a[1]}: ${list}`) };
    }
    case "approve(address,address,uint160,uint48)":
      if (to.toLowerCase() !== PERMIT2) return null;
      return { text: L(`Permit2: autorizza ${a[1]} a spendere ${units(a[2])} del token ${a[0]}, scadenza ${a[3]}`, `Permit2: allows ${a[1]} to spend ${units(a[2])} of the token ${a[0]}, expiring ${a[3]}`), warn: approveWarn(a[1], a[2]) };
  }
  return null;
}
// One call (made by the UP, or by the key itself): rows saying what it does, warnings added to the list.
function describeCall(to, value, data, cur, warnings, prefix = "") {
  const sel = selector(data);
  if (!sel) return [[prefix + L("Cosa fa", "What it does"), value > 0n ? L(`Invia ${amount(value, cur)} a ${to}`, `Sends ${amount(value, cur)} to ${to}`) : L(`Chiama ${to} senza dati`, `Calls ${to} with no data`)]];
  const t = tokenCall(to, data);
  if (t) { if (t.warn) warnings.push(t.warn); return [[prefix + L("Cosa fa", "What it does"), t.text]]; }
  warnings.push(L(`Funzione ${sel} su ${to}: questa finestra non sa cosa fa. Firma solo se ti fidi del sito e hai controllato la richiesta nel wallet.`, `Function ${sel} on ${to}: this window does not know what it does. Sign only if you trust the site and checked the request in the wallet.`));
  return [[prefix + L("Funzione", "Function"), L(`${sel}: SCONOSCIUTA a questa finestra`, `${sel}: UNKNOWN to this window`)]];
}
// What the UP does, from its execute / executeBatch call data: the operation type when it is not a plain call,
// and each call's recipient, value and what it does. Every call of a batch is shown (EXT-03).
const OPS = ["CALL", "CREATE", "CREATE2", "STATICCALL", "DELEGATECALL"];
const opName = (o) => OPS[Number(o)] || String(o);
function upCalls(data, cur, warnings) {
  let d = null;
  try { d = UP_IFACE.parseTransaction({ data }); } catch (e) { /* not execute / executeBatch */ }
  if (!d) {
    warnings.push(L(`Funzione della UP ${selector(data) || "0x"}: non è execute né executeBatch.`, `UP function ${selector(data) || "0x"}: neither execute nor executeBatch.`));
    return [[L("Funzione della UP", "UP function"), selector(data) || "0x"]];
  }
  const one = (op, to, value, inner, prefix) => {
    const rows = [];
    if (Number(op)) {
      rows.push([prefix + L("Tipo", "Type"), opName(op)]);
      warnings.push(L(`Operazione ${opName(op)} della UP: non è una semplice chiamata.`, `${opName(op)} operation of the UP: not a plain call.`));
    }
    rows.push([prefix + L("Verso", "To"), to], [prefix + L("Valore", "Value"), amount(value, cur)], ...describeCall(to, value, inner, cur, warnings, prefix));
    return rows;
  };
  if (d.name === "execute") { const [op, to, value, inner] = d.args; return one(op, to, value, inner, ""); }
  const [ops, tos, values, datas] = d.args;
  const rows = [[L("Chiamate", "Calls"), L(`${tos.length} in un'operazione`, `${tos.length} in one operation`)]];
  tos.forEach((to, i) => rows.push(...one(ops[i], to, values[i], datas[i], `${i + 1} · `)));
  return rows;
}
// A transaction to the UP's Key Manager: execute(bytes) runs the payload on the UP.
const KM_IFACE = new ethers.Interface(["function execute(bytes)"]);
const KM_EXECUTE = KM_IFACE.getFunction("execute").selector;

// Typed data (EXT-02): what is signed is the type computed from `types` (the hash does not use the declared
// primaryType), with only its typed fields; the warnings are about that type and the domain.
function typedPlan(req) {
  const j = typeof req.data === "string" ? JSON.parse(req.data) : req.data;
  if (!j || typeof j !== "object" || !j.types || !j.message) throw rpcError(-32602, "missing types or message");
  const types = { ...j.types }; delete types.EIP712Domain;
  const dom = j.domain || {};
  if (req.chainId != null && dom.chainId != null && Number(dom.chainId) !== Number(req.chainId)) throw rpcError(4100, L(`Dati per la rete ${dom.chainId}, la pagina è su ${req.chainId}.`, `Data for network ${dom.chainId}, the page is on ${req.chainId}.`));
  let enc;
  try { enc = ethers.TypedDataEncoder.from(types); } catch (e) { throw rpcError(-32602, L(`Tipi non validi: ${oneLine(e.message, 120)}`, `Invalid types: ${oneLine(e.message, 120)}`)); }
  const pt = enc.primaryType;
  if (j.primaryType != null && j.primaryType !== pt) throw rpcError(4100, L(`Il sito dichiara il tipo "${oneLine(j.primaryType, 40)}" ma si firmerebbe "${oneLine(pt, 40)}": richiesta rifiutata.`, `The site declares the type "${oneLine(j.primaryType, 40)}" but "${oneLine(pt, 40)}" would be signed: request refused.`));
  const message = enc.visit(j.message, (type, value) => (typeof value === "bigint" ? value.toString() : value));
  const warnings = [];
  const vc = String(dom.verifyingContract || "").toLowerCase();
  if (/permit/i.test(pt) || vc === PERMIT2 || /permit2/i.test(String(dom.name || ""))) warnings.push(L("PERMESSO DI SPESA: questa firma autorizza qualcuno a spendere token della UP senza un'altra conferma. Firma solo se sai chi è lo spender e per quale importo.", "SPENDING PERMIT: this signature lets someone spend tokens of the UP with no further confirmation. Sign only if you know the spender and the amount."));
  if (/^(Transfer|Receive)WithAuthorization$/.test(pt)) warnings.push(L(`TRASFERIMENTO FIRMATO (EIP-3009): chiunque abbia questa firma può spostare ${oneLine(message.value ?? "?", 40)} unità del token "${oneLine(dom.name || dom.verifyingContract || "?", 60)}" verso ${oneLine(message.to ?? "?", 42)}.`, `SIGNED TRANSFER (EIP-3009): whoever holds this signature can move ${oneLine(message.value ?? "?", 40)} units of the token "${oneLine(dom.name || dom.verifyingContract || "?", 60)}" to ${oneLine(message.to ?? "?", 42)}.`));
  if (/order/i.test(pt)) warnings.push(L("ORDINE: questa firma può scambiare o vendere asset della UP quando qualcuno la esegue.", "ORDER: this signature can swap or sell assets of the UP when someone executes it."));
  if (dom.chainId == null) warnings.push(L("Nessuna rete nel dominio: la firma può valere su ogni rete dove esiste la UP.", "No network in the domain: the signature may be valid on every network where the UP exists."));
  // A permit or a signed transfer is meant for the UP: one for another address (the key's own, another UP) is flagged.
  const forWho = /permit/i.test(pt) ? message.owner : /WithAuthorization$/.test(pt) ? message.from : undefined;
  if (req.up && ethers.isAddress(req.up) && typeof forWho === "string" && ethers.isAddress(forWho) && ethers.getAddress(forWho) !== ethers.getAddress(req.up)) warnings.push(L(`Questa firma non è per la UP ma per ${ethers.getAddress(forWho)}.`, `This signature is not for the UP but for ${ethers.getAddress(forWho)}.`));
  return { title: L(`Firma di dati strutturati (${oneLine(pt, 40)})`, `Sign typed data (${oneLine(pt, 40)})`), site: req.site, warnings,
    rows: [[L("Dominio", "Domain"), [oneLine(dom.name || "?", 60), dom.chainId != null ? L(`rete ${chainText(dom.chainId)}`, `chain ${chainText(dom.chainId)}`) : L("nessuna rete", "no chain"), dom.verifyingContract ? oneLine(dom.verifyingContract, 42) : ""].filter(Boolean).join(" · ")],
      [L("Tipo firmato", "Type signed"), pt],
      [L("Contenuto", "Content"), JSON.stringify(message, null, 2)]],
    digest: ethers.TypedDataEncoder.hash(dom, types, j.message), finish: (sig) => sig.serialized };
}

// Returns { title, rows: [[label, value]], warnings: [text], digest, finish(sig) → answer } or throws { code, message }.
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
    return { title: L("Firma di un messaggio", "Sign a message"), site: req.site, warnings: [],
      rows: [[L("Messaggio", "Message"), text !== null ? text : L(`${bytes.length} byte, non testo: ${ethers.hexlify(bytes)}`, `${bytes.length} bytes, not text: ${ethers.hexlify(bytes)}`)]],
      digest: ethers.hashMessage(bytes), finish: (sig) => sig.serialized };
  }
  if (req.kind === "typed") {
    if (!who(req.account)) throw rpcError(4100, "not this extension's account");
    return typedPlan(req);
  }
  if (req.kind === "tx") {
    const t = ethers.Transaction.from({ ...req.tx, chainId: BigInt(req.tx.chainId) });
    const warnings = [];
    let what = null;
    if (t.to && selector(t.data) === KM_EXECUTE) {
      try {
        const [payload] = KM_IFACE.decodeFunctionData("execute", t.data);
        what = [["Key Manager", t.to], [L("Valore", "Value"), amount(t.value, req.net.currency)],
          [L("Funzione", "Function"), L("execute(bytes): la UP esegue", "execute(bytes): the UP runs")], ...upCalls(payload, req.net.currency, warnings)];
      } catch (e) { what = null; }
    }
    if (!what) {
      if (t.to) what = [[L("Verso", "To"), t.to], [L("Valore", "Value"), amount(t.value, req.net.currency)], ...describeCall(t.to, t.value, t.data, req.net.currency, warnings)];
      else { what = [[L("Verso", "To"), L("(nuovo contratto)", "(new contract)")], [L("Valore", "Value"), amount(t.value, req.net.currency)]]; warnings.push(L("Crea un nuovo contratto.", "Deploys a new contract.")); }
    }
    return { title: L(`Transazione su ${req.net.name}`, `Transaction on ${req.net.name}`), site: req.site, warnings,
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
    const warnings = [];
    const what = upCalls(op.callData, req.net.currency, warnings);
    const h = userOpHash(op, Number(req.chainId));
    // Extension4337 checks a personal_sign of the operation hash.
    return { title: L(`Operazione della UP su ${req.net.name}`, `Operation of the UP on ${req.net.name}`), site: req.site, warnings,
      rows: [["UP", op.sender], ...what, ["Gas", L("pagato dal sito (relayer)", "paid by the site (relayer)")], [L("Rete", "Network"), `${req.net.name} (${req.chainId})`]],
      digest: ethers.hashMessage(ethers.getBytes(h)), finish: (sig) => sig.serialized };
  }
  throw rpcError(4200, "unknown request");
}
