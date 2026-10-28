// ---------------------------------------------------------------------------
// GYPSY web app, single stand mode
//
// Laid out after the Excel GYPSY Yield Table Generator: stand details,
// utilization limits and one row per species group in; calculated
// attributes, MAI culmination, a yield table, charts and a printable report
// out. After the first run, results follow the inputs as they change.
//
// As in the Excel tool:
//   - stand age defaults to the oldest species' total age (rounded up to a
//     whole year here)
//   - conifer, deciduous and total MAI are merchantable volume / stand age;
//     species MAI is merchantable volume / species total age
//   - piece size is merchantable stems / merchantable volume (trees/m³)
//   - density can be entered as initial density (N0); the observed density
//     that gives that N0 is found by search
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const { SPP_NAMES, download, fileStem, message, enableTab, selectTab, store } = GypsyUI;
  const SPECIES = GypsyAPI.SPECIES;
  const CONIFERS = ["SB", "SW", "PL"];
  const lc = s => s.toLowerCase();

  // Column heading menus (the Excel tool's pick lists)
  const AGE_KINDS = { T: "Total age", B: "Breast height age", S: "Stump height age" };
  const HT_KINDS  = { ht: "Top height (m)", siB: "Site index, BH age 50 (m)", siT: "Site index, total age 50 (m)" };
  const DEN_KINDS = { n: "Density (stems/ha)", n0: "Initial density, N0 (stems/ha)" };
  const FIELDS = [
    { key: "age", kinds: AGE_KINDS, step: "0.1" },
    { key: "ht",  kinds: HT_KINDS,  step: "0.1" },
    { key: "n",   kinds: DEN_KINDS, step: "1" },
    { key: "ps",  label: "Percent stocking (%)", step: "0.1" },
    { key: "ba",  label: "Basal area (m²/ha)", step: "0.1" },
  ];
  const UTIL = [
    { key: "stumpDob", label: "Stump DOB (cm)",   def: 15,  step: "0.5" },
    { key: "topDib",   label: "Top DIB (cm)",     def: 10,  step: "0.5" },
    { key: "stumpHt",  label: "Stump height (m)", def: 0.3, step: "0.05" },
  ];
  const X_LABEL = "Stand age (years)";

  const EXAMPLE = {
    id: "Example mixedwood", type: "Natural", standAge: "48", projectTo: "250", psflag: true, baflag: true,
    kinds: { age: "T", ht: "ht", n: "n" },
    spp: { AW: { age: "48", ht: "19.8", n: "1100", ps: "70", ba: "21.5" },
           SW: { age: "31", ht: "9.6",  n: "450",  ps: "25", ba: "4.1" } },
    util: {},
  };

  const S = {
    gypsy: null,
    kinds: { age: "T", ht: "ht", n: "n" },
    result: null,      // last successful run (see derive())
    live: false,       // after the first run, re-run as inputs change
  };

  // ---- Form -----------------------------------------------------------------------
  function buildForm() {
    const t = $("sSpecies");
    const hr = t.createTHead().insertRow();
    const th0 = document.createElement("th");
    th0.textContent = "Species";
    hr.appendChild(th0);
    for (const f of FIELDS) {
      const th = document.createElement("th");
      if (f.kinds) {
        const sel = document.createElement("select");
        sel.id = `sKind_${f.key}`;
        sel.setAttribute("aria-label", "Column holds");
        for (const [k, label] of Object.entries(f.kinds)) sel.add(new Option(label, k));
        sel.value = S.kinds[f.key];
        sel.addEventListener("change", () => { S.kinds[f.key] = sel.value; changed(); });
        th.appendChild(sel);
      } else th.textContent = f.label;
      hr.appendChild(th);
    }
    const body = t.createTBody();
    for (const s of SPECIES) {
      const tr = body.insertRow();
      const th = document.createElement("th");
      th.scope = "row";
      th.innerHTML = `${s} <span class="small">${SPP_NAMES[s]}</span>`;
      tr.appendChild(th);
      for (const f of FIELDS) {
        const inp = document.createElement("input");
        Object.assign(inp, { type: "number", step: f.step, min: "0", id: `s_${f.key}_${s}` });
        inp.setAttribute("aria-label", `${SPP_NAMES[s]}, ${f.label || f.kinds[S.kinds[f.key]]}`);
        tr.insertCell().appendChild(inp);
      }
    }

    const u = $("sUtil");
    const uh = u.createTHead().insertRow();
    for (const text of ["Species", ...UTIL.map(x => x.label)]) {
      const th = document.createElement("th");
      th.textContent = text;
      uh.appendChild(th);
    }
    const ub = u.createTBody();
    for (const s of SPECIES) {
      const tr = ub.insertRow();
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = s;
      th.title = SPP_NAMES[s];
      tr.appendChild(th);
      for (const x of UTIL) {
        const inp = document.createElement("input");
        Object.assign(inp, { type: "number", step: x.step, min: "0", placeholder: String(x.def), id: `s_${x.key}_${s}` });
        inp.setAttribute("aria-label", `${SPP_NAMES[s]}, ${x.label}`);
        tr.insertCell().appendChild(inp);
      }
    }
  }

  // Form -> plain object of strings (also what is remembered between visits)
  function formState() {
    const o = {
      id: $("sStandId").value, type: $("sStandType").value, standAge: $("sStandAge").value,
      projectTo: $("sProjectTo").value, psflag: $("sPsflag").checked, baflag: $("sBaflag").checked,
      kinds: { ...S.kinds }, spp: {}, util: {},
    };
    for (const s of SPECIES) {
      const r = {};
      for (const f of FIELDS) if ($(`s_${f.key}_${s}`).value !== "") r[f.key] = $(`s_${f.key}_${s}`).value;
      if (Object.keys(r).length) o.spp[s] = r;
      const u = {};
      for (const x of UTIL) if ($(`s_${x.key}_${s}`).value !== "") u[x.key] = $(`s_${x.key}_${s}`).value;
      if (Object.keys(u).length) o.util[s] = u;
    }
    return o;
  }

  function setForm(o) {
    $("sStandId").value = o.id || "";
    $("sStandType").value = o.type || "";
    $("sStandAge").value = o.standAge || "";
    $("sProjectTo").value = o.projectTo || "250";
    $("sPsflag").checked = o.psflag !== false;
    $("sBaflag").checked = o.baflag !== false;
    Object.assign(S.kinds, { age: "T", ht: "ht", n: "n" }, o.kinds);
    for (const f of FIELDS) if (f.kinds) $(`sKind_${f.key}`).value = S.kinds[f.key];
    for (const s of SPECIES) {
      for (const f of FIELDS) $(`s_${f.key}_${s}`).value = o.spp?.[s]?.[f.key] ?? "";
      for (const x of UTIL) $(`s_${x.key}_${s}`).value = o.util?.[s]?.[x.key] ?? "";
    }
  }

  // ---- Checks -------------------------------------------------------------------------
  // The Excel tool's validation rules, adapted to this model. Errors stop the
  // run; warnings point out values that look unusual.
  const val = id => {
    const el = $(id);
    if (el.validity && el.validity.badInput) return "bad";
    return el.value === "" ? NaN : Number(el.value);
  };

  function check() {
    const out = [];   // { id (input), level, text }
    const add = (id, level, text) => out.push({ id, level, text });
    const ps = $("sPsflag").checked;
    const sppLabel = s => `${s} (${SPP_NAMES[s]})`;

    const standAge = val("sStandAge");
    if (standAge === "bad") add("sStandAge", "err", "Stand age must be a number.");
    else if (Number.isFinite(standAge) && (standAge < 10 || standAge > 240))
      add("sStandAge", "warn", "Stand age is usually between 10 and 240 years.");
    const to = val("sProjectTo");
    if (!(to >= 20 && to <= 400)) add("sProjectTo", "err", "Project to stand age must be between 20 and 400.");

    let present = 0;
    for (const s of SPECIES) {
      const v = {};
      for (const f of FIELDS) v[f.key] = val(`s_${f.key}_${s}`);
      const given = k => Number.isFinite(v[k]);
      for (const f of FIELDS) if (v[f.key] === "bad") add(`s_${f.key}_${s}`, "err", `${sppLabel(s)}: not a number.`);
      if (!FIELDS.some(f => given(f.key) || v[f.key] === "bad")) continue;
      present++;
      const id = k => `s_${k}_${s}`;
      const ageName = AGE_KINDS[S.kinds.age].toLowerCase();
      const htName = S.kinds.ht === "ht" ? "top height" : "site index";
      const nName = S.kinds.n === "n" ? "density" : "initial density";

      if (!given("age")) add(id("age"), "err", `${sppLabel(s)}: ${ageName} is needed.`);
      if (!given("ht"))  add(id("ht"),  "err", `${sppLabel(s)}: ${htName} is needed.`);
      if (!given("n"))   add(id("n"),   "err", `${sppLabel(s)}: ${nName} is needed.`);

      if (given("age") && S.kinds.ht === "ht") {
        const min = s === "AW" || s === "PL" ? 7.5 : 9.5;
        if (v.age < min) add(id("age"), "err", `${sppLabel(s)}: age must be at least ${min} years to calculate a site index from top height.`);
      }
      if (given("ht")) {
        if (S.kinds.ht === "ht") {
          const min = s === "AW" || S.kinds.age === "B" ? 1.3 : 0.3;
          if (v.ht < min) add(id("ht"), "err", `${sppLabel(s)}: top height must be at least ${min} m.`);
          else if (v.ht > 35) add(id("ht"), "warn", `${sppLabel(s)}: top height over 35 m is unusual.`);
        } else if (v.ht < 5 || v.ht > 30) add(id("ht"), "warn", `${sppLabel(s)}: site index is usually between 5 and 30 m.`);
      }
      if (given("n")) {
        if (v.n <= 30) add(id("n"), "err", `${sppLabel(s)}: ${nName} must be more than 30 stems/ha.`);
        else if (v.n < 50 || v.n > 100000) add(id("n"), "warn", `${sppLabel(s)}: ${nName} is usually between 50 and 100,000 stems/ha.`);
      }
      if (given("ps")) {
        if (v.ps < 0 || v.ps > 100) add(id("ps"), "err", `${sppLabel(s)}: percent stocking must be between 0 and 100.`);
        else if (given("n") && v.n < 1000 && v.ps > v.n / 10)
          add(id("ps"), "err", `${sppLabel(s)}: percent stocking can be at most density / 10 below 1,000 stems/ha.`);
        else if (v.ps > 0 && v.ps <= 1) add(id("ps"), "warn", `${sppLabel(s)}: percent stocking of 1 or less may have been entered as a proportion.`);
      } else if (ps) add(id("ps"), "err", `${sppLabel(s)}: percent stocking is needed while "Use percent stocking" is ticked.`);
    }
    if (!present) add("s_age_AW", "err", "Fill in at least one species.");

    for (const s of SPECIES) {
      const u = {};
      for (const x of UTIL) {
        u[x.key] = val(`s_${x.key}_${s}`);
        if (u[x.key] === "bad") add(`s_${x.key}_${s}`, "err", `${s} utilization: not a number.`);
        else if (Number.isNaN(u[x.key])) u[x.key] = x.def;
      }
      if (u.stumpDob <= u.topDib) add(`s_stumpDob_${s}`, "err", `${s} utilization: stump DOB must be more than top DIB.`);
      if (u.stumpHt < 0.1 || u.stumpHt > 0.3) add(`s_stumpHt_${s}`, "err", `${s} utilization: stump height must be between 0.1 and 0.3 m.`);
    }
    return out;
  }

  // Checks that need the model's ages (years to breast height)
  function checkAfter(D) {
    const out = [];
    for (const s of D.present) {
      const bh = D.init[`${lc(s)}_bhage`];
      const ba = D.form.spp[s].ba;
      if (!D.baflag) continue;
      if (ba != null && !(bh > 0))
        out.push({ id: `s_ba_${s}`, level: "err", text: `${s} (${SPP_NAMES[s]}): basal area can't be given before breast height age (years to breast height ${fmt(D.init[`${lc(s)}_y2bh`], 1)}).` });
      else if (ba == null && bh > 0)
        out.push({ id: `s_ba_${s}`, level: "warn", text: `${s} (${SPP_NAMES[s]}): basal area should be given while "Adjust to observed basal area" is ticked (the species is past breast height age).` });
    }
    return out;
  }

  function showChecks(list) {
    for (const el of document.querySelectorAll("#s-input td.err, #s-input td.warn, #s-input .field.err, #s-input .field.warn"))
      el.classList.remove("err", "warn");
    for (const el of document.querySelectorAll("#s-input input[title]")) el.removeAttribute("title");
    const box = $("sChecks");
    box.innerHTML = "";
    for (const c of list) {
      const el = $(c.id);
      const holder = el.closest("td") || el.closest(".field");
      if (holder && !(holder.classList.contains("err"))) {
        holder.classList.remove("warn");
        holder.classList.add(c.level);
      }
      el.title = (el.title ? el.title + "\n" : "") + c.text;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "check-item " + c.level;
      b.textContent = (c.level === "err" ? "Error: " : "Check: ") + c.text;
      b.addEventListener("click", () => { selectTab("s-input"); el.focus(); });
      box.appendChild(b);
    }
  }

  // ---- Running ---------------------------------------------------------------------
  const isPresent = (o, s) => !!o.spp[s];

  function modelInput(o, standAge, nOverride = {}) {
    const present = SPECIES.filter(s => isPresent(o, s));
    const num = x => (x == null || x === "" ? NaN : Number(x));
    const si = S.kinds.ht !== "ht";
    return {
      present,
      input: {
        stand: present.map(() => "1"),
        stand_age: present.map(() => standAge),
        spp: present,
        n:   present.map(s => nOverride[s] ?? num(o.spp[s].n)),
        si:  present.map(s => (si ? num(o.spp[s].ht) : NaN)),
        age: present.map(s => num(o.spp[s].age)),
        ht:  present.map(s => (si ? NaN : num(o.spp[s].ht))),
        ps:  present.map(s => num(o.spp[s].ps)),
        ba:  present.map(s => num(o.spp[s].ba)),
      },
    };
  }

  function utilOptions(o) {
    const out = {};
    for (const x of UTIL)
      out[x.key] = SPECIES.map(s => (o.util[s]?.[x.key] != null ? Number(o.util[s][x.key]) : x.def));
    return out;
  }

  const initValues = res => Object.fromEntries(res.init.names.map((n, k) => [n, res.init.columns[k][0]]));

  // Observed densities that give the entered initial densities (N0): each
  // species in turn by bisection on the log of density, repeated until no
  // density changes (the conifers' N0 also depends on aspen density).
  // Observed density is at most N0; very low densities give no N0, which
  // counts as too low.
  function solveN0(o, opts) {
    const target = {};
    for (const s of SPECIES) if (isPresent(o, s)) target[s] = Number(o.spp[s].n);
    const n = { ...target };
    const den0 = s => initValues(GypsyAPI.run(S.gypsy, modelInput(o, 100, n).input, { ...opts, simlen: 1 }))[`${lc(s)}_den0`];
    for (let sweep = 0; sweep < 20; sweep++) {
      let moved = 0;
      for (const s of Object.keys(target)) {
        let lo = 0, hi = Math.log(target[s] * 1.5);
        const before = n[s];
        for (let i = 0; i < 80 && hi - lo > 1e-13; i++) {
          n[s] = Math.exp((lo + hi) / 2);
          const d = den0(s);
          if (Number.isFinite(d) && d > target[s]) hi = Math.log(n[s]); else lo = Math.log(n[s]);
        }
        const d = den0(s);
        if (!(Math.abs(d - target[s]) <= 1e-6 * target[s]))
          throw new Error(`No ${s} density gives an initial density (N0) of ${target[s]} stems/ha with the other inputs.`);
        moved = Math.max(moved, Math.abs(n[s] - before) / target[s]);
      }
      if (moved < 1e-9) return n;
    }
    throw new Error("The densities for the initial densities (N0) given could not be found.");
  }

  function runStand() {
    $("sMessages").innerHTML = "";
    const list = check();
    showChecks(list);
    if (list.some(c => c.level === "err")) {
      $("sStatus").textContent = "Fix the errors in the Stand tab to run";
      markStale(true);
      return false;
    }
    const o = formState();
    const opts = {
      psflag: o.psflag, baflag: o.baflag,
      sitype: S.kinds.ht === "siT" ? "T" : "B", agetype: S.kinds.age,
      ...utilOptions(o),
    };
    try {
      const t0 = performance.now();
      const nObs = S.kinds.n === "n0" ? solveN0(o, opts) : {};
      // The leading total age, for the default stand age and the run length
      const first = GypsyAPI.run(S.gypsy, modelInput(o, 100, nObs).input, { ...opts, simlen: 1 });
      const i0 = initValues(first);
      const tmax = i0.totage_max;
      if (!Number.isFinite(tmax)) throw new Error("No total age could be determined for the stand.");
      const standAge = o.standAge !== "" ? Number(o.standAge) : Math.ceil(tmax - 1e-9);
      const to = Number(o.projectTo);
      // Stand age in year k (1-based) is totage_0 + k - 1 + (stand age - leading age)
      const simlen = Math.max(1, Math.ceil(to - (standAge - tmax) - i0.totage_0 + 1 + 1e-9));
      const { present, input } = modelInput(o, standAge, nObs);
      const res = GypsyAPI.run(S.gypsy, input, { ...opts, simlen });
      const D = derive(o, present, standAge, tmax, to, res, nObs);
      D.ms = performance.now() - t0;

      const after = checkAfter(D);
      showChecks([...list, ...after]);
      if (after.some(c => c.level === "err")) {
        $("sStatus").textContent = "Fix the errors in the Stand tab to run";
        markStale(true);
        return false;
      }
      for (const w of res.warnings) message("sMessages", w, "warn");
      S.result = D;
      markStale(false);
      render(D);
      $("sStatus").textContent = `Projected to stand age ${to} in ${D.ms < 1000 ? D.ms.toFixed(0) + " ms" : (D.ms / 1000).toFixed(1) + " s"}`;
      return true;
    } catch (e) {
      message("sMessages", e.message, "err");
      $("sStatus").textContent = "Stopped with an error";
      markStale(true);
      return false;
    }
  }

  function markStale(stale) {
    const has = !!S.result;
    for (const id of ["s-summary", "s-yield", "s-charts"]) enableTab(id, has);
    for (const id of ["sXlsx", "sCsv", "sPrint"]) $(id).disabled = !has;
    document.body.classList.toggle("single-stale", has && stale);
    if (has && stale) message("sMessages", "The results shown are for the previous inputs.", "warn");
  }

  // ---- Results ----------------------------------------------------------------------
  // Rows from stand age just above 0 to the "project to" age, with the
  // Excel tool's stand age based MAI and piece size added
  function derive(form, present, standAge, tmax, to, res, nObs) {
    const all = {};
    res.rows.names.forEach((n, k) => { all[n] = res.rows.columns[k]; });
    const sa = all.standage;
    let a = 0, b = sa.length;
    while (a < b && !(sa[a] > 0)) a++;
    while (b > a && sa[b - 1] > to + 1e-9) b--;
    const col = {};
    for (const [n, c] of Object.entries(all)) col[n] = c.subarray(a, b);

    const len = b - a, z = v => (Number.isFinite(v) ? v : 0);
    const make = f => { const out = new Float64Array(len); for (let r = 0; r < len; r++) out[r] = f(r); return out; };
    col.mvol_dec = col.mvol_aw;
    col.tvol_dec = col.tvol_aw;
    for (const g of ["con", "dec", "all"]) col[`mai_sa_${g}`] = make(r => z(col[`mvol_${g}`][r]) / col.standage[r]);
    col.pc_con = make(r => (col.mvol_con[r] > 1e-4 ? (z(col.mn_sb[r]) + z(col.mn_sw[r]) + z(col.mn_pl[r])) / col.mvol_con[r] : NaN));
    col.pc_dec = make(r => (col.mvol_aw[r] > 1e-4 ? z(col.mn_aw[r]) / col.mvol_aw[r] : NaN));

    const init = initValues(res);
    // Values at the stand's own (observed) age
    let rObs = 0;
    for (let r = 1; r < all.totage.length; r++)
      if (Math.abs(all.totage[r] - tmax) < Math.abs(all.totage[rObs] - tmax)) rObs = r;
    const obs = n => all[n][rObs];

    const groups = { con: present.some(s => CONIFERS.includes(s)), dec: present.includes("AW") };
    return { form, present, standAge, tmax, to, res, col, len, init, obs, nObs, groups,
             baflag: form.baflag, label: form.id.trim() || "New stand" };
  }

  // Number formatting for display
  function fmt(v, d) {
    if (!Number.isFinite(v)) return "–";
    return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function makeTable(head, rows, { groups } = {}) {
    const t = document.createElement("table");
    t.className = "results" + (groups ? " grouped" : "");
    const th = t.createTHead();
    if (groups) {
      const gr = th.insertRow();
      for (const [text, span] of groups) {
        const c = document.createElement("th");
        c.textContent = text;
        c.colSpan = span;
        if (text) c.className = "group";
        gr.appendChild(c);
      }
    }
    const hr = th.insertRow();
    for (const h of head) {
      const c = document.createElement("th");
      if (Array.isArray(h)) { c.innerHTML = `${h[0]}<span class="unit">${h[1]}</span>`; }
      else c.textContent = h;
      hr.appendChild(c);
    }
    const tb = t.createTBody();
    for (const r of rows) {
      const tr = tb.insertRow();
      for (const v of r) tr.insertCell().textContent = v;
    }
    return t;
  }

  // Calculated attributes at the stand's age, one row per species
  function calcTable(D) {
    const head = ["Species", ["Total age", "years"], ["BH age", "years"], ["Years to BH", "years"], ["Top height", "m"],
                  ["SI, BH age 50", "m"], ["SI, total age 50", "m"], ["Density", "stems/ha"], ["N0", "stems/ha"], ["SDF", ""], ["PSI", "%"]];
    const rows = D.present.map(s => {
      const x = lc(s), i = D.init;
      return [`${s} – ${SPP_NAMES[s]}`, fmt(i[`${x}_totage`], 1), fmt(i[`${x}_bhage`], 1), fmt(i[`${x}_y2bh`], 1),
              fmt(D.obs(`topht_${x}`), 2), fmt(i[`${x}_si_bh`], 2), fmt(i[`${x}_si_t`], 2), fmt(D.obs(`n_${x}`), 0),
              fmt(i[`${x}_den0`], 0), fmt(i[`${x}_sdf`], 1), fmt(i[`${x}_psi`], 1)];
    });
    return { head, rows };
  }

  // Culmination of merchantable MAI: by species (species total age) and by
  // group (stand age), with the other group's MAI at the same age
  function culmination(D) {
    const c = D.col;
    const argmax = arr => {
      let k = -1;
      for (let r = 0; r < arr.length; r++) if (Number.isFinite(arr[r]) && (k < 0 || arr[r] > arr[k])) k = r;
      return k >= 0 && arr[k] > 0 ? k : -1;
    };
    // values: [label, MAI, species age, stand age, other MAI], NaN where
    // there is none
    const values = [], late = [];
    const at = (col, k) => (k < 0 ? NaN : c[col][k]);
    for (const s of D.present) {
      const k = argmax(c[`mai_m_${lc(s)}`]);
      if (k === D.len - 1) late.push(s);
      values.push([`${s} – ${SPP_NAMES[s]}`, at(`mai_m_${lc(s)}`, k), at(`totage_${lc(s)}`, k), at("standage", k), NaN]);
    }
    const groups = [["con", "Conifer", "dec"], ["dec", "Deciduous", "con"], ["all", "Total", null]];
    for (const [g, name, other] of groups) {
      if (g !== "all" && !D.groups[g]) continue;
      const k = argmax(c[`mai_sa_${g}`]);
      if (k === D.len - 1) late.push(name.toLowerCase());
      values.push([name, at(`mai_sa_${g}`, k), NaN, at("standage", k),
                   other && D.groups[other] ? at(`mai_sa_${other}`, k) : NaN]);
    }
    const show = (v, d) => (Number.isFinite(v) ? fmt(v, d) : "");
    return {
      head: ["", ["MAI", "m³/ha/yr"], ["Species age", "years"], ["Stand age", "years"], ["Other MAI", "m³/ha/yr"]],
      values,
      rows: values.map(([label, m, sa, ta, o]) => [label, Number.isFinite(m) ? fmt(m, 3) : "–", show(sa, 1), show(ta, 0), show(o, 3)]),
      note: "Species MAI is merchantable volume over the species' total age; conifer, deciduous and total MAI are over stand age. " +
            "Other MAI is the deciduous MAI at the conifer culmination age, and the reverse." +
            (late.length ? ` Not reached by stand age ${D.to}: ${late.join(", ")}.` : ""),
    };
  }

  // Rows at stand ages that are multiples of the step
  function yieldRows(D, step) {
    const sa = D.col.standage, out = [];
    let r = 0;
    for (let age = step; age <= D.to + 1e-9; age += step) {
      while (r + 1 < D.len && Math.abs(sa[r + 1] - age) <= Math.abs(sa[r] - age)) r++;
      if (Math.abs(sa[r] - age) < 0.5) out.push(r);
    }
    return out;
  }

  function yieldTable(D, kind, step) {
    const c = D.col, rows = yieldRows(D, step);
    if (kind === "detail") {
      const M = [["topht_", "Top height", "m", 1], ["n_", "Density", "stems/ha", 0], ["mn_", "Merch. density", "stems/ha", 0],
                 ["ba_", "BA", "m²/ha", 1], ["qmd_", "QMD", "cm", 1], ["sc_", "Composition", "", 3],
                 ["tvol_", "Total vol.", "m³/ha", 1], ["mvol_", "Merch. vol.", "m³/ha", 1], ["mai_m_", "Merch. MAI", "m³/ha/yr", 3]];
      return {
        groups: [["", 1], ...D.present.map(s => [`${s} – ${SPP_NAMES[s]}`, M.length])],
        head: [["Stand age", "years"], ...D.present.flatMap(() => M.map(m => [m[1], m[2]]))],
        rows: rows.map(r => [fmt(c.standage[r], 0), ...D.present.flatMap(s => M.map(m => fmt(c[m[0] + lc(s)][r], m[3])))]),
        cols: ["standage", ...D.present.flatMap(s => M.map(m => m[0] + lc(s)))], rowIdx: rows,
      };
    }
    const groups = [["", 1]], head = [["Stand age", "years"]], cols = ["standage"], digits = [0];
    const add = (name, list) => {
      groups.push([name, list.length]);
      for (const [col, label, unit, d] of list) { head.push([label, unit]); cols.push(col); digits.push(d); }
    };
    if (D.groups.con) add("Conifer", [["mvol_con", "Merch. vol.", "m³/ha", 1], ["mai_sa_con", "MAI", "m³/ha/yr", 3], ["pc_con", "Piece size", "trees/m³", 1]]);
    if (D.groups.dec) add("Deciduous", [["mvol_dec", "Merch. vol.", "m³/ha", 1], ["mai_sa_dec", "MAI", "m³/ha/yr", 3], ["pc_dec", "Piece size", "trees/m³", 1]]);
    add("Total", [["mvol_all", "Merch. vol.", "m³/ha", 1], ["mai_sa_all", "MAI", "m³/ha/yr", 3]]);
    return { groups, head, cols, rowIdx: rows, rows: rows.map(r => cols.map((k, j) => fmt(c[k][r], digits[j]))) };
  }

  // Charts, as in the Excel tool's report
  function chartSpecs(D) {
    const c = D.col, x = c.standage;
    const bySpp = (prefix, label, unit) => ({
      key: prefix.replace(/_$/, ""), title: prefix === "sc_" ? label : `${label} by species`, yLabel: `${label} (${unit})`,
      series: D.present.map(s => ({ label: s, slot: SPECIES.indexOf(s) + 1, dash: 0, x, y: c[prefix + lc(s)] })),
    });
    const byGroup = (prefix, label, unit) => {
      const list = [["all", "Total", 2]];
      // One group alone is the same as the total
      if (D.groups.con && D.groups.dec) list.push(["con", "Conifer", 3], ["dec", "Deciduous", 1]);
      return { key: prefix + "group", title: label, yLabel: `${label.replace(/ \(.*\)$/, "")} (${unit})`,
               series: list.map(([g, name, slot]) => ({ label: name, slot, dash: 0, x, y: c[prefix + g] })) };
    };
    return [
      byGroup("mvol_", "Merchantable volume", "m³/ha"),
      byGroup("mai_sa_", "Merchantable MAI (stand age)", "m³/ha/yr"),
      byGroup("tvol_", "Total volume", "m³/ha"),
      bySpp("mvol_", "Merchantable volume", "m³/ha"),
      bySpp("mai_m_", "Merchantable MAI (species age)", "m³/ha/yr"),
      bySpp("topht_", "Top height", "m"),
      bySpp("qmd_", "Quadratic mean diameter", "cm"),
      bySpp("ba_", "Basal area", "m²/ha"),
      bySpp("n_", "Density", "stems/ha"),
      bySpp("mn_", "Merchantable density", "stems/ha"),
      bySpp("sc_", "Species composition", "proportion"),
    ].map(s => ({ ...s, xLabel: X_LABEL }));
  }

  function render(D) {
    $("sSummaryTitle").textContent = D.label;
    const info = [`Stand age ${fmt(D.standAge, 0)}${D.form.standAge === "" ? ` (from the oldest species' total age, ${fmt(D.tmax, 1)})` : ""}`];
    if (D.form.type) info.push(D.form.type);
    info.push(`Percent stocking ${D.form.psflag ? "used" : "not used"}`, `BA adjustment ${D.form.baflag ? "on" : "off"}`);
    $("sSummaryInfo").textContent = info.join(" · ");

    const calc = calcTable(D);
    $("sCalc").replaceWith(Object.assign(makeTable(calc.head, calc.rows), { id: "sCalc" }));
    const cu = culmination(D);
    $("sCulm").replaceWith(Object.assign(makeTable(cu.head, cu.rows), { id: "sCulm" }));
    $("sCulmNote").textContent = cu.note;

    renderYield();
    const specs = chartSpecs(D);
    const q = $("sQuickChart"), keep = q.value;
    q.innerHTML = "";
    for (const s of specs) q.add(new Option(s.title, s.key));
    q.value = specs.some(s => s.key === keep) ? keep : specs[0].key;
    renderQuick();
    renderCharts();
  }

  function renderYield() {
    const D = S.result;
    if (!D) return;
    const y = yieldTable(D, $("sYieldKind").value, Number($("sYieldStep").value));
    $("sYield").replaceWith(Object.assign(makeTable(y.head, y.rows, { groups: y.groups }), { id: "sYield" }));
    $("sYieldTitle").textContent = `Yield table for ${D.label}`;
    $("sYieldNote").textContent = $("sYieldKind").value === "yield"
      ? "MAI is merchantable volume over stand age. Piece size is merchantable stems per cubic metre of merchantable volume."
      : "Merchantable MAI by species is over the species' total age.";
  }

  const QUICK_HEIGHT = 300;
  function renderQuick() {
    const D = S.result;
    if (!D) return;
    const spec = chartSpecs(D).find(s => s.key === $("sQuickChart").value);
    GypsyChart.line($("sQuickBox"), { ...spec, height: QUICK_HEIGHT });
  }

  function renderCharts() {
    const D = S.result, box = $("sCharts");
    box.innerHTML = "";
    if (!D) return;
    for (const spec of chartSpecs(D)) {
      const panel = document.createElement("div");
      panel.className = "chart-panel";
      const chartBox = document.createElement("div");
      let svg;
      panel.draw = () => { svg = GypsyChart.line(chartBox, { ...spec, height: 260 }); };
      const actions = document.createElement("div");
      actions.className = "chart-actions";
      const file = `${fileStem(D.label)}_${spec.key}.svg`;
      actions.append(
        GypsyUI.button("Open in new window", () => GypsyUI.openChartWindow(spec, file, t => message("sChartMessages", t, "warn")), "link"),
        GypsyUI.button("Download SVG", () => download(GypsyChart.toSVGText(svg), file, "image/svg+xml"), "link"));
      panel.append(chartBox, actions);
      box.appendChild(panel);
      panel.draw();
    }
  }

  // Redraw when a chart area changes width (window resize, tab shown)
  for (const [id, draw] of [["sCharts", () => { for (const p of $("sCharts").children) p.draw && p.draw(); }], ["sQuickBox", renderQuick]]) {
    let last = 0, timer;
    new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (Math.abs(w - last) < 1 || !w) return;
      last = w;
      clearTimeout(timer);
      timer = setTimeout(draw, 80);
    }).observe($(id));
  }

  // ---- Exports ----------------------------------------------------------------------
  // Every yearly column, with stand age first
  function yearlyTable(D) {
    const skip = new Set(["stand_idx", "year"]);
    const names = ["standage", ...Object.keys(D.col).filter(n => !skip.has(n) && n !== "standage")];
    return { names, columns: names.map(n => D.col[n]) };
  }

  function inputSheet(D) {
    const f = D.form;
    const aoa = [
      ["GYPSY single stand input"], [],
      ["Stand ID", D.label], ["Stand type", f.type || ""], ["Stand age", D.standAge],
      ["Stand age from", f.standAge === "" ? "Oldest species' total age (rounded up)" : "Entered"],
      ["Project to stand age", D.to], ["Use percent stocking", f.psflag ? "YES" : "NO"],
      ["Adjust to observed basal area", f.baflag ? "YES" : "NO"], [],
      ["Species", AGE_KINDS[S.kinds.age], HT_KINDS[S.kinds.ht], DEN_KINDS[S.kinds.n], "Percent stocking (%)", "Basal area (m²/ha)"],
      ...SPECIES.map(s => [s, ...FIELDS.map(x => (f.spp[s]?.[x.key] != null ? Number(f.spp[s][x.key]) : ""))]), [],
      ["Species", ...UTIL.map(x => x.label)],
      ...SPECIES.map((s, i) => [s, ...UTIL.map(x => utilOptions(f)[x.key][i])]),
    ];
    return XLSX.utils.aoa_to_sheet(aoa);
  }

  // Heading rows of a table for a worksheet: group row (if any), then
  // column names with units
  function headRows(t) {
    const head = t.head.map(h => (Array.isArray(h) ? (h[1] ? `${h[0]} (${h[1]})` : h[0]) : h));
    const aoa = [];
    if (t.groups) aoa.push(t.groups.flatMap(([g, n]) => [g, ...Array(n - 1).fill("")]));
    aoa.push(head);
    return aoa;
  }

  $("sXlsx").addEventListener("click", () => {
    const D = S.result;
    if (!D) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, inputSheet(D), "Input");

    const calc = calcTable(D);
    const calcAoa = headRows(calc);
    for (const s of D.present) {
      const x = lc(s), i = D.init;
      calcAoa.push([s, i[`${x}_totage`], i[`${x}_bhage`], i[`${x}_y2bh`], D.obs(`topht_${x}`), i[`${x}_si_bh`],
                    i[`${x}_si_t`], D.obs(`n_${x}`), i[`${x}_den0`], i[`${x}_sdf`], i[`${x}_psi`]].map(v => (Number.isFinite(v) || typeof v === "string" ? v : "")));
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(calcAoa), "Calculated");

    const cu = culmination(D);
    const cuAoa = headRows(cu);
    for (const r of cu.values) cuAoa.push(r.map(v => (typeof v === "string" || Number.isFinite(v) ? v : "")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cuAoa), "MAI culmination");

    const y = yieldTable(D, "yield", 10);
    const yAoa = headRows(y);
    for (const r of y.rowIdx) yAoa.push(y.cols.map(k => (Number.isFinite(D.col[k][r]) ? D.col[k][r] : "")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yAoa), "Yield table");

    const t = yearlyTable(D);
    const pAoa = [t.names];
    for (let r = 0; r < D.len; r++) pAoa.push(t.columns.map(c => (Number.isFinite(c[r]) ? c[r] : "")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pAoa), "Projection");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${fileStem(D.label)}_gypsy.xlsx`);
    $("sExportMenu").open = false;
  });

  $("sCsv").addEventListener("click", () => {
    const D = S.result;
    if (!D) return;
    // Without stand_idx, toCSV labels row r with standLabels[r]
    download(GypsyAPI.toCSV(yearlyTable(D), Array(D.len).fill(D.label)), `${fileStem(D.label)}_yearly.csv`);
    $("sExportMenu").open = false;
  });

  $("sYieldCsv").addEventListener("click", () => {
    const D = S.result;
    if (!D) return;
    const y = yieldTable(D, $("sYieldKind").value, Number($("sYieldStep").value));
    const head = y.head.map(h => (h[1] ? `${h[0]} (${h[1]})` : h[0]));
    if (y.groups) {
      const g = y.groups.flatMap(([name, n]) => Array(n).fill(name));
      for (let j = 0; j < head.length; j++) if (g[j]) head[j] = `${g[j]}: ${head[j]}`;
    }
    const quote = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const lines = [head.map(quote).join(",")];
    for (const r of y.rowIdx) lines.push(y.cols.map(k => (Number.isFinite(D.col[k][r]) ? String(D.col[k][r]) : "")).join(","));
    download(lines.join("\n") + "\n", `${fileStem(D.label)}_yield_table.csv`);
  });

  // Printable report: stand, inputs, calculated attributes, culmination,
  // charts and the 10-year yield table
  $("sPrint").addEventListener("click", () => {
    const D = S.result;
    if (!D) return;
    $("sExportMenu").open = false;
    const r = $("printReport");
    r.innerHTML = "";
    const h = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; r.appendChild(e); return e; };
    h("h1", `GYPSY yield table report: ${D.label}`);
    h("p", [$("sSummaryInfo").textContent, `Printed ${new Date().toLocaleDateString()}`, $("buildInfo").textContent].join(" · "), "small");

    h("h2", "Input data");
    const f = D.form;
    const util = utilOptions(f);
    r.appendChild(makeTable(["Species", AGE_KINDS[S.kinds.age], HT_KINDS[S.kinds.ht], DEN_KINDS[S.kinds.n], "Percent stocking (%)", "Basal area (m²/ha)", "Utilization (DOB/DIB/stump)"],
      D.present.map(s => [s, ...FIELDS.map(x => f.spp[s][x.key] ?? "–"),
                          `${util.stumpDob[SPECIES.indexOf(s)]} cm / ${util.topDib[SPECIES.indexOf(s)]} cm / ${util.stumpHt[SPECIES.indexOf(s)]} m`])));
    h("h2", "Calculated attributes");
    const calc = calcTable(D);
    r.appendChild(makeTable(calc.head, calc.rows));
    h("h2", "Merchantable MAI culmination");
    const cu = culmination(D);
    r.appendChild(makeTable(cu.head, cu.rows));
    h("p", cu.note, "small");

    h("h2", "Charts");
    const grid = document.createElement("div");
    grid.className = "print-charts";
    r.appendChild(grid);
    for (const spec of chartSpecs(D)) {
      const c = document.createElement("div");
      grid.appendChild(c);
      GypsyChart.line(c, { ...spec, height: 220 });
    }
    h("h2", `Yield table for ${D.label}`, "page-break");
    const y = yieldTable(D, "yield", 10);
    r.appendChild(makeTable(y.head, y.rows, { groups: y.groups }));
    setTimeout(() => window.print(), 50);
  });
  window.addEventListener("afterprint", () => { $("printReport").innerHTML = ""; });

  // ---- Events ------------------------------------------------------------------------
  let timer;
  function changed() {
    store.set("single", JSON.stringify(formState()));
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (S.live && S.gypsy) runStand();
      else showChecks(check());
    }, 350);
  }
  $("s-input").addEventListener("input", changed);
  $("s-input").addEventListener("change", e => { if (e.target.type === "checkbox" || e.target.tagName === "SELECT") changed(); });

  $("sRun").addEventListener("click", () => {
    if (runStand()) {
      if (!S.live) selectTab("s-summary");
      S.live = true;
    } else selectTab("s-input");
  });
  $("sExample").addEventListener("click", () => { setForm(EXAMPLE); changed(); });
  $("sClear").addEventListener("click", () => {
    if (!confirm("Clear the stand inputs?")) return;
    setForm({});
    S.result = null;
    S.live = false;
    $("sMessages").innerHTML = "";
    markStale(false);
    showChecks([]);
    $("sStatus").textContent = "Ready";
    store.set("single", "");
  });
  $("sQuickChart").addEventListener("change", renderQuick);
  $("sYieldKind").addEventListener("change", renderYield);
  $("sYieldStep").addEventListener("change", renderYield);
  // Close the export menu when clicking elsewhere
  document.addEventListener("click", e => { if (!e.target.closest("#sExportMenu")) $("sExportMenu").open = false; });

  buildForm();
  try { const saved = JSON.parse(store.get("single") || "null"); if (saved) setForm(saved); } catch (e) { /* ignore */ }

  GypsyUI.model.then(m => {
    S.gypsy = m;
    $("sRun").disabled = false;
    $("sStatus").textContent = "Ready";
  }).catch(e => { $("sStatus").textContent = "Could not load the model: " + e; });
})();
