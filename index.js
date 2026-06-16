// Amplience Workforce extension — Google Sheets (read + write)
//
// Reads data OUT of a Google Sheet and (v1b) writes data BACK to one, so a
// Workforce flow or an agent can use a sheet as both a source and a sink.
//
// TWO AUTH MODELS, by direction (this is the key thing to understand):
//   - READ  (listTabs, describeSheet, readRows, getColumnValues, lookupRows):
//     a Google API key (GOOGLE_API_KEY) used as ?key=... This works ONLY on
//     sheets shared as "anyone with the link can view" — no login needed.
//   - WRITE (appendRows, updateRange): an API key CANNOT write. Writing needs
//     OAuth credentials with the spreadsheets scope and edit access to the
//     sheet — either a pre-obtained GOOGLE_ACCESS_TOKEN, or the refresh-token
//     flow (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN).
//     Service-account JWT (RS256) signing is intentionally NOT used — it isn't
//     reliably available in the Min Common Web Platform sandbox; the
//     refresh-token flow needs no signing and runs unattended.
//
// USE CASES this serves:
//   - reference data ....... a product taxonomy, a dictionary of allowed words,
//                            a set of rules (the column-lookup workhorse) [read]
//   - flow inputs .......... rows of data fed into a flow                  [read]
//   - eval data ............ a table of test cases for a flow or action    [read]
//   - flow outputs ......... enriched/generated rows written back          [write]
//
// WRITE GUARDRAILS: writes default to RAW input (a cell value like "=SUM(...)"
// is stored as literal text, never executed — this blocks formula injection).
// appendRows is the safe default (it only adds new rows). updateRange overwrites
// a caller-specified range, so it is the "be deliberate" action. The extension
// writes exactly the values it is given; it never invents data.
//
// DESIGN NOTES (from looking at real, messy merchandising spreadsheets):
//   - Tabs are first-class. The tab name is often itself a lookup/join key, so
//     listTabs lets a flow/agent discover tabs before reading one.
//   - Sheets can be COLUMN-oriented (each column = an attribute, the cells down
//     it = the allowed values), so getColumnValues reads a single column, not
//     just whole rows.
//   - Reported grid size LIES (a tab can claim ~1,048,576 rows from stray
//     formatting). We never trust the grid size for reads: requesting a tab by
//     name returns only the POPULATED rectangle, which is the real used range.
//   - Headers often carry trailing spaces ("Stitching "). We trim header names
//     so lookups by clean column name still match.
//
// SANDBOX: read actions make ONE HTTP call; write actions make one or two
// (appendRows reads the header row to align columns unless `columns` is given),
// plus at most one token refresh — all well under the 10-own-HTTP-calls cap. Do
// not loop these over a large catalogue inside one execution; read once and
// process in memory, page with limit/offset, or write in batches.
//
// ERROR-HANDLING CONTRACT: every action returns a uniform status envelope
// alongside its payload:
//     ok           boolean  — true when there are no errors (the gate)
//     status       string   — "ok" | "warning" | "error"
//     errorCount   number   — branch with Edit Rules: errorCount > 0
//     warningCount number   — non-blocking issues count
//     errors       array    — [{ code, message, field }]
//     warnings     array    — [{ code, message, field }]
// Actions do NOT throw for expected outcomes (bad id, tab not found, sheet not
// public) — they return them in the envelope with a clear `code` so the flow
// can route to a review/retry path. Throwing is reserved for catastrophic faults.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// How a written value is interpreted by Google. RAW (default) stores the value
// literally — a string starting with "=" stays text, blocking formula injection.
// USER_ENTERED parses values as if a person typed them (numbers, dates, formulas).
const VALUE_INPUT_MODES = {
  raw: "RAW",
  user: "USER_ENTERED",
  user_entered: "USER_ENTERED",
};

