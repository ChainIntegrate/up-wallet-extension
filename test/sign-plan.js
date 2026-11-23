// ext/sign-plan.js on its own (node, no browser): the cases of the review of 2026-11-04, EXT-02 (typed data shown
// and checked by the type that is signed) and EXT-03 (the arguments of the UP's token calls, every call of a
// batch, unknown functions said so). The Android app runs the same file (its test checks the copy is equal).
//   node test/sign-plan.js
"use strict";
const path = require("path");
const { ethers } = require("ethers");

const res = []; const ck = (n, c, x = "") => res.push(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : "\n      " + String(x).slice(0, 1500)}`);
// The ES module, bundled for node with its own ethers.
const out = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "ext", "sign-plan.js")], bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent" });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
const { plan } = mod.exports;

const key = ethers.Wallet.createRandom();
const UP = "0x4a2605796e0d91A9667d6E30365aEEC384C48c27";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", SPENDER = ethers.getAddress("0x" + "5e".repeat(20)), TO = "0x" + "77".repeat(20);
const refused = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const net = { name: "Base", currency: "ETH" };
const text = (p) => [...p.warnings, ...p.rows.map((r) => r.join(": "))].join("\n");

// ---- EXT-02: typed data
const auth = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
  TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  domain: { name: "USD Coin", chainId: 8453, verifyingContract: USDC },
  message: { from: UP, to: TO, value: "1000000", validAfter: 0, validBefore: 9999999999, nonce: "0x" + "ab".repeat(32), statement: "Sign in to dapp.example" } };
let e = refused(() => plan({ kind: "typed", account: key.address, data: JSON.stringify({ ...auth, primaryType: "Login" }), chainId: 8453, up: UP }, key.address, "it"));
ck("EXT-02: a declared primaryType that is not the one signed is refused (4100)", e && e.code === 4100 && /Login/.test(e.message) && /TransferWithAuthorization/.test(e.message), JSON.stringify(e));
let p = plan({ kind: "typed", account: key.address, data: JSON.stringify({ ...auth, primaryType: "TransferWithAuthorization" }), chainId: 8453, up: UP }, key.address, "it");
const typed = ethers.TypedDataEncoder.hash(auth.domain, { TransferWithAuthorization: auth.types.TransferWithAuthorization }, auth.message);
ck("EXT-02: the title and the shown type are the signed one; the digest is the EIP-712 hash", /TransferWithAuthorization/.test(p.title) && p.rows.some((r) => r[1] === "TransferWithAuthorization") && p.digest === typed, JSON.stringify({ t: p.title, rows: p.rows }));
ck("EXT-02: a field not in the type is not shown (it is not signed)", !text(p).includes("Sign in to dapp.example") && text(p).includes(TO), text(p));
ck("EXT-02: a signed transfer (EIP-3009) is warned, with amount, token and recipient", p.warnings.some((w) => /EIP-3009/.test(w) && /1000000/.test(w) && /USD Coin/.test(w) && w.includes(TO)), JSON.stringify(p.warnings));
p = plan({ kind: "typed", account: key.address, data: JSON.stringify(auth), chainId: 8453, up: UP }, key.address, "it");
ck("EXT-02: no declared primaryType: computed from the types, warned the same", /TransferWithAuthorization/.test(p.title) && p.warnings.some((w) => /EIP-3009/.test(w)), JSON.stringify(p.warnings));
const permit = { types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit", domain: { name: "Token", chainId: 8453, verifyingContract: USDC }, message: { owner: key.address, spender: SPENDER, value: "5", nonce: 0, deadline: 1 } };
p = plan({ kind: "typed", account: key.address, data: JSON.stringify(permit), chainId: 8453, up: UP }, key.address, "it");
ck("EXT-02: a permit is warned, and one for another address than the UP is flagged", p.warnings.some((w) => /PERMESSO DI SPESA/.test(w)) && p.warnings.some((w) => w.includes("non è per la UP") && w.includes(key.address)), JSON.stringify(p.warnings));
const order = { types: { Order: [{ name: "maker", type: "address" }, { name: "amount", type: "uint256" }] }, domain: { name: "DEX" }, message: { maker: UP, amount: 1 } };
p = plan({ kind: "typed", account: key.address, data: JSON.stringify(order), chainId: 8453, up: UP }, key.address, "en");
ck("EXT-02: an order is warned; no chain in the domain is warned", p.warnings.some((w) => /^ORDER/.test(w)) && p.warnings.some((w) => /No network in the domain/.test(w)), JSON.stringify(p.warnings));
const mail = { types: { Mail: [{ name: "contents", type: "string" }] }, primaryType: "Mail", domain: { name: "Mail", chainId: 8453 }, message: { contents: "hello" } };
p = plan({ kind: "typed", account: key.address, data: JSON.stringify(mail), chainId: 8453, up: UP }, key.address, "en");
ck("EXT-02: plain typed data: no warning", p.warnings.length === 0 && /"contents": "hello"/.test(text(p)), JSON.stringify(p));
e = refused(() => plan({ kind: "typed", account: key.address, data: JSON.stringify({ ...mail, domain: { chainId: 137 } }), chainId: 8453 }, key.address, "en"));
ck("typed data for another network: still refused (4100)", e && e.code === 4100, JSON.stringify(e));

// ---- EXT-03: the UP's calls
const up = new ethers.Interface(["function execute(uint256,address,uint256,bytes)", "function executeBatch(uint256[],address[],uint256[],bytes[])"]);
const km = new ethers.Interface(["function execute(bytes)"]);
const erc20 = new ethers.Interface(["function transfer(address,uint256)", "function approve(address,uint256)"]);
const lsp7 = new ethers.Interface(["function transfer(address,address,uint256,bool,bytes)", "function authorizeOperator(address,uint256,bytes)"]);
const lsp8 = new ethers.Interface(["function transfer(address,address,bytes32,bool,bytes)"]);
const nft = new ethers.Interface(["function setApprovalForAll(address,bool)", "function safeTransferFrom(address,address,uint256)"]);
const p2 = new ethers.Interface(["function approve(address,address,uint160,uint48)"]);
const txOf = (payload) => ({ kind: "tx", net, tx: { to: "0x" + "4b".repeat(20), value: "0", data: km.encodeFunctionData("execute", [payload]), nonce: 1, gasLimit: "100000", chainId: 8453, type: 2, maxFeePerGas: "2", maxPriorityFeePerGas: "1" } });
const MAX = (1n << 256n) - 1n;
p = plan(txOf(up.encodeFunctionData("execute", [0, USDC, 0, erc20.encodeFunctionData("transfer", [TO, 2500000n])])), key.address, "it");
ck("EXT-03: an ERC-20 transfer through the Key Manager: recipient and amount shown", text(p).includes(`Trasferisce 2500000 (unità minime del token) del token ${USDC} a ${TO}`) && p.warnings.length === 0, text(p));
p = plan(txOf(up.encodeFunctionData("execute", [0, USDC, 0, erc20.encodeFunctionData("approve", [SPENDER, MAX])])), key.address, "it");
ck("EXT-03: an unlimited approval: spender shown, \"ILLIMITATO\", warned", text(p).includes(`Autorizza ${SPENDER} a spendere ILLIMITATO`) && p.warnings.some((w) => /ILLIMITATA/.test(w) && w.includes(SPENDER)), text(p));
p = plan(txOf(up.encodeFunctionData("execute", [0, USDC, 0, erc20.encodeFunctionData("approve", [SPENDER, 10n])])), key.address, "en");
ck("EXT-03: a limited approval: amount shown, warned as an approval (not unlimited)", text(p).includes(`Allows ${SPENDER} to spend 10 (the token's smallest units)`) && p.warnings.some((w) => /^Spending approval/.test(w)) && !p.warnings.some((w) => /UNLIMITED/.test(w)), text(p));
const calls = [[USDC, lsp7.encodeFunctionData("transfer", [UP, TO, 7n, false, "0x"])], [USDC, lsp7.encodeFunctionData("authorizeOperator", [SPENDER, MAX, "0x"])],
  [TO, lsp8.encodeFunctionData("transfer", [UP, TO, "0x" + "01".padStart(64, "0"), false, "0x"])], [TO, nft.encodeFunctionData("setApprovalForAll", [SPENDER, true])],
  [TO, nft.encodeFunctionData("safeTransferFrom", [UP, TO, 42n])], ["0x000000000022D473030F116dDEE9F6B43aC78BA3", p2.encodeFunctionData("approve", [USDC, SPENDER, (1n << 160n) - 1n, 0])]];
for (let i = 0; i < 20; i++) calls.push([TO, "0xdeadbeef"]);
p = plan(txOf(up.encodeFunctionData("executeBatch", [calls.map(() => 0), calls.map((c) => c[0]), calls.map(() => 0), calls.map((c) => c[1])])), key.address, "en");
const t = text(p);
ck("EXT-03: a batch: LSP7, LSP8, ERC-721, Permit2 calls described with their arguments", t.includes(`LSP7: transfers 7 (the token's smallest units) of the token ${USDC} from ${UP} to ${TO}`) && t.includes(`LSP7: allows ${SPENDER} to spend UNLIMITED`) && /LSP8: transfers token 0x0+1/.test(t) && t.includes(`Allows ${SPENDER} to move ALL the NFTs of the collection ${TO}`) && t.includes("NFT (ERC-721): transfers token 42") && t.includes(`Permit2: allows ${SPENDER} to spend UNLIMITED of the token ${USDC}`), t);
ck("EXT-03: every call of a 26-call batch shown (none left as \"N more\")", p.rows.some((r) => r[0] === "26 · Function") && !/more/.test(t), t.slice(-500));
ck("EXT-03: an unknown function said so, as a warning, for each call", p.rows.filter((r) => /UNKNOWN to this window/.test(r[1])).length === 20 && p.warnings.filter((w) => /does not know what it does/.test(w)).length === 20, JSON.stringify(p.warnings.slice(-2)));
ck("EXT-03: the approvals in the batch warned (unlimited LSP7, whole collection, unlimited Permit2)", p.warnings.filter((w) => /UNLIMITED approval/.test(w)).length === 2 && p.warnings.some((w) => /WHOLE collection/.test(w)), JSON.stringify(p.warnings.slice(0, 4)));
p = plan(txOf(up.encodeFunctionData("execute", [4, TO, 0, "0x12345678"])), key.address, "en");
ck("EXT-03: a DELEGATECALL of the UP warned", p.rows.some((r) => r[1] === "DELEGATECALL") && p.warnings.some((w) => /DELEGATECALL operation/.test(w)), text(p));
p = plan({ kind: "tx", net, tx: { to: USDC, value: "0", data: erc20.encodeFunctionData("transfer", [TO, 1n]), nonce: 1, gasLimit: "60000", chainId: 8453, type: 2, maxFeePerGas: "2", maxPriorityFeePerGas: "1" } }, key.address, "en");
ck("EXT-03: a token call sent by the key itself is described too", text(p).includes(`Transfers 1 (the token's smallest units) of the token ${USDC} to ${TO}`), text(p));
p = plan({ kind: "tx", net, tx: { to: TO, value: "10000000000000000", data: "0x", nonce: 1, gasLimit: "21000", chainId: 8453, type: 2, maxFeePerGas: "2", maxPriorityFeePerGas: "1" } }, key.address, "en");
ck("a plain transfer: \"Sends 0.01 ETH\", no warning", text(p).includes(`Sends 0.01 ETH to ${TO}`) && p.warnings.length === 0, text(p));
// a gas-relay operation of the UP: the same description
const op = { sender: UP, nonce: "1", initCode: "0x", callData: up.encodeFunctionData("execute", [0, USDC, 0, erc20.encodeFunctionData("approve", [SPENDER, MAX])]), callGasLimit: "1", verificationGasLimit: "1", preVerificationGas: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", paymasterAndData: "0x" };
p = plan({ kind: "userop", op, entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", chainId: 8453, up: UP, net }, key.address, "en");
ck("EXT-03: a gas-relay operation: the same description and warnings", text(p).includes(`Allows ${SPENDER} to spend UNLIMITED`) && p.warnings.some((w) => /UNLIMITED approval/.test(w)), text(p));
// unchanged refusals
ck("a 32-byte message: still refused", refused(() => plan({ kind: "message", message: ethers.hexlify(ethers.randomBytes(32)), account: key.address }, key.address)).code === 4100);

console.log(res.join("\n"));
const fails = res.filter((x) => x.startsWith("FAIL")).length;
console.log(fails ? `${fails} FAILED` : `${res.length}/${res.length}`);
process.exit(fails ? 1 : 0);
