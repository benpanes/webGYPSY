# webGYPSY

A browser version of the GYPSY growth and yield model (Alberta, 2009
functions). The model runs as WebAssembly compiled from the C++ core of the
[rGYPSY](https://github.com/benpanes/rGYPSY) R package, so results match the
R package and the GYPSY SAS program.

## Download

Get `gypsy-vX.Y.Z.html` from the
[latest release](https://github.com/benpanes/webGYPSY/releases/latest), save it
anywhere, and open it in a web browser by double-clicking. It is a single file
that works offline; your data never leave your computer.

### Experimental build

The version under development (the `dev` branch) runs online at
<https://benpanes.github.io/webGYPSY/experimental/>. It is rebuilt on every
push to `dev` and shows an "Experimental build" banner: features and results
may change, so use a release for published work.

## Modes

- **Single stand** (the default) is modelled on the Excel GYPSY Yield Table
  Generator: enter the stand, utilization limits and one row per species
  group (total age, top height or site index, density or initial density, and
  percent stocking and basal area), with the Excel tool's validation rules.
  Results, under the inputs, are calculated attributes at the stand's age, merchantable MAI
  culmination, a yield table, charts against stand age, an Excel workbook and
  a printable report. As in the Excel tool, conifer, deciduous and total MAI
  are over stand age and species MAI over the species' total age.
- **Multiple stands** runs a table of stands from a CSV or spreadsheet, as
  `GYPSY_Sim()` does in R, with several simulations to compare, charts and a
  results table.

Both modes can project improved seedlots (tree improvement), as
`GYPSY_Sim_TI()` does in R: the SW and PL site index is raised for the
seedlot's genetic worth for height at its selection age, using the age-age
correlations of Luo and Thomas (2021). In single stand mode, press
**Tree improvement** on the Stand tab and enter genetic worths (%) for up to
three scenarios; selection age defaults to 15 and can be changed once a
genetic worth is entered. The stand is projected unimproved and under each
scenario: the results under the Stand tab compare them in a scenario table
and a chart with every scenario overlapped (tick boxes choose conifer,
deciduous, total and scenarios). The summary, MAI culmination, yield table,
Charts tab and exports each have their own scenario menu.
Tree improvement runs must use site index, or age and top height, from
unimproved stands; a stand grown from improved seed already includes its
genetic gain and should be run normally. The app warns about this whenever
tree improvement is open. In multiple stands mode, tick
**Tree improvement** before running and assign the genetic worth and
selection age columns (`gw`, `sel_age`). A missing SW or PL genetic worth is
treated as 0, with a warning.

## Layout

| Path                     | Contents                                                      |
|--------------------------|---------------------------------------------------------------|
| `rGYPSY/`                | rGYPSY as a git submodule (`main` branch); the model is in `rGYPSY/src/core` |
| `src/gypsy_wasm.cpp`     | JavaScript bindings: exposes `runSim(input, options)`          |
| `web/gypsy-api.js`       | Helpers: delimited text, column mapping, stand ordering, chunked runs, CSV output |
| `web/vendor/`            | [SheetJS](https://sheetjs.com) Community Edition 0.20.3 (`xlsx.full.min.js`, Apache 2.0, licence in `SHEETJS_LICENSE`), for reading .xlsx, .xls, .xlsb and .ods files |
| `web/chart.js`           | SVG line charts with a hover tooltip                           |
| `web/ui.js`              | Model loading, modes, tabs and shared helpers                  |
| `web/single.js`          | Single stand mode                                              |
| `web/app.js`             | Multiple stands mode: file drop, editable input table with column assignment, simulations, charts, results |
| `web/style.css`, `web/index.html` | Page layout and styles                                |
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

- `web/gypsy.js` (about 190 KB), the model with the WebAssembly embedded, used
  by `web/index.html`.
- `dist/gypsy.html` (about 1.3 MB, most of it the spreadsheet library), the
  whole app in one file. Users can download it and open it by
  double-clicking; it works offline.

`.uild.ps1 -Channel Experimental` adds a banner and title marking a
pre-release build. The [Experimental build](.github/workflows/experimental.yml)
workflow does this for each push to `dev` and publishes the result on GitHub
Pages. It needs, once, in the repository settings: **Pages** > Source
"GitHub Actions", and **Environments** > `github-pages` > Deployment branches
allowing `dev`.

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
`topDib`. With `ti: true` the run is `GYPSY_Sim_TI()`, using the input's
`gw` and `sel_age` columns.

Large inputs run in chunks of `chunkSize` stands (default 1000) to keep
memory use bounded. For very large runs, pass `onChunk` to handle each
chunk's results (for example, append them to a file) instead of keeping
them all in memory.

## Updating the model

After changes are pushed to rGYPSY's `main` branch:

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

Merchantable density follows:

Huang, S., Meng, S.X. and Yang, Y. December 2009. A Growth and Yield Projection
System (GYPSY) for Natural and Post-harvest Stands in Alberta: Predicting
Merchantable Density. Alberta Sustainable Resource Development. Edmonton,
Alberta.

Official information about GYPSY is on the Government of Alberta's
[Growth and Yield Projection System page](https://www.alberta.ca/growth-and-yield-projection-system).
The single stand mode follows the layout of the Excel GYPSY Yield Table
Generator (Alberta Sustainable Resource Development, 2010).

The tree improvement adjustment follows section 2.4 of:

Luo, D. and Thomas, B.R. 2021. An analysis of age-age correlations in white
spruce and lodgepole pine and how it applies to the growth and yield
projection system (GYPSY) in Alberta. Forest Ecology and Management 482:
118865. https://doi.org/10.1016/j.foreco.2020.118865

## Licence

webGYPSY is free software under the GNU General Public License, version 3
(see `LICENSE`), the same licence as rGYPSY. It includes SheetJS Community
Edition, which is under the Apache License 2.0 (`web/vendor/SHEETJS_LICENSE`).

This is an independent implementation of the published GYPSY functions. It is
not produced or endorsed by the Government of Alberta, and results are
provided without warranty.
