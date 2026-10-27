// ---------------------------------------------------------------------------
// GYPSY JavaScript helpers around the WebAssembly module (gypsy.js)
//
//   GypsyAPI.parseDelimited(text, opts)      -> rows (arrays of strings)
//   GypsyAPI.detectDelimiter(text)           -> ",", "\t", ";", "|" or " "
//   GypsyAPI.guessMapping(names)             -> { field: column index or -1 }
//   GypsyAPI.inputFromRows(rows, mapping)    -> { input, warnings }
//   GypsyAPI.readInput(text)                 -> { input, warnings }  (CSV with a header)
//   GypsyAPI.run(module, input, options)     -> { standLabels, rows, init, warnings }
//   GypsyAPI.toCSV(table, standLabels)       -> CSV text
//
// Input fields are named as the arguments of GYPSY_Sim() in R: stand,
// stand_age, spp, n, si, age, ht, ps, ba (one row per stand and species).
//
// A plain script (not an ES module) so the page also works when opened
// straight from disk; also loads in Node with require().
// ---------------------------------------------------------------------------

(function (root) {
  "use strict";

  const FIELDS = [
    { key: "stand",     label: "Stand",           required: true,  numeric: false },
    { key: "stand_age", label: "Stand age",       required: true,  numeric: true  },
    { key: "spp",       label: "Species",         required: true,  numeric: false },
    { key: "n",         label: "Density",         required: true,  numeric: true  },
    { key: "si",        label: "Site index",      required: false, numeric: true  },
    { key: "age",       label: "Age",             required: false, numeric: true  },
    { key: "ht",        label: "Top height",      required: false, numeric: true  },
    { key: "ps",        label: "Percent stocking", required: false, numeric: true },
    { key: "ba",        label: "Basal area",      required: false, numeric: true  },
  ];
  const SPECIES = ["AW", "SB", "SW", "PL"];

  // Other column names recognised for each field (compared lower case,
  // letters and digits only)
  const ALIASES = {
    stand:     ["stand", "standid", "stand_id", "id", "plot", "plotid"],
    stand_age: ["stand_age", "standage"],
    spp:       ["spp", "species", "sp", "spec"],
    n:         ["n", "density", "stems", "sph", "tph", "stemsha", "nha"],
    si:        ["si", "siteindex", "site_index"],
    age:       ["age", "totage", "totalage", "tage"],
    ht:        ["ht", "topht", "toph", "topheight", "height"],
    ps:        ["ps", "percentstocking", "stocking"],
    ba:        ["ba", "basalarea", "baha"],
  };
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  // ---- Delimited text ----------------------------------------------------------

  // Most likely delimiter: the candidate found the same (non-zero) number of
  // times on most of the first lines; whitespace if none is
  function detectDelimiter(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim() !== "").slice(0, 20);
    let best = " ", bestScore = 0;
    for (const d of [",", "\t", ";", "|"]) {
      const counts = lines.map(l => l.split(d).length - 1);
      const common = mode(counts);
      if (common === 0) continue;
      const score = counts.filter(c => c === common).length * 100 + common;
      if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
  }

  function mode(xs) {
    const tally = new Map();
    for (const x of xs) tally.set(x, (tally.get(x) || 0) + 1);
    let m = 0, mc = -1;
    for (const [x, c] of tally) if (c > mc || (c === mc && x > m)) { m = x; mc = c; }
    return m;
  }

  // RFC 4180 style for a single-character delimiter (quoted fields, doubled
  // quotes, CRLF or LF); delimiter " " splits on runs of spaces and tabs
  function parseDelimited(text, { delimiter } = {}) {
    text = text.replace(/^﻿/, "");
    const d = delimiter || detectDelimiter(text);
    if (d === " ") {
      return text.split(/\r?\n/).filter(l => l.trim() !== "").map(l => l.trim().split(/\s+/));
    }
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === d) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0].trim() !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    return rows;
  }

  // Kept for scripts that read a CSV with a header row
  function parseCSV(text) {
    const rows = parseDelimited(text, { delimiter: "," });
    const header = (rows.shift() || []).map(h => h.trim());
    return { header, rows };
  }

  // ---- Columns -> model input ----------------------------------------------------

  // Field -> column index from column names (-1 when not found); each column
  // is used at most once
  function guessMapping(names) {
    const mapping = {}, used = new Set();
    const normed = names.map(norm);
    for (const f of FIELDS) {
      mapping[f.key] = -1;
      for (const a of ALIASES[f.key]) {
        const j = normed.findIndex((n, k) => n === norm(a) && !used.has(k));
        if (j >= 0) { mapping[f.key] = j; used.add(j); break; }
      }
    }
    return mapping;
  }

  // Blank, "." (SAS) and "NA" are missing
  function toNumber(x) {
    const s = String(x ?? "").trim();
    if (s === "" || s === "." || s.toUpperCase() === "NA") return NaN;
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
  }

  // Data rows (no header) + field -> column mapping -> model input. Missing
  // optional fields are treated as missing values, with a warning; missing
  // required fields are an error.
  function inputFromRows(rows, mapping) {
    const missingReq = FIELDS.filter(f => f.required && !(mapping[f.key] >= 0)).map(f => f.key);
    if (missingReq.length) throw new Error("Required column(s) not assigned: " + missingReq.join(", "));
    const missingOpt = FIELDS.filter(f => !f.required && !(mapping[f.key] >= 0)).map(f => f.key);
    const warnings = missingOpt.length
      ? ["Column(s) not assigned, treated as missing: " + missingOpt.join(", ")]
      : [];

    const col = (key, f) => rows.map(r => (mapping[key] >= 0 ? f(r[mapping[key]]) : NaN));
    const input = {
      stand: col("stand", x => String(x ?? "").trim()),
      spp:   col("spp",   x => String(x ?? "").trim().toUpperCase()),
    };
    for (const f of FIELDS) if (f.numeric) input[f.key] = col(f.key, toNumber);
    return { input, warnings };
  }

  // CSV text with a header row -> model input
  function readInput(text) {
    const rows = parseDelimited(text);
    const header = (rows.shift() || []).map(h => h.trim());
    const lower = header.map(h => h.toLowerCase());
    const mapping = {};
    for (const f of FIELDS) mapping[f.key] = lower.indexOf(f.key);
    return inputFromRows(rows, mapping);
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
  // them back to the caller's row numbers ("Row 3: ..." and "row(s) 3, 4")
  function remapRows(msg, rowIndex, rowLabels) {
    const map = n => String(rowLabels ? rowLabels[rowIndex[n - 1]] : rowIndex[n - 1] + 1);
    return msg
      .replace(/\bRow (\d+)/g, (_, n) => "Row " + map(Number(n)))
      .replace(/row\(s\)(:?) (\d+(?:, \d+)*)/g,
               (_, colon, list) => "row(s)" + colon + " " +
                 list.split(",").map(s => map(Number(s.trim()))).join(", "));
  }

  // input: model input columns (stand IDs as strings)
  // options: GYPSY options (see src/gypsy_wasm.cpp), plus
  //   chunkSize  stands per WebAssembly call (default 1000); keeps memory
  //              use bounded for large inputs
  //   onChunk    if given, called with each chunk's result instead of
  //              keeping all rows (for streaming large runs to a file)
  //   onProgress called with (standsDone, standsTotal)
  //   rowLabels  row numbers to use in messages, one per input row
  //              (default 1, 2, 3, ...)
  function run(module, input, options = {}) {
    const r = runner(module, input, options);
    while (r.step()) { /* next chunk */ }
    return r.result;
  }

  // As run(), but returns a promise and lets the browser update the page
  // between chunks (for progress messages on large inputs)
  async function runAsync(module, input, options = {}) {
    const r = runner(module, input, options);
    while (r.step()) await new Promise(res => setTimeout(res, 0));
    return r.result;
  }

  // One chunk of stands per step(); step() returns false when done
  function runner(module, input, options) {
    const { chunkSize = 1000, onChunk, onProgress, rowLabels, ...simOptions } = options;
    const standLabels = sortStands(input.stand);
    const code = new Map(standLabels.map((s, i) => [s, i]));

    // Row indices by stand, in input order
    const rowsByStand = standLabels.map(() => []);
    input.stand.forEach((s, i) => rowsByStand[code.get(s)].push(i));

    const combined = { standLabels, rows: null, init: null, warnings: [] };
    let start = 0;
    function step() {
      if (start >= standLabels.length) return false;
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

      if (res.error) throw new Error(remapRows(res.error, rowIndex, rowLabels));
      res.warnings = res.warnings.map(w => remapRows(w, rowIndex, rowLabels));

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
      start = end;
      return start < standLabels.length;
    }
    return { step, result: combined };
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

  const api = { FIELDS, SPECIES, parseDelimited, detectDelimiter, parseCSV, guessMapping,
                toNumber, inputFromRows, readInput, run, runAsync, toCSV, sortStands };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GypsyAPI = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
