# Example data (dummy)

A fictional clothing retailer ("AnyaFinn", Amplience's standard dummy retailer) — **all data is invented** and safe to use in docs, demos, and tests.

- [`ecommerce-examples.xlsx`](ecommerce-examples.xlsx) — one workbook, seven tabs (upload to Google Sheets to try the extension).
- [`csv/`](csv) — the same seven tabs exported as CSV (drop into Table Tools' `csvToRows` to demo without a live sheet).

## Each tab + the use case it shows

These use the two extensions together: **Google Sheets** loads the rows; **Table Tools** queries/shapes them.

| Tab | Shape | Pipeline | Use case |
| --- | --- | --- | --- |
| **Products** | rows of products | `loadRows` | Product data — flow inputs/outputs |
| **Taxonomy** | Department → Category → Subcategory + code | `loadRows` → `joinRows` | Taxonomy lookup / enrichment |
| **Range to Category** | range → category → which attribute tab applies | `loadRows` → `filterRows` / `joinRows` | Mapping / join-key lookup |
| **Allowed Values - Dresses** | column-oriented (each column = an attribute) | `loadRows` → `pluckColumn` | Attribute lookup |
| **Allowed Values - Tops** | column-oriented | `listTabs` → `loadRows` → `pluckColumn` | Attribute lookup across tabs |
| **Synonyms** | canonical term → synonyms | `loadRows` → `filterRows` | Synonyms lookup |
| **Brand Dictionary** | term → type/replacement | `loadRows` → `filterRows` / `pluckColumn` | Dictionary (allowed/banned words) |

### Worked examples (Sheets load → Table Tools query)

- **Attribute lookup** — "What neck shapes are allowed for dresses?"
  `loadRows({ tab: "Allowed Values - Dresses" })` → `pluckColumn({ rows, column: "Neck Shape" })`
  → `["Crew Neck","V-Neck","Scoop","Halter","Square"]`
- **Synonyms** — "What do people call trousers?"
  `loadRows({ tab: "Synonyms" })` → `filterRows({ rows, column: "Canonical Term", operator: "eq", value: "Trousers" })`
  → `[{ "Canonical Term": "Trousers", "Synonyms": "pants, slacks, chinos" }]`
- **Dictionary** — "Is 'cheap' an allowed word?"
  `loadRows({ tab: "Brand Dictionary" })` → `filterRows({ rows, column: "Term", operator: "eq", value: "cheap" })`
  → `[{ Term: "cheap", Type: "Banned", Replacement: "great value", ... }]`
- **Enrich products with taxonomy** — attach the `Category Code` to every product in one step:
  `loadRows({ tab: "Products" })` + `loadRows({ tab: "Taxonomy" })` → `joinRows({ leftRows, rightRows, leftKey: "Category", rightKey: "Category" })`

## How the two extensions fit together

[Google Sheets](https://github.com/pippalarge/google-sheets-reader-workforce-extension) and [Table Tools](https://github.com/pippalarge/csv-tools-workforce-extension) are two halves of one tabular-data pipeline, joined by a shared shape: **`rows`** (an array of header-keyed objects).

- **Google Sheets = I/O** — gets `rows` out of (`loadRows` / `loadTabs`) and back into (`appendRows` / `updateRange`) a live, business-owned sheet.
- **Table Tools = transforms** — pure-CPU shaping of `rows`: `filterRows`, `sortRows`, `joinRows`, `addColumn`, `pluckColumn`, `selectColumns`, `validateRows`, `dedupeRows`, `chunkRows`, and CSV/JSON adapters.

Because `loadRows` outputs `{ rows: [...] }` and every Table Tools action takes `{ rows: [...] }`, they chain with no glue:

```
loadRows (Sheets)  →  joinRows / addColumn / filterRows (Table Tools)  →  appendRows (Sheets write-back)
```

Two patterns worth knowing:
- **Stay under the API cap.** Load a sheet once with `loadRows` (or all tabs with `loadTabs`), then `chunkRows` (Table Tools) to batch the rows for any per-row API step — one sheet read, not one per row.
- **Reference-data lookups in memory.** For a taxonomy/dictionary used many times, load the tab once and filter in memory rather than re-reading per item.

The CSV files in [`csv/`](csv) are the same data in the form Table Tools' `csvToRows` consumes — so you can demo the two extensions together without a live sheet.
