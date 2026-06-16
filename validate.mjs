#!/usr/bin/env node
// Conformance check for an Amplience Workforce extension.
// Run from the extension folder: `node validate.mjs`
// Exits 0 if everything passes, 1 if any check fails.
//
// Checks the rules that the Workforce release API enforces (so you catch them
// here instead of after a slow upload round-trip):
//   - manifest has top-level `actions` (array) AND `envSchema` (object)  <- envSchema is required even when empty
//   - every action has name/label/description/inputSchema/outputSchema
//   - input/output schema roots are objects
//   - each action `name` exactly matches an exported function (both directions)
//   - no `$ref` anywhere in the manifest (simplified JSON Schema only)
//   - icon string, if present, is <= 4096 chars

import fs from "node:fs";

const problems = [];
const warnings = [];
const ok = [];

function fail(msg) { problems.push(msg); }
function warn(msg) { warnings.push(msg); }
function pass(msg) { ok.push(msg); }

// --- load manifest ---------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
} catch (e) {
  console.error(`✗ Could not read/parse manifest.json: ${e.message}`);
  process.exit(1);
}

// --- top-level keys --------------------------------------------------------
if (!Array.isArray(manifest.actions)) {
  fail('manifest is missing a top-level "actions" array');
} else {
  pass(`manifest has ${manifest.actions.length} action(s)`);
}

if (!manifest.envSchema || typeof manifest.envSchema !== "object" || Array.isArray(manifest.envSchema)) {
  fail('manifest is missing top-level "envSchema" object (REQUIRED even with no env vars — use { "type": "object", "properties": {} })');
} else {
  pass("manifest has envSchema");
}

// --- $ref check ------------------------------------------------------------
if (JSON.stringify(manifest).includes("$ref")) {
  fail('manifest uses "$ref" — not allowed in the simplified JSON Schema');
} else {
  pass("no $ref in manifest");
}

// --- exported function names ----------------------------------------------
let exported = [];
try {
  const code = fs.readFileSync("index.js", "utf8");
  const m = code.match(/export\s*\{([^}]*)\}/s);
  if (m) {
    exported = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
  } else if (/export\s+(?:default\s+)?function/.test(code)) {
    warn("index.js uses inline `export function` — name-match check skipped; verify names by hand");
  } else {
    fail("index.js has no `export { ... }` block");
  }
} catch (e) {
  fail(`could not read index.js: ${e.message}`);
}

// --- per-action checks -----------------------------------------------------
const required = ["name", "label", "description", "inputSchema", "outputSchema"];
const actionNames = [];
for (const a of manifest.actions || []) {
  const id = a.name || "(unnamed)";
  actionNames.push(a.name);
  const missing = required.filter((k) => !(k in a));
  if (missing.length) fail(`action "${id}": missing field(s): ${missing.join(", ")}`);
  if (a.inputSchema && a.inputSchema.type !== "object") fail(`action "${id}": inputSchema root must be {"type":"object"}`);
  if (a.outputSchema && a.outputSchema.type !== "object") fail(`action "${id}": outputSchema root must be {"type":"object"}`);
  if (exported.length && a.name && !exported.includes(a.name)) fail(`action "${id}": no exported function named "${a.name}"`);
}
if (exported.length) {
  for (const e of exported) {
    if (!actionNames.includes(e)) warn(`exported "${e}" has no matching action in the manifest (dead export?)`);
  }
}
if ((manifest.actions || []).every((a) => required.every((k) => k in a) && a.inputSchema?.type === "object" && a.outputSchema?.type === "object")) {
  pass("all actions: required fields present + input/output roots are objects");
}

// --- icon size -------------------------------------------------------------
for (const iconFile of ["icon-base64.txt", "csv-icon-base64.txt"]) {
  if (fs.existsSync(iconFile)) {
    const s = fs.readFileSync(iconFile, "utf8").trim();
    if (s.length > 4096) fail(`${iconFile}: ${s.length} chars — exceeds the 4096 icon limit`);
    else pass(`${iconFile}: ${s.length} chars (<= 4096)`);
    if (!s.startsWith("data:image/svg+xml")) warn(`${iconFile}: does not start with "data:image/svg+xml" — is it a valid data URI?`);
  }
}

// --- report ----------------------------------------------------------------
for (const m of ok) console.log(`✓ ${m}`);
for (const w of warnings) console.log(`⚠ ${w}`);
for (const p of problems) console.log(`✗ ${p}`);

console.log("");
if (problems.length) {
  console.log(`FAILED — ${problems.length} problem(s) to fix before uploading.`);
  process.exit(1);
} else {
  console.log(`PASSED${warnings.length ? ` (with ${warnings.length} warning(s))` : ""} — conforms to the Workforce extension spec.`);
  process.exit(0);
}
