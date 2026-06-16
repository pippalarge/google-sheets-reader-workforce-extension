# Google Sheets — Amplience Workforce extension

Read data **out of a Google Sheet** and write data **back into one**, so a Workforce flow or an agent can use a sheet as both a source and a sink.

Built for four jobs:
- **Reference data** — a product taxonomy, a dictionary of allowed words, a set of rules. *(read)*
- **Flow inputs** — rows of data fed into a flow. *(read)*
- **Eval data** — a table of test cases for a flow or action. *(read)*
- **Flow outputs** — enriched/generated rows written back. *(write)*

## Actions

| Action | What it does | Auth |
| --- | --- | --- |
| `listTabs` | List every tab in a sheet (the tab name is often itself a lookup key). | API key |
| `describeSheet` | Inspect one tab: its real used size and its column headers. | API key |
| `readRows` | Read a tab (or an A1 range) as header-keyed row objects, with `limit`/`offset` paging. | API key |
| `getColumnValues` | Read the values down a single named column — the reference-data workhorse. | API key |
| `lookupRows` | Find rows where a column matches a value; optionally return only selected columns. | API key |
| `appendRows` | **Write** — append new rows to the bottom of a tab. Safe: never overwrites. | OAuth |
| `updateRange` | **Write** — overwrite a specific A1 range. Deliberate: replaces what's there. | OAuth |

Read actions make one HTTP call; write actions make one or two (plus at most one token refresh) — all under the sandbox's 10-call cap. Read once, process in memory; don't loop these over a large catalogue in one execution.

## Example data

[`examples/ecommerce-examples.xlsx`](examples/) is a dummy multi-tab workbook (the fictional retailer "AnyaFinn") covering every function — product data, taxonomy, range→category mapping, column-oriented allowed values, synonyms, and a brand dictionary. See [`examples/README.md`](examples/README.md) for which tab demonstrates which action. All data is invented.

## Works with CSV Tools

This extension and [CSV Tools](https://github.com/pippalarge/csv-tools-workforce-extension) are two halves of one tabular-data pipeline and share the same shape — an array of header-keyed row objects (`rows`):

- **Google Sheets Reader = I/O** — gets `rows` out of a live, business-owned sheet.
- **CSV Tools = transforms** — pure-CPU `filterRows` / `selectColumns` / `validateRows` / `dedupeRows` / `chunkRows` / `toJson` / `arrayToCsv` over those same `rows`.

`readRows` outputs `{ rows: [...] }`, every CSV Tools action takes and returns `{ rows: [...] }`, and `appendRows` takes `{ rows: [...] }` — so a full read → transform → write-back round-trip chains directly:

```
readRows (Sheets) → validateRows → filterRows → mapColumns (CSV Tools) → appendRows (Sheets write-back)
```

Use `chunkRows` (CSV Tools) after a single `readRows` to batch rows for per-row API steps and stay under the 10-call sandbox cap.

## Auth — two models, by direction

**Reading** uses a Google **API key** against sheets shared as "anyone with the link can view" — no login.

1. In Google Cloud, create an **API key** and enable the **Google Sheets API** for it.
2. Set `GOOGLE_API_KEY` on the extension instance.
3. Share each sheet you want to read as "anyone with the link can view".

> Don't put confidential data in a publicly-viewable sheet.

**Writing** can't use an API key — it needs **OAuth** credentials with the `spreadsheets` scope and edit access to the sheet. Set either:

- `GOOGLE_ACCESS_TOKEN` — a pre-obtained access token, or
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` — the refresh-token flow (runs unattended; no service-account key-signing needed, which the sandbox can't do reliably).

Write safety: both write actions default to **RAW** input, so a value like `=SUM(...)` is stored as literal text, never executed (blocks formula injection). `appendRows` only adds rows; `updateRange` overwrites the range you give it — so point it at a range you own.

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

Or via the Workforce UI: **Integrations → Create extension**, create a release (upload `manifest.json`, paste `index.js`), then install on the hub and set `GOOGLE_API_KEY` (reads) and/or the OAuth vars (writes). Releases are immutable — to update, publish a new release.
