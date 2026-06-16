import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { listTabs, describeSheet, readRows, getColumnValues, lookupRows, appendRows, updateRange } from "../index.js";

// ---------------------------------------------------------------------------
// Harness: stub global.fetch and process.env so the pure logic (URL building,
// header/grid mapping, column lookup, envelope shaping, error mapping) is
// covered without any live network calls.
// ---------------------------------------------------------------------------

let fetchCalls;
let nextResponse; // function(url) -> { status, body } | a fixed { status, body }

function textResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function installFetch() {
  fetchCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url, opts });
    const r = typeof nextResponse === "function" ? nextResponse(url, opts) : nextResponse;
    return textResponse(r.status, r.body);
  };
}

beforeEach(() => {
  installFetch();
  nextResponse = { status: 200, body: {} };
  process.env.GOOGLE_API_KEY = "TEST_KEY";
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
});

// A small attribute-style grid: header row + value rows, with a deliberately
// trailing-spaced header to exercise trimming.
const ATTR_GRID = {
  values: [
    ["Product Type", "Neck Shape ", "Sleeve Length"],
    ["Dress", "Crew Neck", "Long Sleeve"],
    ["Dress", "V-Neck", "Short Sleeve"],
    ["Top", "Crew Neck", ""],
  ],
};

// ---------------------------------------------------------------------------
// missing api key / missing inputs (no network)
// ---------------------------------------------------------------------------

test("missing API key surfaces as an error in the envelope, not a throw", async () => {
  delete process.env.GOOGLE_API_KEY;
  const res = await readRows({ spreadsheetId: "abc", tab: "Sheet1" });
  assert.equal(res.ok, false);
  assert.equal(res.errorCount, 1);
  assert.equal(res.errors[0].code, "missing_api_key");
  assert.equal(fetchCalls.length, 0);
});

test("missing spreadsheetId is an error before any call", async () => {
  const res = await listTabs({ spreadsheetId: "" });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "missing_spreadsheet_id");
  assert.equal(fetchCalls.length, 0);
});

test("readRows requires a tab", async () => {
  const res = await readRows({ spreadsheetId: "abc", tab: "" });
  assert.equal(res.errors[0].code, "missing_tab");
});

// ---------------------------------------------------------------------------
// URL building: id extraction from URL + api key always appended
// ---------------------------------------------------------------------------

test("accepts a full sheet URL and extracts the id; appends the API key", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  await readRows({
    spreadsheetId: "https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=0",
    tab: "WOMENS DRESSES",
  });
  const url = fetchCalls[0].url;
  assert.ok(url.includes("/spreadsheets/1AbC-dEf_123/values/"), url);
  assert.ok(url.includes("key=TEST_KEY"), url);
  assert.ok(url.includes("valueRenderOption=FORMATTED_VALUE"), url);
});

test("valueMode maps to the right valueRenderOption", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  await readRows({ spreadsheetId: "abc", tab: "S", valueMode: "unformatted" });
  assert.ok(fetchCalls[0].url.includes("valueRenderOption=UNFORMATTED_VALUE"));
});

// ---------------------------------------------------------------------------
// listTabs
// ---------------------------------------------------------------------------

test("listTabs maps tab metadata", async () => {
  nextResponse = {
    status: 200,
    body: {
      properties: { title: "Attributes MASTER" },
      sheets: [
        { properties: { title: "WOMENS DRESSES", sheetId: 0, gridProperties: { rowCount: 1000, columnCount: 20 } } },
        { properties: { title: "MENS TOPS", sheetId: 1, gridProperties: { rowCount: 1048576, columnCount: 18 } } },
      ],
    },
  };
  const res = await listTabs({ spreadsheetId: "abc" });
  assert.equal(res.ok, true);
  assert.equal(res.title, "Attributes MASTER");
  assert.equal(res.tabCount, 2);
  assert.deepEqual(res.tabs[0], { name: "WOMENS DRESSES", sheetId: 0, gridRows: 1000, gridColumns: 20 });
  // The inflated grid size is reported verbatim (it's allocated, not populated).
  assert.equal(res.tabs[1].gridRows, 1048576);
});

// ---------------------------------------------------------------------------
// readRows: grid -> header-keyed rows, trimming, padding, blank-row skipping
// ---------------------------------------------------------------------------

