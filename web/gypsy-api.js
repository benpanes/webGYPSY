// ---------------------------------------------------------------------------
// GYPSY JavaScript helpers around the WebAssembly module (gypsy.js)
//
//   GypsyAPI.parseCSV(text)              -> { header, rows }
//   GypsyAPI.readInput(text)             -> { input, warnings }
//   GypsyAPI.run(module, input, options) -> { standLabels, rows, init, warnings }
//   GypsyAPI.toCSV(table, standLabels)   -> CSV text
//
// Input columns are named as the arguments of GYPSY_Sim() in R: stand,
// stand_age, spp, n, si, age, ht, ps, ba (one row per stand and species).
//
// A plain script (not an ES module) so the page also works when opened
// straight from disk; also loads in Node with require().
// ---------------------------------------------------------------------------

(function (root) {
  "use strict";

  const REQUIRED = ["stand", "stand_age", "spp", "n"];
  const OPTIONAL = ["si", "age", "ht", "ps", "ba"];

  // ---- CSV ------------------------------------------------------------------

  // RFC 4180 style: quoted fields, doubled quotes, CRLF or LF line ends
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    const header = (rows.shift() || []).map(h => h.trim());
    return { header, rows };
  }

  // Blank, "." (SAS) and "NA" are missing
  function toNumber(x) {
    const s = String(x).trim();
    if (s === "" || s === "." || s.toUpperCase() === "NA") return NaN;
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
  }

  // CSV text -> column arrays. Missing optional columns are treated as
  // missing values, with a warning; missing required columns are an error.
  function readInput(text) {
    const { header, rows } = parseCSV(text);
    const idx = {};
    header.forEach((h, i) => { idx[h.toLowerCase()] = i; });

    const missingReq = REQUIRED.filter(c => !(c in idx));
    if (missingReq.length) throw new Error("Required column(s) not found: " + missingReq.join(", "));
    const missingOpt = OPTIONAL.filter(c => !(c in idx));
    const warnings = missingOpt.length
      ? ["Column(s) not found, treated as missing: " + missingOpt.join(", ")]
      : [];

    const col = (name, f) => rows.map(r => (name in idx ? f(r[idx[name]] ?? "") : NaN));
    const input = {
      stand:     col("stand", x => String(x).trim()),
      stand_age: col("stand_age", toNumber),
      spp:       col("spp", x => String(x).trim().toUpperCase()),
    };
    for (const c of ["n", ...OPTIONAL]) input[c] = col(c, toNumber);
    return { input, warnings };
  }

  // ---- Running the model ---------------------------------------------------

  // Stands are projected in sorted order: numerically if every ID is a
  // number, otherwise by character code (as R's radix sort does)
  function sortStands(ids) {
    const uniq = [...new Set(ids)];
    const numeric = uniq.every(s => s !== "" && Number.isFinite(Number(s)));
    return numeric ? uniq.sort((a, b) => Number(a) - Number(b))
                   : uniq.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // Core messages give 1-based row numbers within the rows passed in; map
  // them back to the caller's rows ("Row 3: ..." and "row(s) 3, 4")
  function remapRows(msg, rowIndex) {
    const map = n => String(rowIndex[n - 1] + 1);
    return msg
      .replace(/\bRow (\d+)/g, (_, n) => "Row " + map(Number(n)))
      .replace(/row\(s\)(:?) (\d+(?:, \d+)*)/g,
               (_, colon, list) => "row(s)" + colon + " " +
                 list.split(",").map(s => map(Number(s.trim()))).join(", "));
  }

  // input: columns as returned by readInput (stand IDs as strings)
  // options: GYPSY options (see src/gypsy_wasm.cpp), plus
  //   chunkSize  stands per WebAssembly call (default 1000); keeps memory
  //              use bounded for large inputs
  //   onChunk    if given, called with each chunk's result instead of
  //              keeping all rows (for streaming large runs to a file)
  //   onProgress called with (standsDone, standsTotal)
  function run(module, input, options = {}) {
    const { chunkSize = 1000, onChunk, onProgress, ...simOptions } = options;
    const standLabels = sortStands(input.stand);
    const code = new Map(standLabels.map((s, i) => [s, i]));

    // Row indices by stand, in input order
    const rowsByStand = standLabels.map(() => []);
    input.stand.forEach((s, i) => rowsByStand[code.get(s)].push(i));

    const combined = { standLabels, rows: null, init: null, warnings: [] };
    for (let start = 0; start < standLabels.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, standLabels.length);
      const rowIndex = rowsByStand.slice(start, end).flat().sort((a, b) => a - b);
      const pick = arr => rowIndex.map(i => arr[i]);

      const res = module.runSim({
        stand:      rowIndex.map(i => code.get(input.stand[i]) - start),
        standLabel: standLabels.slice(start, end),
        standAge:   pick(input.stand_age),
        spp:        pick(input.spp),
        n: pick(input.n), si: pick(input.si), age: pick(input.age),
        ht: pick(input.ht), ps: pick(input.ps), ba: pick(input.ba),
      }, simOptions);

      if (res.error) throw new Error(remapRows(res.error, rowIndex));
      res.warnings = res.warnings.map(w => remapRows(w, rowIndex));

      // stand_idx back to the position in standLabels (1-based)
      const k = res.rows.names.indexOf("stand_idx");
      if (start > 0) res.rows.columns[k] = res.rows.columns[k].map(v => v + start);

      if (onChunk) onChunk(res, standLabels);
      else {
        combined.rows = append(combined.rows, res.rows);
        combined.init = append(combined.init, res.init);
      }
      combined.warnings.push(...res.warnings);
      if (onProgress) onProgress(end, standLabels.length);
    }
    return combined;
  }

  function append(a, b) {
    if (!a) return b;
    return {
      names: a.names,
      columns: a.columns.map((col, k) => {
        const out = new Float64Array(col.length + b.columns[k].length);
        out.set(col); out.set(b.columns[k], col.length);
        return out;
      }),
    };
  }

  // ---- Output --------------------------------------------------------------

  // Table -> CSV. stand_idx is written as a "stand" column of labels;
  // init tables (one row per stand) get the labels in order.
  function toCSV(table, standLabels, { header = true } = {}) {
    const k = table.names.indexOf("stand_idx");
    const names = table.names.filter((_, j) => j !== k);
    const cols  = table.columns.filter((_, j) => j !== k);
    const n = table.columns[0] ? table.columns[0].length : 0;
    const quote = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const fmt = v => (Number.isNaN(v) ? "" : String(v));

    const lines = header ? [["stand", ...names].join(",")] : [];
    for (let r = 0; r < n; r++) {
      const label = k >= 0 ? standLabels[table.columns[k][r] - 1] : standLabels[r];
      lines.push([quote(label), ...cols.map(c => fmt(c[r]))].join(","));
    }
    return lines.join("\n") + "\n";
  }

  const api = { parseCSV, readInput, run, toCSV, sortStands };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GypsyAPI = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