// Accepted value-render modes mapped to the Sheets API valueRenderOption.
//   formatted   -> FORMATTED_VALUE   (human-readable: "$1.23", dates as text) [default]
//   unformatted -> UNFORMATTED_VALUE (computed raw value; lookups resolve; dates as serials)
//   formula     -> FORMULA           (the raw formula text, not its result)
const VALUE_MODES = {
  formatted: "FORMATTED_VALUE",
  unformatted: "UNFORMATTED_VALUE",
  formula: "FORMULA",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function trimStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function env(name) {
  // Env vars declared in the manifest's envSchema are injected via process.env.
  return trimStr(typeof process !== "undefined" && process.env ? process.env[name] : "");
}

function issue(code, message, field) {
  return { code, message, field: field || null };
}

// Wrap a payload in the uniform status envelope. The status scalars are
// top-level so they are directly selectable as a Variable in a Workforce
// Edit Rules branch (e.g. errorCount Greater Than 0).
function envelope(payload, errors = [], warnings = []) {
  return {
    ...payload,
    ok: errors.length === 0,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok",
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
  };
}

// Accept either a bare spreadsheet id or a full Google Sheets URL and return
// just the id. URL form: https://docs.google.com/spreadsheets/d/{id}/edit#...
function resolveSpreadsheetId(input) {
  const raw = trimStr(input);
  if (!raw) return "";
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}

// Normalise a value-mode string to a valueRenderOption; default formatted.
function valueRenderOption(valueMode) {
  const key = trimStr(valueMode).toLowerCase();
  return VALUE_MODES[key] || VALUE_MODES.formatted;
}

// Normalise a value-input mode to a valueInputOption; default RAW (safe).
function valueInputOption(mode) {
  const key = trimStr(mode).toLowerCase();
  return VALUE_INPUT_MODES[key] || VALUE_INPUT_MODES.raw;
}

// Map an HTTP failure to a standard issue. The 401/403 messages differ for
// reads (API key on a public sheet) vs writes (OAuth + edit access), so the
// caller passes { write: true } for write requests.
function httpErrorIssue(status, bodyText, opts = {}) {
  const write = !!opts.write;
  if (status === 403) {
    return issue(
      "access_denied",
      write
        ? "Google denied the write (HTTP 403). The OAuth credentials need the spreadsheets scope and edit access to this sheet."
        : "Google denied access (HTTP 403). The sheet must be shared as \"anyone with the link can view\", and the Google Sheets API must be enabled for the API key.",
      null
    );
  }
  if (status === 401) {
    return issue(
      "auth_failed",
      write
        ? "Google rejected the OAuth credentials (HTTP 401). Check the access/refresh token and the spreadsheets scope."
        : "Google rejected the API key (HTTP 401). Check GOOGLE_API_KEY.",
      null
    );
  }
  if (status === 404) {
    return issue("spreadsheet_not_found", "Spreadsheet not found (HTTP 404). Check the spreadsheet id/URL.", "spreadsheetId");
  }
  if (status === 429) {
    return issue("rate_limited", "Google rate limit hit (HTTP 429). Retry after a short delay.", null);
  }
  if (status === 400) {
    const snippet = trimStr(bodyText).slice(0, 200);
    return issue("bad_request", `Google rejected the request (HTTP 400)${snippet ? `: ${snippet}` : ""}. Check the tab name and range.`, null);
  }
  const snippet = trimStr(bodyText).slice(0, 200);
  return issue("api_error", `Google Sheets API returned HTTP ${status}${snippet ? `: ${snippet}` : ""}.`, null);
}

// Perform a GET against the Sheets API and return { data } or { error }.
// Never throws for an expected HTTP/credential problem.
async function sheetsGet(path, params) {
  const key = env("GOOGLE_API_KEY");
  if (!key) {
    return { error: issue("missing_api_key", "No Google API key configured. Set GOOGLE_API_KEY on the extension instance.", null) };
  }
  // Build the query string; array values (e.g. batchGet `ranges`) repeat the key.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.append(k, v);
  }
  qs.append("key", key);
  const url = `${SHEETS_API_BASE}${path}?${qs.toString()}`;

  let resp;
  try {
    resp = await fetch(url, { method: "GET" });
  } catch (e) {
    return { error: issue("api_unreachable", `Could not reach the Google Sheets API: ${e && e.message ? e.message : e}.`, null) };
  }

  let bodyText = "";
  try {
    bodyText = await resp.text();
  } catch (_) {
    /* ignore */
  }

  if (!resp.ok) {
    return { error: httpErrorIssue(resp.status, bodyText) };
  }

  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (e) {
    return { error: issue("bad_response", "Google returned a response that could not be parsed as JSON.", null) };
  }
  return { data };
}