test("readRows builds header-keyed rows, trims headers, pads short rows, skips blanks", async () => {
  nextResponse = {
    status: 200,
    body: {
      values: [
        ["Product Type", "Neck Shape ", "Sleeve Length"],
        ["Dress", "Crew Neck", "Long Sleeve"],
        [], // blank row -> skipped
        ["Top", "V-Neck"], // short row -> Sleeve Length padded to ""
      ],
    },
  };
  const res = await readRows({ spreadsheetId: "abc", tab: "S" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.headers, ["Product Type", "Neck Shape", "Sleeve Length"]);
  assert.equal(res.rowCount, 2);
  assert.deepEqual(res.rows[0], { "Product Type": "Dress", "Neck Shape": "Crew Neck", "Sleeve Length": "Long Sleeve" });
  assert.deepEqual(res.rows[1], { "Product Type": "Top", "Neck Shape": "V-Neck", "Sleeve Length": "" });
});

test("readRows honours limit/offset and flags truncation", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await readRows({ spreadsheetId: "abc", tab: "S", limit: 1, offset: 1 });
  assert.equal(res.totalRows, 3);
  assert.equal(res.rowCount, 1);
  assert.equal(res.rows[0]["Neck Shape"], "V-Neck");
  assert.equal(res.truncated, true);
  assert.equal(res.warningCount, 1);
});

test("readRows with explicit A1 range puts the range in the request", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  await readRows({ spreadsheetId: "abc", tab: "WOMENS DRESSES", range: "A1:C10" });
  const url = decodeURIComponent(fetchCalls[0].url);
  assert.ok(url.includes("'WOMENS DRESSES'!A1:C10"), url);
});

test("readRows supports a non-default header row", async () => {
  nextResponse = {
    status: 200,
    body: {
      values: [
        ["Synonyms - Womens"], // title row
        ["Actual", "Alt1", "Alt2"], // real header on row 2
        ["T-Shirt", "Tee", "Tshirt"],
      ],
    },
  };
  const res = await readRows({ spreadsheetId: "abc", tab: "Sheet1", headerRow: 2 });
  assert.deepEqual(res.headers, ["Actual", "Alt1", "Alt2"]);
  assert.equal(res.rowCount, 1);
  assert.deepEqual(res.rows[0], { Actual: "T-Shirt", Alt1: "Tee", Alt2: "Tshirt" });
});

// ---------------------------------------------------------------------------
// describeSheet
// ---------------------------------------------------------------------------

test("describeSheet reports used size and columns", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await describeSheet({ spreadsheetId: "abc", tab: "S" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.columns, ["Product Type", "Neck Shape", "Sleeve Length"]);
  assert.equal(res.usedRows, 4);
  assert.equal(res.usedColumns, 3);
});

test("describeSheet warns on a header-only stub tab", async () => {
  nextResponse = { status: 200, body: { values: [["Product Type"]] } };
  const res = await describeSheet({ spreadsheetId: "abc", tab: "JEWELLERY" });
  assert.equal(res.ok, true);
  assert.equal(res.warningCount, 1);
  assert.equal(res.warnings[0].code, "empty_tab");
});

// ---------------------------------------------------------------------------
// getColumnValues
// ---------------------------------------------------------------------------

test("getColumnValues reads a column by trimmed, case-insensitive name", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  // "neck shape" matches the trailing-spaced "Neck Shape " header.
  const res = await getColumnValues({ spreadsheetId: "abc", tab: "S", column: "neck shape" });
  assert.equal(res.ok, true);
  assert.equal(res.column, "Neck Shape");
  assert.deepEqual(res.values, ["Crew Neck", "V-Neck", "Crew Neck"]);
});

test("getColumnValues distinct drops duplicates; dropEmpty drops blanks", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await getColumnValues({ spreadsheetId: "abc", tab: "S", column: "Neck Shape", distinct: true });
  assert.deepEqual(res.values, ["Crew Neck", "V-Neck"]);

  nextResponse = { status: 200, body: ATTR_GRID };
  const withEmpty = await getColumnValues({ spreadsheetId: "abc", tab: "S", column: "Sleeve Length", dropEmpty: false });
  assert.deepEqual(withEmpty.values, ["Long Sleeve", "Short Sleeve", ""]);
});

test("getColumnValues errors with available columns when not found", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await getColumnValues({ spreadsheetId: "abc", tab: "S", column: "Colour" });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "column_not_found");
  assert.ok(res.errors[0].message.includes("Product Type"));
});

// ---------------------------------------------------------------------------
// lookupRows
// ---------------------------------------------------------------------------

