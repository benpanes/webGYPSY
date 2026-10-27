// Compare the WebAssembly build with the R package
//
// Runs the rGYPSY example stands through web/gypsy.js and compares every
// column with the R reference written by test/make_reference.R. Stands are
// run in chunks of 2 to also check that chunking doesn't change results.
//
//   node test/compare_r.js
//
// Exits with status 1 if any column differs by more than the tolerance or
// has a different missing-value pattern.

"use strict";
const fs = require("fs");
const path = require("path");
const createGypsy = require("../web/gypsy.js");
const GypsyAPI = require("../web/gypsy-api.js");

const REL_TOL = 1e-9;
const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

// Reference CSV -> { name: array of numbers or strings }
function readReference(file) {
  const { header, rows } = GypsyAPI.parseCSV(read(file));
  const cols = {};
  header.forEach((h, j) => {
    cols[h] = rows.map(r => (r[j] === "" ? NaN : Number(r[j])));
  });
  cols.stand = rows.map(r => r[header.indexOf("stand")]);
  return cols;
}

// WebAssembly table -> same shape, with stand labels
function fromTable(table, standLabels, perStand) {
  const cols = {};
  table.names.forEach((n, j) => { cols[n] = Array.from(table.columns[j]); });
  cols.stand = perStand ? standLabels.slice()
                        : cols.stand_idx.map(i => standLabels[i - 1]);
  delete cols.stand_idx;
  return cols;
}

function compare(label, ref, wasm) {
  let failed = 0, worst = { name: "", rel: 0 };
  const refNames = Object.keys(ref).filter(n => n !== "stand");
  const missing = refNames.filter(n => !(n in wasm));
  if (missing.length) { console.log(`${label}: missing columns ${missing.join(", ")}`); failed++; }
  if (ref.stand.join() !== wasm.stand.join()) { console.log(`${label}: stand order differs`); failed++; }

  for (const n of refNames.filter(n => n in wasm)) {
    const a = ref[n], b = wasm[n];
    if (a.length !== b.length) { console.log(`${label} ${n}: ${a.length} vs ${b.length} rows`); failed++; continue; }
    let naDiff = 0, valDiff = 0;
    for (let i = 0; i < a.length; i++) {
      if (Number.isNaN(a[i]) !== Number.isNaN(b[i])) { naDiff++; continue; }
      if (Number.isNaN(a[i])) continue;
      const rel = Math.abs(a[i] - b[i]) / Math.max(Math.abs(a[i]), 1e-12);
      if (Math.abs(a[i] - b[i]) > 1e-12 && rel > REL_TOL) valDiff++;
      if (rel > worst.rel) worst = { name: n, rel };
    }
    if (naDiff || valDiff) {
      console.log(`${label} ${n}: ${naDiff} missing-value differences, ${valDiff} values beyond tolerance`);
      failed++;
    }
  }
  console.log(`${label}: ${refNames.length} columns, ${ref.stand.length} rows, ` +
              (failed ? `${failed} problem(s)` : "all match") +
              ` (largest relative difference ${worst.rel.toExponential(2)}${worst.name ? " in " + worst.name : ""})`);
  return failed;
}

createGypsy().then(gypsy => {
  const { input } = GypsyAPI.readInput(read("rGYPSY/inst/extdata/example_input.csv"));
  const res = GypsyAPI.run(gypsy, input, { simlen: 150, chunkSize: 2 });
  for (const w of res.warnings) console.log("warning:", w);

  let failed = 0;
  failed += compare("Yearly", readReference("test/reference/example_yearly.csv"),
                    fromTable(res.rows, res.standLabels, false));
  failed += compare("Stands", readReference("test/reference/example_stands.csv"),
                    fromTable(res.init, res.standLabels, true));
  process.exit(failed ? 1 : 0);
});
