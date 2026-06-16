// Amplience Workforce extension — Google Sheets Reader (read-only, v1a)
//
// Reads data OUT of a Google Sheet so it can be used inside a Workforce flow or
// as a tool by an agent. Read-only on purpose: a sheet that is shared as
// "anyone with the link can view" can be read with just an API key — no service
// account, no OAuth, no per-user login. Writing back to a sheet would require a
// service account; that is intentionally OUT of scope for this version.
//
// USE CASES this serves (all read):
//   - reference data ....... a product taxonomy, a dictionary of allowed words,
//                            a set of rules (the column-lookup workhorse)
//   - flow inputs .......... rows of data fed into a flow
//   - eval data ............ a table of test cases for a flow or action
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
// SANDBOX: each action makes at most ONE HTTP call to Google — well under the
// 10-own-HTTP-calls cap. Do not loop these over a large catalogue inside one
// execution; read once and process in memory, or page with limit/offset.
//
// AUTH: a Google API key (env GOOGLE_API_KEY), used as ?key=... — this only
// works against publicly-viewable sheets, which is exactly the v1a scope.
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

// Map an HTTP failure to a standard issue. 403 is the common "sheet isn't
// public / key not enabled" case, which deserves a clear, actionable message.
function httpErrorIssue(status, bodyText) {
  if (status === 403) {
    return issue(
      "access_denied",
      "Google denied access (HTTP 403). The sheet must be shared as \"anyone with the link can view\", and the Google Sheets API must be enabled for the API key.",
      null
    );
  }
  if (status === 401) {
    return issue("auth_failed", "Google rejected the API key (HTTP 401). Check GOOGLE_API_KEY.", null);
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
  const qs = new URLSearchParams({ ...params, key });
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

// readRows: read a tab (or an explicit A1 range within it) as header-keyed row
// objects. Use for product feeds, eval data, and flow inputs.
// Input:  { spreadsheetId, tab, range?, headerRow?, valueMode?, limit?, offset? }
//   range  optional A1 within the tab (e.g. "A1:D100"); omit to read the whole used range
//   limit  optional max rows to return (after offset); offset skips leading data rows
// Output: { spreadsheetId, tab, headers, rows, rowCount, totalRows, truncated } + envelope
async function readRows({ spreadsheetId, tab, range, headerRow = 1, valueMode, limit, offset = 0 }) {
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

export {
  listTabs,
  describeSheet,
  readRows,
  getColumnValues,
  lookupRows,
};
