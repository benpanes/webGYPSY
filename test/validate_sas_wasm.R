# Validate the WebAssembly build against the full SAS test run
#
# Runs every stand in test_gypsy_bp.xlsx through web/gypsy.js (in Node) and
# compares the result with the SAS output, using the same comparisons as the
# R package's data-raw/validate_sas.R.
#
# Run from the webGYPSY folder after building web/gypsy.js:
#   Rscript test/validate_sas_wasm.R
#
# Settings (environment variables):
#   RGYPSY_DIR      rGYPSY package folder (default: the rGYPSY submodule)
#   GYPSY_DATA_DIR  folder with test_gypsy_bp.xlsx and for_gypsy_test_bp.csv
#                   (default: <RGYPSY_DIR>/scratch/data)
#   NODE            node executable (default: node on the PATH)
# Writes the per-column report to <GYPSY_DATA_DIR>/sas_validation_report_wasm.csv.

library(data.table)

rgypsy_dir  <- Sys.getenv("RGYPSY_DIR", "rGYPSY")
data_dir    <- Sys.getenv("GYPSY_DATA_DIR", file.path(rgypsy_dir, "scratch/data"))
node_bin    <- Sys.getenv("NODE", Sys.which("node"))
report_name <- "sas_validation_report_wasm.csv"
run_label   <- "WebAssembly (incl. data transfer)"
if (!nzchar(node_bin)) stop("node not found: set NODE or load Emscripten (emsdk_env)")

# Same inputs as validate_sas.R's run_sim(), run through web/gypsy.js
run_sim <- function(stump_dob, top_dib) {
  # 17 significant digits so the inputs reach WebAssembly unchanged
  num <- function(x) ifelse(is.na(x), "", sprintf("%.17g", x))
  csv <- tempfile(fileext = ".csv")
  fwrite(inp[, .(stand = Stand, stand_age = num(Standage), spp = Species, n = num(N),
                 si = num(SI), age = num(totage), ht = num(TopH), ps = PS, ba = num(BA))],
         csv, na = "")
  prefix <- tempfile("gypsy_")
  status <- system2(node_bin, c("test/run_wasm.js", shQuote(csv), shQuote(prefix), stump_dob, top_dib))
  if (status != 0) stop("run_wasm.js failed")

  meta <- jsonlite::read_json(paste0(prefix, "_meta.json"), simplifyVector = TRUE)
  read_chunks <- function(kind, names, nrows) {
    rbindlist(lapply(seq_along(nrows) - 1, function(k) {
      f <- sprintf("%s_%s_%d.bin", prefix, kind, k)
      x <- readBin(f, "double", n = nrows[k + 1]*length(names))
      setnames(as.data.table(matrix(x, ncol = length(names))), names)
    }))
  }
  rows <- read_chunks("rows", meta$rows, meta$chunkRows)
  init <- read_chunks("init", meta$init, meta$chunkStands)
  unlink(c(csv, Sys.glob(paste0(prefix, "_*"))))

  # Same shape as GYPSY_Sim(): stand IDs, integer year, stand_init attribute
  labels <- type.convert(meta$standLabels, as.is = TRUE)
  rows[, `:=`(stand = labels[stand_idx], year = as.integer(year))]
  rows[, stand_idx := NULL]
  setcolorder(rows, "stand")
  init <- cbind(data.table(stand = labels), init)
  setattr(rows, "stand_init", init)
  rows
}

source(file.path(rgypsy_dir, "data-raw/validate_sas.R"))
