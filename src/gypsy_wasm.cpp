#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "gypsy_sim.h"

// ---------------------------------------------------------------------------
// JavaScript bindings for the GYPSY core (rGYPSY/src/core)
//
// Exposes one function, runSim(input, options), which returns
//   { rows, init, warnings }   on success
//   { error }                  when the inputs are invalid
// rows and init are { names: [...], columns: [Float64Array, ...] }.
//
// Input arrays (one value per row; missing values must be NaN, not null):
//   stand (integer codes 0 .. n_stands - 1), standLabel (one per code),
//   standAge, spp, n, si, age, ht, ps, ba, and with ti: gw, selAge
// Options (all optional, defaults as in GYPSY_Sim() in R):
//   sitype, agetype, simlen, psflag, baflag, bh, sh, iter, tol, detail,
//   stumpHt, stumpDob, topDib (arrays of 4, AW SB SW PL),
//   ti (true: tree improvement, gypsy::SimTI, with input gw and selAge)
// ---------------------------------------------------------------------------

using emscripten::val;

namespace {

std::vector<double> num(const val& a) {
  return emscripten::convertJSArrayToNumberVector<double>(a);
}

std::vector<std::string> str(const val& a) {
  return emscripten::vecFromJSArray<std::string>(a);
}

val to_js(const gypsy::Table& t) {
  val names = val::array(), cols = val::array();
  val Float64Array = val::global("Float64Array");
  for (std::size_t k = 0; k < t.names.size(); k++) {
    names.call<void>("push", t.names[k]);
    // new Float64Array(view) copies out of WebAssembly memory
    cols.call<void>("push", Float64Array.new_(emscripten::typed_memory_view(t.cols[k].size(), t.cols[k].data())));
  }
  val out = val::object();
  out.set("names", names);
  out.set("columns", cols);
  return out;
}

val run_sim(val input, val options) {
  val out = val::object();
  try {
    gypsy::SimInput in;
    in.stand       = emscripten::convertJSArrayToNumberVector<int>(input["stand"]);
    in.stand_label = str(input["standLabel"]);
    in.stand_age   = num(input["standAge"]);
    in.spp         = str(input["spp"]);
    in.n  = num(input["n"]);  in.si = num(input["si"]); in.age = num(input["age"]);
    in.ht = num(input["ht"]); in.ps = num(input["ps"]); in.ba  = num(input["ba"]);

    gypsy::SimOptions opt;
    auto has = [&](const char* k) { return !options.isUndefined() && !options[k].isUndefined(); };
    if (has("sitype"))  opt.sitype  = options["sitype"].as<std::string>();
    if (has("agetype")) opt.agetype = options["agetype"].as<std::string>();
    if (has("simlen"))  opt.simlen  = options["simlen"].as<int>();
    if (has("psflag"))  opt.psflag  = options["psflag"].as<bool>();
    if (has("baflag"))  opt.baflag  = options["baflag"].as<bool>();
    if (has("bh"))      opt.bh      = options["bh"].as<double>();
    if (has("sh"))      opt.sh      = options["sh"].as<double>();
    if (has("iter"))    opt.iter    = options["iter"].as<int>();
    if (has("tol"))     opt.tol     = options["tol"].as<double>();
    if (has("detail"))  opt.detail  = options["detail"].as<bool>();
    auto per_spp = [&](const char* k, double* dest) {
      if (!has(k)) return;
      std::vector<double> v = num(options[k]);
      if (v.size() != 4) throw gypsy::Error(std::string(k) + " must have 4 values (AW, SB, SW, PL)");
      for (int s = 0; s < 4; s++) dest[s] = v[s];
    };
    per_spp("stumpHt",  opt.merch.stump_ht);
    per_spp("stumpDob", opt.merch.stump_dob);
    per_spp("topDib",   opt.merch.top_dib);

    gypsy::SimResult res;
    if (has("ti") && options["ti"].as<bool>()) {
      gypsy::TIInput ti;
      ti.gw      = num(input["gw"]);
      ti.sel_age = num(input["selAge"]);
      res = gypsy::SimTI(in, ti, opt);
    } else {
      res = gypsy::Sim(in, opt);
    }

    val warnings = val::array();
    for (const std::string& w : res.warnings) warnings.call<void>("push", w);
    out.set("rows", to_js(res.rows));
    out.set("init", to_js(res.init));
    out.set("warnings", warnings);
  } catch (const std::exception& e) {
    out.set("error", std::string(e.what()));
  }
  return out;
}

} // namespace

EMSCRIPTEN_BINDINGS(gypsy) {
  emscripten::function("runSim", &run_sim);
}
