# Google Sheets Reader

Read data **out of a Google Sheet** so it can be used inside a Workforce flow or as a tool by an agent.

Built for three jobs:

- **Reference data** — look up a product taxonomy, a dictionary of allowed words, or a set of rules.
- **Flow inputs** — pull rows of data into a flow.
- **Eval data** — read a table of test cases for a flow or action.

## Actions

- **List Tabs** — list every tab in a sheet (the tab name is often itself a lookup key).
- **Describe Sheet** — inspect one tab: its real used size and its column headers.
- **Read Rows** — read a tab (or an A1 range) as header-keyed row objects, with paging.
- **Get Column Values** — read the values down a single named column (the reference-data workhorse).
- **Lookup Rows** — find rows where a column matches a value, optionally returning selected columns.

## Setup

This version is **read-only**. It reads sheets shared as **"anyone with the link can view"** using a Google API key — no service account or login needed.

1. In Google Cloud, create an **API key** and enable the **Google Sheets API** for it.
2. Set `GOOGLE_API_KEY` on the extension instance.
3. Make sure each sheet you want to read is shared as "anyone with the link can view".

> Confidential data should **not** be put in a publicly-viewable sheet. Writing back to a sheet is intentionally out of scope here — that would require a service account.

## Notes

- Reported tab grid sizes are *allocated*, not populated; reads return only the real used range.
- Column headers are trimmed, so lookups still match headers that have stray trailing spaces.
- Every action returns a uniform status envelope (`ok`, `status`, `errorCount`, `errors[]`) so flows can branch on failures with an Edit Rules step.
