# Google Sheets Reader — Amplience Workforce extension

Read data **out of a Google Sheet** so it can be used inside a Workforce flow or as a tool by an agent. Read-only (v1a).

Built for three jobs:
- **Reference data** — a product taxonomy, a dictionary of allowed words, a set of rules.
- **Flow inputs** — rows of data fed into a flow.
- **Eval data** — a table of test cases for a flow or action.

## Actions

| Action | What it does |
| --- | --- |
| `listTabs` | List every tab in a sheet (the tab name is often itself a lookup key). |
| `describeSheet` | Inspect one tab: its real used size and its column headers. |
| `readRows` | Read a tab (or an A1 range) as header-keyed row objects, with `limit`/`offset` paging. |
| `getColumnValues` | Read the values down a single named column — the reference-data workhorse. |
| `lookupRows` | Find rows where a column matches a value; optionally return only selected columns. |

Each action makes at most **one** HTTP call to Google — well under the sandbox's 10-call cap. Read once, process in memory; don't loop these over a large catalogue in one execution.

## Example data

[`examples/ecommerce-examples.xlsx`](examples/) is a dummy multi-tab workbook (the fictional retailer "AnyaFinn") covering every function — product data, taxonomy, range→category mapping, column-oriented allowed values, synonyms, and a brand dictionary. See [`examples/README.md`](examples/README.md) for which tab demonstrates which action. All data is invented.

## Works with CSV Tools

This extension and [CSV Tools](https://github.com/pippalarge/csv-tools-workforce-extension) are two halves of one tabular-data pipeline and share the same shape — an array of header-keyed row objects (`rows`):

- **Google Sheets Reader = I/O** — gets `rows` out of a live, business-owned sheet.
- **CSV Tools = transforms** — pure-CPU `filterRows` / `selectColumns` / `validateRows` / `dedupeRows` / `chunkRows` / `toJson` / `arrayToCsv` over those same `rows`.

`readRows` outputs `{ rows: [...] }` and every CSV Tools action takes `{ rows: [...] }`, so they chain directly:

```
readRows (Sheets) → validateRows → filterRows → selectColumns → toJson / arrayToCsv → downstream
```

Use `chunkRows` (CSV Tools) after a single `readRows` to batch rows for per-row API steps and stay under the 10-call sandbox cap.

## Auth (read-only via API key)

This version reads sheets shared as **"anyone with the link can view"** using a Google API key — no service account, no OAuth, no login.

1. In Google Cloud, create an **API key** and enable the **Google Sheets API** for it.
2. Set `GOOGLE_API_KEY` on the extension instance.
3. Share each sheet you want to read as "anyone with the link can view".

> Don't put confidential data in a publicly-viewable sheet. **Writing** back to a sheet is intentionally out of scope here — that needs a service account (a possible future v1b).

## Design notes (from real, messy spreadsheets)

- **Reported tab grid sizes lie** — a tab can claim ~1,048,576 rows from stray formatting. Reads request the tab by name, so Google returns only the populated range.
- **Headers are trimmed** — a lookup for `Neck Shape` still matches a header stored as `"Neck Shape "`.
- **Column-oriented sheets** (each column = an attribute, cells = allowed values) are served by `getColumnValues`.
- **Status envelope** — every action returns top-level `ok` / `status` / `errorCount` / `warningCount` plus `errors[]` / `warnings[]`, so a flow can branch on failures with an **Edit Rules** step (`errorCount Greater Than 0`).

## Develop

```sh
npm run check   # runs the tests + the conformance validator
```

- ES module exports; one object argument in; every action returns an object.
- `inputSchema`/`outputSchema` roots are `{"type":"object"}`; action `name` === function name.
- Simplified JSON Schema only (no `$ref`); `envSchema` required at the manifest root.
- Sandbox: 30s, 10 own HTTP requests, 128MB, no Node-only globals.

## Install on a hub

Extension (container) → Release (a version, holds the code) → Instance (release on a hub).

Automated: `node install.mjs hubs` (proves auth, lists hubs) → `node install.mjs install --hub <id>` (creates a draft release; add `--publish` to publish). Credentials go in a git-ignored `.env` as `AMP_TOKEN=<pat>`.

Or via the Workforce UI: **Integrations → Create extension**, create a release (upload `manifest.json`, paste `index.js`), then install on the hub and set `GOOGLE_API_KEY`. Releases are immutable — to update, publish a new release.