// Obtain an OAuth2 access token for WRITE requests. Returns { token } or
// { error }. Either a pre-obtained GOOGLE_ACCESS_TOKEN, or the refresh-token
// flow (no RS256 signing needed, so it works in the sandbox). Never throws.
async function getAccessToken() {
  const preObtained = env("GOOGLE_ACCESS_TOKEN");
  if (preObtained) return { token: preObtained };

  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const refreshToken = env("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    return {
      error: issue(
        "missing_credentials",
        "Writing needs OAuth credentials (an API key cannot write). Set GOOGLE_ACCESS_TOKEN, or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN with the spreadsheets scope.",
        null
      ),
    };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  let resp;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e) {
    return { error: issue("token_unreachable", `Could not reach Google's token endpoint: ${e && e.message ? e.message : e}.`, null) };
  }

  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    /* fall through */
  }
  if (!resp.ok || !data || !data.access_token) {
    const detail = data && (data.error_description || data.error) ? `: ${data.error_description || data.error}` : "";
    return { error: issue("auth_failed", `Token exchange failed (HTTP ${resp.status})${detail}.`, null) };
  }
  return { token: data.access_token };
}

// Perform an authenticated (bearer-token) request against the Sheets API for
// reads done as part of a write, and for the writes themselves. Returns
// { data } or { error }. Never throws for an expected HTTP problem.
async function sheetsAuthed(method, path, token, params, bodyObj) {
  const qs = new URLSearchParams(params || {});
  const url = `${SHEETS_API_BASE}${path}?${qs.toString()}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (bodyObj !== undefined) headers["Content-Type"] = "application/json";

  let resp;
  try {
    resp = await fetch(url, { method, headers, body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined });
  } catch (e) {
    return { error: issue("api_unreachable", `Could not reach the Google Sheets API: ${e && e.message ? e.message : e}.`, null) };
  }

  let bodyText = "";
  try {
    bodyText = await resp.text();
  } catch (_) {
    /* ignore */
  }

  if (!resp.ok) {
    return { error: httpErrorIssue(resp.status, bodyText, { write: method !== "GET" }) };
  }

  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (e) {
    return { error: issue("bad_response", "Google returned a response that could not be parsed as JSON.", null) };
  }
  return { data };
}

// Build a 2D values array from row objects in a fixed column order.
// Missing/blank keys become "" so every row is the same width.
function rowsToValues(rows, columns) {
  return rows.map((row) =>
    columns.map((col) => {
      const v = row ? row[col] : undefined;
      return v === undefined || v === null ? "" : v;
    })
  );
}

// Build the A1 range segment for a whole tab. Requesting a tab by name returns
// only the populated rectangle (the real used range), sidestepping phantom rows.
// Sheet names are wrapped in single quotes (and internal quotes doubled).
function tabRange(tab, a1) {
  const safe = `'${String(tab).replace(/'/g, "''")}'`;
  return a1 ? `${safe}!${a1}` : safe;
}