test("lookupRows returns whole matching rows by default (eq)", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await lookupRows({ spreadsheetId: "abc", tab: "S", matchColumn: "Product Type", matchValue: "Dress" });
  assert.equal(res.ok, true);
  assert.equal(res.rowCount, 2);
  assert.equal(res.rows[0]["Neck Shape"], "Crew Neck");
});

test("lookupRows projects to returnColumns and warns on unknown ones", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await lookupRows({
    spreadsheetId: "abc",
    tab: "S",
    matchColumn: "Product Type",
    matchValue: "Dress",
    returnColumns: ["Neck Shape", "Nonexistent"],
  });
  assert.equal(res.rowCount, 2);
  assert.deepEqual(Object.keys(res.rows[0]), ["Neck Shape"]);
  assert.equal(res.warningCount, 1);
  assert.equal(res.warnings[0].code, "unknown_return_columns");
});

test("lookupRows contains mode + case sensitivity", async () => {
  nextResponse = { status: 200, body: ATTR_GRID };
  const res = await lookupRows({ spreadsheetId: "abc", tab: "S", matchColumn: "Neck Shape", matchValue: "neck", matchMode: "contains" });
  assert.equal(res.rowCount, 3); // all three contain "neck" case-insensitively
});

test("lookupRows requires a match value", async () => {
  const res = await lookupRows({ spreadsheetId: "abc", tab: "S", matchColumn: "Product Type", matchValue: "" });
  assert.equal(res.errors[0].code, "missing_match_value");
});

// ---------------------------------------------------------------------------
// HTTP error mapping
// ---------------------------------------------------------------------------

test("403 maps to a clear access_denied message", async () => {
  nextResponse = { status: 403, body: { error: { message: "forbidden" } } };
  const res = await readRows({ spreadsheetId: "abc", tab: "S" });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "access_denied");
  assert.ok(res.errors[0].message.includes("anyone with the link"));
});

test("404 maps to spreadsheet_not_found pointing at spreadsheetId", async () => {
  nextResponse = { status: 404, body: {} };
  const res = await listTabs({ spreadsheetId: "abc" });
  assert.equal(res.errors[0].code, "spreadsheet_not_found");
  assert.equal(res.errors[0].field, "spreadsheetId");
});

test("429 maps to rate_limited", async () => {
  nextResponse = { status: 429, body: {} };
  const res = await getColumnValues({ spreadsheetId: "abc", tab: "S", column: "Product Type" });
  assert.equal(res.errors[0].code, "rate_limited");
});

// ---------------------------------------------------------------------------
// Write actions: appendRows / updateRange
// ---------------------------------------------------------------------------

// Helper to read the JSON body a write request sent.
function bodyOf(call) {
  return JSON.parse(call.opts.body);
}

test("appendRows without credentials surfaces missing_credentials, no network", async () => {
  // Only the read API key is set; writing needs OAuth.
  const res = await appendRows({ spreadsheetId: "abc", tab: "Products", rows: [{ SKU: "X" }] });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "missing_credentials");
  assert.equal(fetchCalls.length, 0);
});

