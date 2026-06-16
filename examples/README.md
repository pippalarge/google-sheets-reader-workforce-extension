# Example data (dummy)

A fictional clothing retailer ("AnyaFinn", Amplience's standard dummy retailer) — **all data is invented** and safe to use in docs, demos, and tests.

- [`ecommerce-examples.xlsx`](ecommerce-examples.xlsx) — one workbook, seven tabs (upload to Google Sheets to try the extension).
- [`csv/`](csv) — the same seven tabs exported as CSV (handy for **CSV Tools** — see below).

## Each tab maps to a function

| Tab | Shape | Action it demonstrates | Use case |
| --- | --- | --- | --- |
| **Products** | rows of products | `readRows` | Product data — flow inputs/outputs |
| **Taxonomy** | Department → Category → Subcategory + code | `readRows` / `lookupRows` | Taxonomy lookup |
| **Range to Category** | range → category → which attribute tab applies | `lookupRows` | Mapping / join-key lookup |
| **Allowed Values - Dresses** | column-oriented (each column = an attribute) | `getColumnValues` | Attribute lookup |
| **Allowed Values - Tops** | column-oriented | `getColumnValues` + `listTabs` | Attribute lookup across tabs |
| **Synonyms** | canonical term → synonyms | `lookupRows` | Synonyms lookup |
| **Brand Dictionary** | term → type/replacement | `lookupRows` / `getColumnValues` | Dictionary (allowed/banned words) |

### Worked examples

- **Attribute lookup** — "What neck shapes are allowed for dresses?"
  `getColumnValues({ tab: "Allowed Values - Dresses", column: "Neck Shape" })`
  → `["Crew Neck","V-Neck","Scoop","Halter","Square"]`
- **Synonyms** — "What do people call trousers?"
  `lookupRows({ tab: "Synonyms", matchColumn: "Canonical Term", matchValue: "Trousers" })`
  → `[{ "Canonical Term": "Trousers", "Synonyms": "pants, slacks, chinos" }]`
- **Dictionary** — "Is 'cheap' an allowed word?"
  `lookupRows({ tab: "Brand Dictionary", matchColumn: "Term", matchValue: "cheap" })`
  → `[{ Term: "cheap", Type: "Banned", Replacement: "great value", ... }]`
- **Taxonomy → attribute chain** — given a merchandising range, find which attribute set applies:
  `lookupRows({ tab: "Range to Category", matchColumn: "Product Range", matchValue: "LADIES DAY DRESSES" })`
  → the `Attribute Tab` value (`"Allowed Values - Dresses"`), then feed that into `getColumnValues`.

## How this fits with **CSV Tools**

Google Sheets Reader and [CSV Tools](https://github.com/pippalarge/csv-tools-workforce-extension) are two halves of one tabular-data pipeline, and they share the **same data shape**: an array of header-keyed row objects (`rows`).

- **Google Sheets Reader = I/O** — gets `rows` *out of* a sheet (a live, business-user-owned source).
- **CSV Tools = transforms** — pure-CPU shaping of `rows`: `filterRows`, `selectColumns`, `mapColumns`, `validateRows`, `dedupeRows`, `chunkRows`, `summarizeRows`, `toJson` / `arrayToCsv`.

Because `readRows` outputs `{ rows: [...] }` and every CSV Tools action takes `{ rows: [...] }`, they chain with no glue code:

```
readRows (Sheets)  →  validateRows (CSV Tools)  →  filterRows  →  selectColumns  →  toJson / arrayToCsv  →  downstream step
```

Two patterns worth knowing:
- **Stay under the API cap.** Read a sheet once with `readRows`, then `chunkRows` (CSV Tools) to batch the rows for any per-row API step — one sheet read, not one per row.
- **Reference-data lookups in memory.** For a taxonomy/dictionary an agent hits many times, read the tab once and filter in memory rather than calling `lookupRows` per item.

The CSV files in [`csv/`](csv) are the same data in the format `CSV Tools`' `parseCsv` consumes — so you can demo the two extensions together without a live sheet.