// A grid (array of row arrays) -> { headers, rows }.
//   headerRowIndex is 0-based within the returned grid.
//   Header names are trimmed (handles trailing-space headers).
//   Rows are padded so every row has a value for every header.
function gridToRows(grid, headerRowIndex) {
  if (!Array.isArray(grid) || grid.length <= headerRowIndex) {
    return { headers: [], rows: [] };
  }
  const rawHeaders = grid[headerRowIndex] || [];
  const headers = rawHeaders.map((h, i) => {
    const name = trimStr(typeof h === "string" ? h : (h === null || h === undefined ? "" : String(h)));
    return name === "" ? `column_${i + 1}` : name;
  });

  const rows = [];
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const cells = grid[r] || [];
    // Skip fully-empty rows.
    if (cells.length === 0 || cells.every((c) => c === "" || c === null || c === undefined)) continue;
    const obj = {};
    headers.forEach((header, idx) => {
      const v = cells[idx];
      obj[header] = v === undefined || v === null ? "" : v;
    });
    rows.push(obj);
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// listTabs: list every tab (worksheet) in a spreadsheet.
// One metadata call. NOTE: gridRows/gridColumns are the ALLOCATED grid size,
// not the populated size — a tab can report ~1,048,576 rows from stray
// formatting. Use describeSheet (or readRows) to learn the real used size.
// Input:  { spreadsheetId }
// Output: { spreadsheetId, title, tabs:[{ name, sheetId, gridRows, gridColumns }], tabCount } + envelope
async function listTabs({ spreadsheetId }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  if (!id) {
    return envelope({ spreadsheetId: "", title: "", tabs: [], tabCount: 0 }, [issue("missing_spreadsheet_id", "spreadsheetId is required (a sheet id or full URL).", "spreadsheetId")]);
  }

  const { data, error } = await sheetsGet(`/${encodeURIComponent(id)}`, {
    fields: "properties.title,sheets.properties(title,sheetId,gridProperties)",
  });
  if (error) {
    return envelope({ spreadsheetId: id, title: "", tabs: [], tabCount: 0 }, [error]);
  }

  const sheets = Array.isArray(data.sheets) ? data.sheets : [];
  const tabs = sheets.map((s) => {
    const p = (s && s.properties) || {};
    const g = p.gridProperties || {};
    return {
      name: p.title || "",
      sheetId: p.sheetId,
      gridRows: g.rowCount || 0,
      gridColumns: g.columnCount || 0,
    };
  });

  return envelope({
    spreadsheetId: id,
    title: (data.properties && data.properties.title) || "",
    tabs,
    tabCount: tabs.length,
  });
}

// describeSheet: inspect one tab — its real used dimensions and column headers.
// Reads the tab by name (so the returned grid is the populated range) and reads
// the header row. headerRow is 1-based (default 1).
// Input:  { spreadsheetId, tab, headerRow?, valueMode? }
// Output: { spreadsheetId, tab, headerRow, columns, columnCount, usedRows, usedColumns } + envelope
async function describeSheet({ spreadsheetId, tab, headerRow = 1, valueMode }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const tabName = trimStr(tab);
  const base = { spreadsheetId: id, tab: tabName, headerRow, columns: [], columnCount: 0, usedRows: 0, usedColumns: 0 };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);
  if (!tabName) return envelope(base, [issue("missing_tab", "tab is required.", "tab")]);

  const { data, error } = await sheetsGet(`/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName))}`, {
    valueRenderOption: valueRenderOption(valueMode),
    majorDimension: "ROWS",
  });
  if (error) return envelope(base, [error]);

  const grid = Array.isArray(data.values) ? data.values : [];
  const usedRows = grid.length;
  const usedColumns = grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);

  const headerIdx = Math.max(0, headerRow - 1);
  const { headers } = gridToRows(grid, headerIdx);
  const isStub = usedRows <= headerRow; // header but no data rows

  const warnings = [];
  if (isStub) warnings.push(issue("empty_tab", "This tab has a header but no data rows (it may be a placeholder).", "tab"));

  return envelope({
    spreadsheetId: id,
    tab: tabName,
    headerRow,
    columns: headers,
    columnCount: headers.length,
    usedRows,
    usedColumns,
  }, [], warnings);
}

