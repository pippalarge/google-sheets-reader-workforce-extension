Read data out of a Google Sheet and write data back into one — inside a Workforce flow or as a tool for an agent.

Built for four jobs:
- Reference data — look up a product taxonomy, a dictionary of allowed words, or a set of rules (read).
- Flow inputs — pull rows of data into a flow (read).
- Eval data — read a table of test cases for a flow or action (read).
- Flow outputs — write enriched or generated rows back to a sheet (write).

Actions:
- List Tabs — list every tab in a sheet (the tab name is often itself a lookup key).
- Describe Sheet — inspect one tab: its real used size and its column headers.
- Read Rows — read a tab or A1 range as row objects, with paging.
- Get Column Values — read the values down a single named column (the reference-data workhorse).
- Lookup Rows — find rows where a column matches a value, optionally returning selected columns.
- Append Rows (write) — add new rows to the bottom of a tab. Safe: never overwrites.
- Update Range (write) — overwrite a specific A1 range. Deliberate: replaces what is there.

Reads use a Google API key against sheets shared as "anyone with the link can view" — no login needed. Writes need OAuth credentials with the spreadsheets scope and edit access (set GOOGLE_ACCESS_TOKEN, or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN). Writes store values literally to avoid formula injection. Do not put confidential data in a publicly viewable sheet.

Every action returns a uniform status envelope (ok, status, errorCount, errors) so a flow can branch on failures with an Edit Rules step.
