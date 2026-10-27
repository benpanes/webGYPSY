// Run an input CSV through the WebAssembly build and save the results in a
// binary form R can read exactly (used by test/validate_sas_wasm.R)
//
//   node test/run_wasm.js <input.csv> <out prefix> <stump_dob> <top_dib>
//
// Writes, for each chunk k of stands:
//   <prefix>_rows_<k>.bin, <prefix>_init_<k>.bin   columns as float64, column after column
// and <prefix>_meta.json with the column names, rows per chunk, stand labels,
// warnings and timing. Stump height is 0.3 m; detail columns are included.

"use strict";
const fs = require("fs");
const createGypsy = require("../web/gypsy.js");
const GypsyAPI = require("../web/gypsy-api.js");

const [inFile, prefix, stumpDob, topDib] = process.argv.slice(2);
if (!topDib) {
  console.error("Usage: node test/run_wasm.js <input.csv> <out prefix> <stump_dob> <top_dib>");
  process.exit(2);
}

function writeColumns(file, table) {
  const fd = fs.openSync(file, "w");
  for (const col of table.columns) fs.writeSync(fd, Buffer.from(col.buffer, col.byteOffset, col.byteLength));
  fs.closeSync(fd);
}

createGypsy().then(gypsy => {
  const { input, warnings } = GypsyAPI.readInput(fs.readFileSync(inFile, "utf8"));
  const meta = { rows: null, init: null, chunkRows: [], chunkStands: [], standLabels: null, warnings };

  let k = 0, modelMs = 0;
  const t0 = Date.now();
  // Time the WebAssembly calls separately from writing files
  const timed = { runSim: (inp, opt) => { const t = Date.now(); const r = gypsy.runSim(inp, opt); modelMs += Date.now() - t; return r; } };

  const res = GypsyAPI.run(timed, input, {
    stumpHt: [0.3, 0.3, 0.3, 0.3],
    stumpDob: Array(4).fill(Number(stumpDob)),
    topDib: Array(4).fill(Number(topDib)),
    detail: true,
    onChunk: (chunk, standLabels) => {
      meta.rows = chunk.rows.names;
      meta.init = chunk.init.names;
      meta.standLabels = standLabels;
      meta.chunkRows.push(chunk.rows.columns[0].length);
      meta.chunkStands.push(chunk.init.columns[0].length);
      writeColumns(`${prefix}_rows_${k}.bin`, chunk.rows);
      writeColumns(`${prefix}_init_${k}.bin`, chunk.init);
      k++;
    },
  });
  meta.warnings.push(...res.warnings);
  meta.chunks = k;
  meta.modelSeconds = modelMs / 1000;
  meta.totalSeconds = (Date.now() - t0) / 1000;
  fs.writeFileSync(`${prefix}_meta.json`, JSON.stringify(meta));
  console.log(`WebAssembly: ${meta.standLabels.length} stands in ${k} chunk(s), ` +
              `model ${meta.modelSeconds.toFixed(1)} s, with file output ${meta.totalSeconds.toFixed(1)} s`);
}).catch(e => { console.error(e.message || e); process.exit(1); });