// loadRows: load one tab (or an explicit A1 range within it) as header-keyed
// row objects. Use for product feeds, eval data, and flow inputs. For several
// tabs at once, use loadTabs (one batched call).
// Input:  { spreadsheetId, tab, range?, headerRow?, valueMode?, limit?, offset? }
//   range  optional A1 within the tab (e.g. "A1:D100"); omit to read the whole used range
//   limit  optional max rows to return (after offset); offset skips leading data rows
// Output: { spreadsheetId, tab, headers, rows, rowCount, totalRows, truncated } + envelope
async function loadRows({ spreadsheetId, tab, range, headerRow = 1, valueMode, limit, offset = 0 }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const tabName = trimStr(tab);
  const base = { spreadsheetId: id, tab: tabName, headers: [], rows: [], rowCount: 0, totalRows: 0, truncated: false };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);
  if (!tabName) return envelope(base, [issue("missing_tab", "tab is required.", "tab")]);

  const a1 = trimStr(range) || null;
  const { data, error } = await sheetsGet(`/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName, a1))}`, {
    valueRenderOption: valueRenderOption(valueMode),
    majorDimension: "ROWS",
  });
  if (error) return envelope(base, [error]);

  const grid = Array.isArray(data.values) ? data.values : [];
  const headerIdx = Math.max(0, headerRow - 1);
  const { headers, rows } = gridToRows(grid, headerIdx);

  const start = Math.max(0, Math.floor(offset) || 0);
  const hasLimit = typeof limit === "number" && limit >= 0;
  const sliced = hasLimit ? rows.slice(start, start + limit) : rows.slice(start);
  const truncated = hasLimit && start + limit < rows.length;

  const warnings = [];
  if (truncated) warnings.push(issue("truncated", `Returned ${sliced.length} of ${rows.length} rows (limit/offset applied). Page with offset to read more.`, null));

  return envelope({
    spreadsheetId: id,
    tab: tabName,
    headers,
    rows: sliced,
    rowCount: sliced.length,
    totalRows: rows.length,
    truncated,
  }, [], warnings);
}

// loadTabs: load several tabs in ONE batched call (values:batchGet). With no
// `tabs` given it loads ALL tabs in the spreadsheet (one extra metadata call to
// discover their names). Far cheaper than looping loadRows — one request for
// many tabs, which matters under the 10-call sandbox cap.
// Input:  { spreadsheetId, tabs?, headerRow?, valueMode? }
//   tabs   optional list of tab names; omit/empty = all tabs
// Output: { spreadsheetId, tabs:[{ tab, headers, rows, rowCount }], tabCount, totalRows } + envelope
async function loadTabs({ spreadsheetId, tabs, headerRow = 1, valueMode }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const base = { spreadsheetId: id, tabs: [], tabCount: 0, totalRows: 0 };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);

  const warnings = [];
  let names = Array.isArray(tabs) ? tabs.map(trimStr).filter(Boolean) : [];

  // No tabs given -> load them ALL: discover the names first (one metadata call).
  if (names.length === 0) {
    const meta = await sheetsGet(`/${encodeURIComponent(id)}`, { fields: "sheets.properties.title" });
    if (meta.error) return envelope(base, [meta.error]);
    const sheets = Array.isArray(meta.data.sheets) ? meta.data.sheets : [];
    names = sheets.map((s) => (s && s.properties && s.properties.title) || "").filter(Boolean);
    if (names.length === 0) return envelope(base, [issue("no_tabs", "The spreadsheet has no tabs.", null)]);
  }

  // One batched read for every tab (each range is just the tab name -> used range).
  const { data, error } = await sheetsGet(`/${encodeURIComponent(id)}/values:batchGet`, {
    ranges: names.map((n) => tabRange(n)),
    valueRenderOption: valueRenderOption(valueMode),
    majorDimension: "ROWS",
  });
  if (error) return envelope(base, [error]);

  const valueRanges = Array.isArray(data.valueRanges) ? data.valueRanges : [];
  const headerIdx = Math.max(0, headerRow - 1);
  let totalRows = 0;
  const out = names.map((name, i) => {
    const grid = (valueRanges[i] && Array.isArray(valueRanges[i].values)) ? valueRanges[i].values : [];
    const { headers, rows } = gridToRows(grid, headerIdx);
    totalRows += rows.length;
    return { tab: name, headers, rows, rowCount: rows.length };
  });

  // Soft heads-up for big workbooks — still returns everything.
  if (out.length > 20) {
    warnings.push(issue("many_tabs", `Loaded all ${out.length} tabs in one call; for very large workbooks consider passing a 'tabs' subset to keep the payload small.`, null));
  }

  return envelope({ spreadsheetId: id, tabs: out, tabCount: out.length, totalRows }, [], warnings);
}

