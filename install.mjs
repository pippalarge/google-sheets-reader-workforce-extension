#!/usr/bin/env node
// Install an Amplience Workforce extension via the GraphQL Management API.
// Docs: https://amplience.com/developers/docs/workforce/flows/installing-extensions-with-graphql/
//
// SAFETY: read-only by default. `hubs` only reads. `install` prints a full plan
// and requires --yes (or an interactive confirmation) before it writes anything.
// Releases are created as drafts unless --publish is passed.
//
// Credentials come from a local .env file (git-ignored) or the environment:
//   AMP_CLIENT_ID, AMP_CLIENT_SECRET      (OAuth client credentials)   — OR —
//   AMP_TOKEN                              (a pre-obtained bearer token)
// Optional overrides:
//   AMP_AUTH_URL     (default https://auth.amplience.net/oauth/token)
//   AMP_GRAPHQL_URL  (default https://api.amplience.net/graphql)
//   AMP_HUB_ID       (skip the hub lookup if you already know it)
//
// Usage:
//   node install.mjs hubs                 # read-only: prove auth + list hub IDs
//   node install.mjs install --hub <id>   # plan the install, then confirm
//   node install.mjs install --hub <id> --yes [--publish]
//
// Per-extension metadata is read from extension.config.json (see that file).

import fs from "node:fs";
import readline from "node:readline";

// --- tiny .env loader (no dependency) --------------------------------------
function loadEnv() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const AUTH_URL = process.env.AMP_AUTH_URL || "https://auth.amplience.net/oauth/token";
const GRAPHQL_URL = process.env.AMP_GRAPHQL_URL || "https://api.amplience.net/graphql";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// --- auth ------------------------------------------------------------------
async function getToken() {
  if (process.env.AMP_TOKEN) return process.env.AMP_TOKEN;
  const id = process.env.AMP_CLIENT_ID;
  const secret = process.env.AMP_CLIENT_SECRET;
  if (!id || !secret) {
    die("No credentials. Set AMP_CLIENT_ID + AMP_CLIENT_SECRET (or AMP_TOKEN) in .env or the environment.");
  }
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) die(`Auth failed (${res.status}) at ${AUTH_URL}:\n${text}\n\nIf the auth URL is wrong, set AMP_AUTH_URL in .env.`);
  let json;
  try { json = JSON.parse(text); } catch { die(`Auth returned non-JSON:\n${text}`); }
  if (!json.access_token) die(`Auth response had no access_token:\n${text}`);
  return json.access_token;
}

// --- graphql ---------------------------------------------------------------
async function gql(token, query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { die(`GraphQL returned non-JSON (${res.status}):\n${text}`); }
  if (json.errors && json.errors.length) {
    die(`GraphQL error:\n${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

const LIST_HUBS = `query listHubs {
  viewer { organizations { edges { node { id name cmsHubs { id name } } } } }
}`;

async function listHubs(token) {
  const data = await gql(token, LIST_HUBS, {});
  const orgs = data?.viewer?.organizations?.edges || [];
  const hubs = [];
  for (const o of orgs) {
    for (const h of o.node?.cmsHubs || []) hubs.push({ org: o.node.name, hubId: h.id, hubName: h.name });
  }
  return hubs;
}

// --- metadata --------------------------------------------------------------
function readConfig() {
  let cfg = {};
  if (fs.existsSync("extension.config.json")) cfg = JSON.parse(fs.readFileSync("extension.config.json", "utf8"));
  let pkg = {};
  if (fs.existsSync("package.json")) pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  const descFile = cfg.descriptionFile || "description.md";
  const iconFile = cfg.iconFile || (fs.existsSync("icon-base64.txt") ? "icon-base64.txt" : null);

  const manifest = fs.readFileSync("manifest.json", "utf8");
  const code = fs.readFileSync("index.js", "utf8");

  return {
    label: cfg.label || pkg.name || "Untitled extension",
    version: cfg.version || pkg.version || "0.1.0",
    description: descFile && fs.existsSync(descFile) ? fs.readFileSync(descFile, "utf8") : (pkg.description || ""),
    url: cfg.docsUrl || "",
    icon: iconFile && fs.existsSync(iconFile) ? fs.readFileSync(iconFile, "utf8").trim() : "",
    manifest,
    code,
  };
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} (type "yes" to proceed) `, (a) => { rl.close(); resolve(a.trim().toLowerCase() === "yes"); });
  });
}

