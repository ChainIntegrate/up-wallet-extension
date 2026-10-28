#!/usr/bin/env node
// Builds dist/, the extension, from the Cross_Chain repository at the commit pinned in UPSTREAM.json. The
// extension runs the same UP Wallet page as the site; only these differences are added:
//   - ethers is bundled (from the npm package, checked against the page's own SRI hash) instead of the CDN;
//   - the page's inline scripts become files: an extension page runs no inline script (Manifest V3's
//     Content-Security-Policy, script-src 'self'), so its <meta> policy is dropped for the manifest's;
//   - config.js is generated from ext-config.json;
//   - ext/ext-shim.js (relay calls and links to the site) and ext/device-key.js (this computer's key as the
//     page's signing wallet, bundled with esbuild) are loaded by the page;
//   - ext/signer.html with ext/signer.js (bundled, with its own ethers): the signing window, the only place
//     where the key is opened;
//   - the WalletConnect metadata names the site instead of the extension's origin;
//   - manifest.json, with the public key that fixes the extension's id: its passkey belongs to that id.
//
//   node scripts/build.js                         clones Cross_Chain at the pinned commit into upstream/
//   CROSS_CHAIN_DIR=/path node scripts/build.js   uses a local checkout instead (it must be at that commit)
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist");
const upstream = JSON.parse(fs.readFileSync(path.join(ROOT, "UPSTREAM.json"), "utf8"));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "ext-config.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const PAGE = "up-wallet.html";
const FILES = [PAGE, "theme.js", "chains.js", "asset-list.js", "usd-price.js", "token-image.js", "backup-check.js",
  "gas-relay-client.js", "call-decode.js", "abi-decode.js",
  "vendor/walletkit-1.6.0.min.js", "vendor/qrcode-generator-1.4.4.js", "banner.png", "logo.png", "favicon.ico"];
const DIRS = ["chain-logos"];
const ETHERS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js";
const ETHERS_LOCAL = "vendor/ethers-6.13.4.umd.min.js";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function source() {
  if (process.env.CROSS_CHAIN_DIR) {
    const dir = path.resolve(process.env.CROSS_CHAIN_DIR);
    const head = git(["rev-parse", "HEAD"], dir);
    if (head !== upstream.commit) throw new Error(`${dir} is at ${head}, UPSTREAM.json pins ${upstream.commit}`);
    return dir;
  }
  const dir = path.join(ROOT, "upstream");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q"], dir);
    git(["remote", "add", "origin", upstream.repo], dir);
  }
  git(["fetch", "-q", "--depth", "1", "origin", upstream.commit], dir);
  git(["checkout", "-q", "--detach", upstream.commit], dir);
  return dir;
}

function replaceOnce(html, from, to, what) {
  if (!html.includes(from)) throw new Error(`${what} not found in the page`);
  return html.replace(from, to);
}

async function bundle(entry, out) {
  await require("esbuild").build({
    entryPoints: [entry], outfile: out, bundle: true, format: "iife", platform: "browser", target: "es2020",
    minify: true, legalComments: "none", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  });
}