// getColumnValues: read the values down a single named column. This is the
// reference-data workhorse (allowed values for an attribute, a dictionary, etc).
// Matches the column by trimmed header name (case-insensitive).
// Input:  { spreadsheetId, tab, column, headerRow?, valueMode?, distinct?, dropEmpty? }
// Output: { spreadsheetId, tab, column, values, count } + envelope
async function getColumnValues({ spreadsheetId, tab, column, headerRow = 1, valueMode, distinct = false, dropEmpty = true }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const tabName = trimStr(tab);
  const colName = trimStr(column);
  const base = { spreadsheetId: id, tab: tabName, column: colName, values: [], count: 0 };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);
  if (!tabName) return envelope(base, [issue("missing_tab", "tab is required.", "tab")]);
  if (!colName) return envelope(base, [issue("missing_column", "column is required.", "column")]);

  const { data, error } = await sheetsGet(`/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName))}`, {
    valueRenderOption: valueRenderOption(valueMode),
    majorDimension: "ROWS",
  });
  if (error) return envelope(base, [error]);

  const grid = Array.isArray(data.values) ? data.values : [];
  const headerIdx = Math.max(0, headerRow - 1);
  const { headers, rows } = gridToRows(grid, headerIdx);

  // Case-insensitive match on the trimmed header name.
  const target = colName.toLowerCase();
  const matchedHeader = headers.find((h) => h.toLowerCase() === target);
  if (!matchedHeader) {
    return envelope(base, [issue("column_not_found", `Column "${colName}" not found. Available columns: ${headers.join(", ") || "(none)"}.`, "column")]);
  }

  let values = rows.map((r) => r[matchedHeader]);
  if (dropEmpty) values = values.filter((v) => !(v === "" || v === null || v === undefined));
  if (distinct) {
    const seen = new Set();
    values = values.filter((v) => {
      const sig = String(v);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  return envelope({ spreadsheetId: id, tab: tabName, column: matchedHeader, values, count: values.length });
}

// lookupRows: find rows where matchColumn satisfies matchValue, optionally
// returning only selected columns. Powers key→value mapping lookups.
//   matchMode: "eq" (default) | "contains" | "startsWith"
//   caseInsensitive: default true
// Input:  { spreadsheetId, tab, matchColumn, matchValue, returnColumns?, matchMode?, caseInsensitive?, headerRow?, valueMode?, limit? }
// Output: { spreadsheetId, tab, matchColumn, matchValue, rows, rowCount } + envelope
async function lookupRows({ spreadsheetId, tab, matchColumn, matchValue, returnColumns, matchMode = "eq", caseInsensitive = true, headerRow = 1, valueMode, limit }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const tabName = trimStr(tab);
  const colName = trimStr(matchColumn);
  const base = { spreadsheetId: id, tab: tabName, matchColumn: colName, matchValue, rows: [], rowCount: 0 };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);
  if (!tabName) return envelope(base, [issue("missing_tab", "tab is required.", "tab")]);
  if (!colName) return envelope(base, [issue("missing_match_column", "matchColumn is required.", "matchColumn")]);
  if (matchValue === undefined || matchValue === null || matchValue === "") {
    return envelope(base, [issue("missing_match_value", "matchValue is required.", "matchValue")]);
  }

  const { data, error } = await sheetsGet(`/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName))}`, {
    valueRenderOption: valueRenderOption(valueMode),
    majorDimension: "ROWS",
  });
  if (error) return envelope(base, [error]);

  const grid = Array.isArray(data.values) ? data.values : [];
  const headerIdx = Math.max(0, headerRow - 1);
  const { headers, rows } = gridToRows(grid, headerIdx);

  const target = caseInsensitive ? colName.toLowerCase() : colName;
  const matchedHeader = headers.find((h) => (caseInsensitive ? h.toLowerCase() : h) === target);
  if (!matchedHeader) {
    return envelope(base, [issue("column_not_found", `matchColumn "${colName}" not found. Available columns: ${headers.join(", ") || "(none)"}.`, "matchColumn")]);
  }

  const norm = (v) => (caseInsensitive ? String(v).toLowerCase() : String(v));
  const needle = norm(matchValue);
  const test = (cell) => {
    const hay = norm(cell);
    switch (trimStr(matchMode).toLowerCase()) {
      case "contains": return hay.includes(needle);
      case "startswith": return hay.startsWith(needle);
      case "eq":
      default: return hay === needle;
    }
  };

  let matches = rows.filter((r) => test(r[matchedHeader]));

  // Project to selected columns if requested.
  const cols = Array.isArray(returnColumns) ? returnColumns.map(trimStr).filter(Boolean) : null;
  const warnings = [];
  if (cols && cols.length > 0) {
    // Resolve requested column names against actual (trimmed, case-insensitive) headers.
    const resolved = cols.map((c) => {
      const t = c.toLowerCase();
      return { requested: c, header: headers.find((h) => h.toLowerCase() === t) || null };
    });
    const missing = resolved.filter((r) => !r.header).map((r) => r.requested);
    if (missing.length) warnings.push(issue("unknown_return_columns", `Ignored unknown returnColumns: ${missing.join(", ")}.`, "returnColumns"));
    matches = matches.map((row) => {
      const out = {};
      resolved.forEach((r) => { if (r.header) out[r.header] = row[r.header]; });
      return out;
    });
  }

  const hasLimit = typeof limit === "number" && limit >= 0;
  const limited = hasLimit ? matches.slice(0, limit) : matches;
  if (hasLimit && matches.length > limit) {
    warnings.push(issue("truncated", `Returned ${limited.length} of ${matches.length} matches (limit applied).`, null));
  }

  return envelope({
    spreadsheetId: id,
    tab: tabName,
    matchColumn: matchedHeader,
    matchValue,
    rows: limited,
    rowCount: limited.length,
  }, [], warnings);
}

// ---------------------------------------------------------------------------
// Write actions (OAuth — see the auth notes at the top of this file)
// ---------------------------------------------------------------------------

// appendRows: add new rows to the bottom of a tab. The SAFE write — it never
// overwrites existing data. Row objects are aligned to the sheet's columns:
// if `columns` is given it sets the order; otherwise the tab's header row is
// read and used. Defaults to RAW input (values stored literally).
// Input:  { spreadsheetId, tab, rows, columns?, valueMode? }
// Output: { spreadsheetId, tab, appendedRows, updatedRange, columns } + envelope
async function appendRows({ spreadsheetId, tab, rows, columns, valueMode }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const tabName = trimStr(tab);
  const base = { spreadsheetId: id, tab: tabName, appendedRows: 0, updatedRange: "", columns: [] };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);
  if (!tabName) return envelope(base, [issue("missing_tab", "tab is required.", "tab")]);
  if (!Array.isArray(rows) || rows.length === 0) {
    return envelope(base, [issue("no_rows", "rows is required and must be a non-empty array of objects.", "rows")]);
  }

  const auth = await getAccessToken();
  if (auth.error) return envelope(base, [auth.error]);

  const warnings = [];
  let cols = Array.isArray(columns) && columns.length ? columns.map(trimStr).filter(Boolean) : null;

  // No explicit columns: align to the tab's header row (read with the same token).
  if (!cols) {
    const headerRes = await sheetsAuthed("GET", `/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName, "1:1"))}`, auth.token, { majorDimension: "ROWS" });
    if (headerRes.error) return envelope(base, [headerRes.error]);
    const headerGrid = Array.isArray(headerRes.data.values) ? headerRes.data.values : [];
    const header = (headerGrid[0] || []).map((h) => trimStr(typeof h === "string" ? h : (h === null || h === undefined ? "" : String(h))));
    if (header.length) cols = header;
  }

  // Still nothing (empty sheet, no columns given): fall back to the row keys.
  if (!cols) {
    const seen = new Set();
    cols = [];
    for (const r of rows) for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    warnings.push(issue("no_header", "No header row found and no columns given; used the row object's keys as the column order.", "tab"));
  }

  const values = rowsToValues(rows, cols);
  const writeRes = await sheetsAuthed(
    "POST",
    `/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName))}:append`,
    auth.token,
    { valueInputOption: valueInputOption(valueMode), insertDataOption: "INSERT_ROWS" },
    { values }
  );
  if (writeRes.error) return envelope(base, [writeRes.error]);

  const updates = (writeRes.data && writeRes.data.updates) || {};
  return envelope({
    spreadsheetId: id,
    tab: tabName,
    appendedRows: updates.updatedRows || 0,
    updatedRange: updates.updatedRange || "",
    columns: cols,
  }, [], warnings);
}