// --- mutations -------------------------------------------------------------
const CREATE_EXTENSION = `mutation ($input: CreateExtensionInput!) {
  createExtension(input: $input) { id }
}`;
const CREATE_RELEASE = `mutation ($input: CreateExtensionReleaseInput!) {
  createExtensionRelease(input: $input) { id }
}`;
const CREATE_INSTANCE = `mutation ($input: CreateExtensionInstanceInput!) {
  createExtensionInstance(input: $input) { id }
}`;

async function install(token) {
  const hubId = opt("--hub", process.env.AMP_HUB_ID);
  if (!hubId) die('No hub id. Pass --hub <id> (run `node install.mjs hubs` to find it) or set AMP_HUB_ID.');

  const c = readConfig();
  const publish = flag("--publish");

  console.log("\nInstall plan");
  console.log("------------");
  console.log(`  Hub:         ${hubId}`);
  console.log(`  Label:       ${c.label}`);
  console.log(`  Version:     ${c.version}`);
  console.log(`  Docs URL:    ${c.url || "(none)"}`);
  console.log(`  Icon:        ${c.icon ? `${c.icon.length} chars` : "(none)"}`);
  console.log(`  manifest.js: ${c.manifest.length} chars`);
  console.log(`  index.js:    ${c.code.length} chars`);
  console.log(`  Release:     ${publish ? "PUBLISHED (latest)" : "draft (account-only)"}`);
  console.log("");

  if (!flag("--yes")) {
    const okGo = await confirm("Create extension + release + instance on this hub?");
    if (!okGo) die("Aborted — nothing was created.");
  }

  console.log("→ createExtension...");
  const ext = await gql(token, CREATE_EXTENSION, {
    input: { cmsHubId: hubId, label: c.label, description: c.description, url: c.url, icon: c.icon },
  });
  const extensionId = ext.createExtension.id;
  console.log(`  extensionId = ${extensionId}`);

  console.log("→ createExtensionRelease...");
  const rel = await gql(token, CREATE_RELEASE, {
    input: {
      extensionId,
      label: c.version,
      releaseNotes: `Version ${c.version}`,
      draft: !publish,
      latest: publish,
      sourceFiles: [
        { path: "manifest.json", content: c.manifest },
        { path: "index.js", content: c.code },
      ],
    },
  });
  const releaseId = rel.createExtensionRelease.id;
  console.log(`  releaseId = ${releaseId}`);

  console.log("→ createExtensionInstance...");
  const inst = await gql(token, CREATE_INSTANCE, {
    input: { cmsHubId: hubId, extensionId, extensionReleaseId: releaseId, label: c.label, description: c.label, env: {} },
  });
  console.log(`  instanceId = ${inst.createExtensionInstance.id}`);

  console.log(`\n✓ Installed "${c.label}" v${c.version} on hub ${hubId}.`);
  console.log("  It should appear under Integrations →", c.label, "in the Action Library.");
}

// --- main ------------------------------------------------------------------
const token = await getToken();

if (cmd === "hubs") {
  const hubs = await listHubs(token);
  if (!hubs.length) { console.log("Auth OK, but no hubs found for this account."); process.exit(0); }
  console.log("\n✓ Auth OK. Hubs you can reach:\n");
  for (const h of hubs) console.log(`  ${h.hubId}   ${h.hubName}   (org: ${h.org})`);
  console.log("\nUse one of these IDs with: node install.mjs install --hub <id>\n");
} else if (cmd === "install") {
  await install(token);
} else {
  console.log(`Usage:
  node install.mjs hubs                          read-only: prove auth + list hub IDs
  node install.mjs install --hub <id>            plan the install, then confirm
  node install.mjs install --hub <id> --yes      skip the confirmation prompt
  node install.mjs install --hub <id> --publish  publish the release (default is draft)`);
}