async function main() {
  const src = source();
  const site = new URL(cfg.site).href;
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const f of FILES) {
    const to = path.join(OUT, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
  }
  for (const d of DIRS) {
    fs.mkdirSync(path.join(OUT, d), { recursive: true });
    for (const f of fs.readdirSync(path.join(src, d))) if (/\.png$/.test(f)) fs.copyFileSync(path.join(src, d, f), path.join(OUT, d, f));
  }

  let html = fs.readFileSync(path.join(OUT, PAGE), "utf8");
  const missing = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
    .filter((s) => !/^https?:/.test(s) && s !== "config.js" && !FILES.includes(s));
  if (missing.length) throw new Error(`the page loads ${missing.join(", ")}: add to FILES in scripts/build.js`);

  // ethers: the same file the CDN serves, verified against the integrity attribute of the page itself.
  const tag = html.match(/<script src="([^"]+)" integrity="(sha384-[^"]+)"[^>]*><\/script>/);
  if (!tag || tag[1] !== ETHERS_CDN) throw new Error("ethers script tag not found in the page, or a different version");
  const ethersFile = fs.readFileSync(path.join(ROOT, "node_modules", "ethers", "dist", "ethers.umd.min.js"));
  const sri = "sha384-" + crypto.createHash("sha384").update(ethersFile).digest("base64");
  if (sri !== tag[2]) throw new Error(`ethers from npm (${sri}) does not match the page's SRI (${tag[2]})`);
  fs.mkdirSync(path.join(OUT, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(OUT, ETHERS_LOCAL), ethersFile);
  html = html.replace(tag[0], `<script src="${ETHERS_LOCAL}" integrity="${sri}"></script>`);

  // The extension's additions, as in the Android app: the shim right after theme.js, before any other script
  // of the page; the computer key after config.js, once chains.js and ethers are loaded.
  html = replaceOnce(html, '<script src="theme.js"></script>', '<script src="theme.js"></script>\n<script src="ext/ext-shim.js"></script>', "theme.js script tag");
  html = replaceOnce(html, '<script src="config.js"></script>', '<script src="config.js"></script>\n<script src="ext/device-key.js"></script>', "config.js script tag");
  html = replaceOnce(html, "const PAGE_COMMIT = null;", `const PAGE_COMMIT = ${JSON.stringify(upstream.commit.slice(0, 7))};`, "PAGE_COMMIT");
  // WalletConnect metadata: dApps are shown the site (its address and icon), not the extension's origin.
  html = replaceOnce(html, "      url: location.origin,\n      icons: [location.origin + \"/favicon.ico\"],",
    `      url: ${JSON.stringify(site.replace(/\/$/, ""))},\n      icons: [${JSON.stringify(site + "favicon.ico")}],`, "WalletConnect metadata (url, icons)");

  // Manifest V3 runs no inline script in an extension page: each one becomes a file, in the same place.
  // The page's own <meta> policy (inline scripts by hash) goes: the manifest's policy (script-src 'self')
  // is stricter, and the browser would apply both.
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "");
  let n = 0;
  html = html.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g, (all, attrs, body) => {
    if (/\ssrc=/.test(attrs || "")) return all;
    if (!body.trim()) return all;
    const file = `ext/page-${++n}.js`;
    fs.mkdirSync(path.join(OUT, "ext"), { recursive: true });
    fs.writeFileSync(path.join(OUT, file), body);
    return `<script src="${file}"></script>`;
  });
  if (/<script(?![^>]*\ssrc=)[^>]*>\s*\S/.test(html)) throw new Error("an inline script is left in the page");
  if (/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/g, ""))) throw new Error("an inline event handler is in the page");
  fs.writeFileSync(path.join(OUT, PAGE), html);

  fs.mkdirSync(path.join(OUT, "ext", "icons"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "ext", "ext-shim.js"),
    fs.readFileSync(path.join(ROOT, "ext", "ext-shim.js"), "utf8").replace("__SITE__", site).replace("__PAGE__", PAGE));
  for (const f of ["background.js", "signer.html"]) fs.copyFileSync(path.join(ROOT, "ext", f), path.join(OUT, "ext", f));
  for (const f of fs.readdirSync(path.join(ROOT, "ext", "icons"))) fs.copyFileSync(path.join(ROOT, "ext", "icons", f), path.join(OUT, "ext", "icons", f));
  await bundle(path.join(ROOT, "ext", "device-key.js"), path.join(OUT, "ext", "device-key.js"));
  await bundle(path.join(ROOT, "ext", "signer.js"), path.join(OUT, "ext", "signer.js"));

  // The Alchemy key (token lists) is the site's, from the environment: never in the repository.
  const alchemyApiKey = /^[A-Za-z0-9_-]{8,128}$/.test(process.env.ALCHEMY_KEY || "") ? process.env.ALCHEMY_KEY : "";
  fs.writeFileSync(path.join(OUT, "config.js"),
    `// Generated by scripts/build.js from ext-config.json.\nwindow.CROSSCHAIN_CONFIG = ${JSON.stringify({ walletConnectProjectId: cfg.walletConnectProjectId || "", alchemyApiKey }, null, 2)};\n`);

  const icons = { 48: "ext/icons/icon-48.png", 96: "ext/icons/icon-96.png", 128: "ext/icons/icon-192.png" };
  const manifest = {
    manifest_version: 3,
    name: "UP Wallet",
    version: pkg.version,
    version_name: `${pkg.version} (page ${upstream.commit.slice(0, 7)})`,
    description: "The wallet of a LUKSO Universal Profile on every network where it exists, with this computer's own key. Experimental.",
    key: cfg.manifestKey,
    icons,
    action: { default_title: "UP Wallet", default_icon: icons },
    background: { service_worker: "ext/background.js" },
    side_panel: { default_path: PAGE },
    permissions: ["storage", "sidePanel", "contextMenus"],
    host_permissions: [site + "*"],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'" },
    minimum_chrome_version: "121",
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // The id the key fixes: the relay and the sponsor service must accept chrome-extension://<id>.
  const id = [...crypto.createHash("sha256").update(Buffer.from(cfg.manifestKey, "base64")).digest("hex").slice(0, 32)]
    .map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
  if (id !== cfg.extensionId) throw new Error(`the manifest key gives the id ${id}, ext-config.json says ${cfg.extensionId}`);
  console.log(`dist/ built from Cross_Chain ${upstream.commit.slice(0, 7)}: extension ${id}, ${n} inline scripts moved to files.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