// updateRange: overwrite a specific A1 range in a tab. The DELIBERATE write —
// it replaces whatever is there (and will overwrite formulas), so it targets a
// caller-owned range. Provide either `values` (a 2D array) or `rows` + `columns`
// (which are turned into a 2D array). Defaults to RAW input.
// Input:  { spreadsheetId, tab, range, values?, rows?, columns?, valueMode? }
// Output: { spreadsheetId, tab, range, updatedCells, updatedRows, updatedRange } + envelope
async function updateRange({ spreadsheetId, tab, range, values, rows, columns, valueMode }) {
  const id = resolveSpreadsheetId(spreadsheetId);
  const tabName = trimStr(tab);
  const a1 = trimStr(range);
  const base = { spreadsheetId: id, tab: tabName, range: a1, updatedCells: 0, updatedRows: 0, updatedRange: "" };
  if (!id) return envelope(base, [issue("missing_spreadsheet_id", "spreadsheetId is required.", "spreadsheetId")]);
  if (!tabName) return envelope(base, [issue("missing_tab", "tab is required.", "tab")]);
  if (!a1) return envelope(base, [issue("missing_range", "range (an A1 range within the tab, e.g. A2:D10) is required.", "range")]);

  // Resolve the grid of values.
  let grid = null;
  if (Array.isArray(values) && values.length && Array.isArray(values[0])) {
    grid = values;
  } else if (Array.isArray(rows) && rows.length) {
    const cols = Array.isArray(columns) && columns.length ? columns.map(trimStr).filter(Boolean) : null;
    if (!cols) return envelope(base, [issue("missing_columns", "When writing rows, columns is required to fix the column order.", "columns")]);
    grid = rowsToValues(rows, cols);
  } else {
    return envelope(base, [issue("no_values", "Provide either values (a 2D array) or rows + columns.", "values")]);
  }

  const auth = await getAccessToken();
  if (auth.error) return envelope(base, [auth.error]);

  const writeRes = await sheetsAuthed(
    "PUT",
    `/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tabName, a1))}`,
    auth.token,
    { valueInputOption: valueInputOption(valueMode) },
    { values: grid }
  );
  if (writeRes.error) return envelope(base, [writeRes.error]);

  const d = writeRes.data || {};
  return envelope({
    spreadsheetId: id,
    tab: tabName,
    range: a1,
    updatedCells: d.updatedCells || 0,
    updatedRows: d.updatedRows || 0,
    updatedRange: d.updatedRange || "",
  });
}

export {
  listTabs,
  describeSheet,
  loadRows,
  loadTabs,
  getColumnValues,
  lookupRows,
  appendRows,
  updateRange,
};
