# Reference output from the R package for test/compare_r.js
#
# Runs the example stands from rGYPSY through GYPSY_Sim() and writes the
# yearly results and stand table to test/reference/. Run from the webGYPSY
# folder:
#   Rscript test/make_reference.R
# Uses the rGYPSY submodule, so the reference matches the C++ core that
# web/gypsy.js is built from.

library(data.table)
pkgload::load_all("rGYPSY", quiet = TRUE)

inp <- fread("rGYPSY/inst/extdata/example_input.csv")
out <- GYPSY_Sim(data = inp, simlen = 150)

dir.create("test/reference", showWarnings = FALSE)
# fwrite keeps 15 significant digits, well within compare_r.js's tolerance
fwrite(out, "test/reference/example_yearly.csv", na = "")
fwrite(attr(out, "stand_init"), "test/reference/example_stands.csv", na = "")