test("appendRows requires a non-empty rows array", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  const res = await appendRows({ spreadsheetId: "abc", tab: "Products", rows: [] });
  assert.equal(res.errors[0].code, "no_rows");
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("appendRows reads the header, aligns columns, appends in header order (RAW default)", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  nextResponse = (url, opts) => {
    if (opts.method === "POST" && url.includes(":append")) {
      return { status: 200, body: { updates: { updatedRange: "Products!A5:C5", updatedRows: 1 } } };
    }
    // header read (GET ...!1:1)
    return { status: 200, body: { values: [["SKU", "Title", "Price"]] } };
  };
  const res = await appendRows({
    spreadsheetId: "abc",
    tab: "Products",
    rows: [{ Title: "Tee", SKU: "AF-1", Price: 18 }], // deliberately out of order, no all-columns
  });
  assert.equal(res.ok, true);
  assert.equal(res.appendedRows, 1);
  assert.deepEqual(res.columns, ["SKU", "Title", "Price"]);

  // Two calls: header GET then append POST.
  assert.equal(fetchCalls.length, 2);
  const appendCall = fetchCalls.find((c) => c.opts.method === "POST");
  assert.ok(appendCall.url.includes("valueInputOption=RAW"), appendCall.url);
  assert.ok(appendCall.url.includes("insertDataOption=INSERT_ROWS"));
  assert.ok(appendCall.opts.headers.Authorization === "Bearer T");
  // Values aligned to header order, missing -> "".
  assert.deepEqual(bodyOf(appendCall), { values: [["AF-1", "Tee", 18]] });
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("appendRows with explicit columns skips the header read (single call)", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  nextResponse = { status: 200, body: { updates: { updatedRange: "Products!A2:B2", updatedRows: 1 } } };
  const res = await appendRows({
    spreadsheetId: "abc",
    tab: "Products",
    columns: ["SKU", "Title"],
    rows: [{ SKU: "AF-2", Title: "Shirt", Extra: "ignored" }],
    valueMode: "user",
  });
  assert.equal(res.ok, true);
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.ok(call.url.includes(":append"));
  assert.ok(call.url.includes("valueInputOption=USER_ENTERED"), call.url);
  assert.deepEqual(bodyOf(call), { values: [["AF-2", "Shirt"]] });
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("appendRows obtains a token via the refresh-token flow when no access token", async () => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh";
  nextResponse = (url, opts) => {
    if (url.includes("oauth2.googleapis.com/token")) return { status: 200, body: { access_token: "FRESH" } };
    if (opts.method === "POST" && url.includes(":append")) return { status: 200, body: { updates: { updatedRows: 1 } } };
    return { status: 200, body: { values: [["SKU"]] } };
  };
  const res = await appendRows({ spreadsheetId: "abc", tab: "Products", rows: [{ SKU: "AF-3" }] });
  assert.equal(res.ok, true);
  // token exchange happened, and the append used the fresh token.
  assert.ok(fetchCalls.some((c) => c.url.includes("oauth2.googleapis.com/token")));
  const appendCall = fetchCalls.find((c) => c.opts.method === "POST" && c.url.includes(":append"));
  assert.equal(appendCall.opts.headers.Authorization, "Bearer FRESH");
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
});

test("write 403 maps to access_denied with the OAuth/edit-access message", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  nextResponse = (url, opts) => {
    if (opts.method === "POST") return { status: 403, body: {} };
    return { status: 200, body: { values: [["SKU"]] } };
  };
  const res = await appendRows({ spreadsheetId: "abc", tab: "Products", columns: ["SKU"], rows: [{ SKU: "X" }] });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "access_denied");
  assert.ok(res.errors[0].message.includes("edit access"));
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("updateRange writes a 2D values array to a PUT at the range", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  nextResponse = { status: 200, body: { updatedCells: 4, updatedRows: 2, updatedRange: "Sheet1!A2:B3" } };
  const res = await updateRange({
    spreadsheetId: "abc",
    tab: "Sheet1",
    range: "A2:B3",
    values: [["a", "b"], ["c", "d"]],
  });
  assert.equal(res.ok, true);
  assert.equal(res.updatedCells, 4);
  const call = fetchCalls[0];
  assert.equal(call.opts.method, "PUT");
  assert.ok(decodeURIComponent(call.url).includes("'Sheet1'!A2:B3"), call.url);
  assert.ok(call.url.includes("valueInputOption=RAW"));
  assert.deepEqual(bodyOf(call), { values: [["a", "b"], ["c", "d"]] });
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("updateRange builds values from rows + columns", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  nextResponse = { status: 200, body: { updatedCells: 2 } };
  const res = await updateRange({
    spreadsheetId: "abc",
    tab: "Sheet1",
    range: "A2:B2",
    rows: [{ SKU: "AF-9", Title: "Hat" }],
    columns: ["SKU", "Title"],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(bodyOf(fetchCalls[0]), { values: [["AF-9", "Hat"]] });
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("updateRange requires a range and some values", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  const noRange = await updateRange({ spreadsheetId: "abc", tab: "Sheet1", values: [["a"]] });
  assert.equal(noRange.errors[0].code, "missing_range");
  const noValues = await updateRange({ spreadsheetId: "abc", tab: "Sheet1", range: "A1" });
  assert.equal(noValues.errors[0].code, "no_values");
  assert.equal(fetchCalls.length, 0);
  delete process.env.GOOGLE_ACCESS_TOKEN;
});

test("updateRange writing rows without columns errors", async () => {
  process.env.GOOGLE_ACCESS_TOKEN = "T";
  const res = await updateRange({ spreadsheetId: "abc", tab: "Sheet1", range: "A1:B1", rows: [{ a: 1 }] });
  assert.equal(res.errors[0].code, "missing_columns");
  delete process.env.GOOGLE_ACCESS_TOKEN;
});
