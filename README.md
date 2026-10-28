# webGYPSY

A browser version of the GYPSY growth and yield model (Alberta, 2009
functions). The model runs as WebAssembly compiled from the C++ core of the
[rGYPSY](https://github.com/benpanes/rGYPSY) R package, so results match the
R package and the GYPSY SAS program.

## Download

Get `gypsy-vX.Y.Z.html` from the
[latest release](https://github.com/benpanes/webGYPSY/releases/latest), save it
anywhere, and open it in a web browser by double-clicking. It is a single file
that works offline; your data never leaves your computer.

## Layout

| Path                     | Contents                                                      |
|--------------------------|---------------------------------------------------------------|
| `rGYPSY/`                | rGYPSY as a git submodule (`cpp-core` branch); the model is in `rGYPSY/src/core` |
| `src/gypsy_wasm.cpp`     | JavaScript bindings: exposes `runSim(input, options)`          |
| `web/gypsy-api.js`       | Helpers: delimited text, column mapping, stand ordering, chunked runs, CSV output |
| `web/vendor/`            | [SheetJS](https://sheetjs.com) Community Edition 0.20.3 (`xlsx.full.min.js`, Apache 2.0, licence in `SHEETJS_LICENSE`), for reading .xlsx, .xls, .xlsb and .ods files |
| `web/chart.js`           | SVG line charts with a hover tooltip                           |
| `web/app.js`, `web/style.css`, `web/index.html` | The app: file drop, editable input table with column assignment, simulations, charts, results |
| `web/gypsy.js`           | Built module (not in git; see below)                           |
| `build.ps1`              | Build script                                                   |
| `test/`                  | Comparison with the R package                                  |

## Setup

Clone with the submodule:

```bash
git clone --recurse-submodules https://github.com/benpanes/webGYPSY.git
```

Install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html)
once per computer, then load it in each PowerShell session:

```powershell
. <path to emsdk>\emsdk_env.ps1
```

## Build

```powershell
.\build.ps1
```

This writes:

- `web/gypsy.js` (about 175 KB), the model with the WebAssembly embedded, used
  by `web/index.html`.
- `dist/gypsy.html` (about 190 KB), the whole app in one file. Users can
  download it and open it by double-clicking; it works offline.

## Using the model from JavaScript

```html
<script src="gypsy.js"></script>
<script src="gypsy-api.js"></script>
<script>
  createGypsy().then(gypsy => {
    const { input } = GypsyAPI.readInput(csvText);   // columns as in GYPSY_Sim()
    const res = GypsyAPI.run(gypsy, input, { simlen: 150 });
    // res.rows: one row per stand and year; res.init: one row per stand;
    // res.warnings: messages; res.standLabels: stand IDs in output order
    const csv = GypsyAPI.toCSV(res.rows, res.standLabels);
  });
</script>
```

Options match `GYPSY_Sim()` in R: `sitype`, `agetype`, `simlen`, `psflag`,
`baflag`, `bh`, `sh`, `iter`, `tol`, `detail`, and the merchantability
standard as arrays of four values (AW, SB, SW, PL): `stumpHt`, `stumpDob`,
`topDib`.

Large inputs run in chunks of `chunkSize` stands (default 1000) to keep
memory use bounded. For very large runs, pass `onChunk` to handle each
chunk's results (for example, append them to a file) instead of keeping
them all in memory.

## Updating the model

After changes are pushed to rGYPSY's `cpp-core` branch:

```bash
git submodule update --remote rGYPSY
```

Rebuild, re-run the test, and commit the new submodule pointer.

## Testing against R

`test/compare_r.js` runs the rGYPSY example stands through the WebAssembly
build and compares every output column with the R package's results
(`test/reference/`, written by `test/make_reference.R`):

```powershell
node test/compare_r.js
```

After updating the submodule, regenerate the reference first with
`Rscript test/make_reference.R` (needs R with Rtools).

`test/validate_sas_wasm.R` runs the full GYPSY SAS test set (7,333 stands)
through the WebAssembly build and compares it with the SAS output, reusing
rGYPSY's `data-raw/validate_sas.R`. It needs the SAS test files, which aren't
in either repository:

```powershell
$env:GYPSY_DATA_DIR = "<folder with test_gypsy_bp.xlsx and for_gypsy_test_bp.csv>"
$env:NODE = "<path to node.exe>"   # e.g. the one in emsdk\node
Rscript test/validate_sas_wasm.R
```

## Acknowledgements

GYPSY (Growth and Yield Projection System) was developed by Dr. Shongming
Huang and colleagues with the Government of Alberta. The model is described
in:

Huang, S., Meng, S.X. and Yang, Y. 2009. A Growth and Yield Projection System
(GYPSY) for Natural and Post-harvest Stands in Alberta. Alberta Sustainable
Resource Development, Technical Report Pub. No. T/216. Edmonton, Alberta.

Official information about GYPSY is on the Government of Alberta's
[Growth and Yield Projection System page](https://www.alberta.ca/growth-and-yield-projection-system).

## Licence

webGYPSY is free software under the GNU General Public License, version 3
(see `LICENSE`), the same licence as rGYPSY. It includes SheetJS Community
Edition, which is under the Apache License 2.0 (`web/vendor/SHEETJS_LICENSE`).

This is an independent implementation of the published GYPSY functions. It is
not produced or endorsed by the Government of Alberta, and results are
provided without warranty.
