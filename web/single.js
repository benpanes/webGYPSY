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
//
// Tree improvement (an improved seedlot): SW and PL site index is raised for
// genetic worth at a selection age (Luo and Thomas 2021). Up to three
// genetic worth scenarios are projected, with the unimproved stand always
// projected too. Charts overlap them; each table, the Charts tab and the
// exports have their own scenario menu.
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
  const TI_SPP = ["SW", "PL"];   // species with age-age correlations
  const SCENARIOS = [1, 2, 3, 4, 5];   // most scenarios; S.tiCount are shown
  const TI_DEFAULT = 3;
  const TI_FIELDS = [
    ...SCENARIOS.map(k => ({ key: `gw${k}`, gw: k, label: `GW ${k}`, aria: `GW ${k} genetic worth (%)`, step: "0.1" })),
    { key: "selAge", label: "Selection age (years)", aria: "selection age (years)", step: "1", def: "15" },
  ];
  const TI_WARN = "Tree improvement runs must use site index, or age and top height, from unimproved stands. " +
                  "If the inputs were measured in a stand grown from improved seed, its genetic gain is already in them: " +
                  "disable tree improvement and run the stand normally.";
  const TI_NOTE = "Site index at total age 50 is raised by genetic worth × the age-age correlation between the selection " +
                  "age and age 50 (adjusted Lambeth equations, Luo and Thomas 2021); breast height site index follows from it.";
  const X_LABEL = "Stand age (years)";

  // Example stands (Load example menu): each shows a different way in
  const EXAMPLES = [
    { label: "Aspen and white spruce mixedwood", note: "Top height, density, stocking and basal area", form: {
      id: "Example mixedwood", standAge: "48", projectTo: "250", psflag: true, baflag: true,
      kinds: { age: "T", ht: "ht", n: "n" },
      spp: { AW: { age: "48", ht: "19.8", n: "1100", ps: "70", ba: "21.5" },
             SW: { age: "31", ht: "9.6",  n: "450",  ps: "25", ba: "4.1" } } } },
    { label: "Pure aspen", note: "A young deciduous stand", form: {
      id: "Example aspen", standAge: "", projectTo: "200", psflag: true, baflag: true,
      kinds: { age: "T", ht: "ht", n: "n" },
      spp: { AW: { age: "30", ht: "13.5", n: "2600", ps: "85", ba: "16" } } } },
    { label: "Black spruce", note: "Initial density (N0) instead of density", form: {
      id: "Example black spruce", standAge: "", projectTo: "250", psflag: true, baflag: true,
      kinds: { age: "T", ht: "ht", n: "n0" },
      spp: { SB: { age: "70", ht: "11.5", n: "3500", ps: "75", ba: "24" } } } },
    { label: "Lodgepole pine plantation", note: "Site index at breast height age 50, no stocking or basal area", form: {
      id: "Example pine plantation", standAge: "", projectTo: "150", psflag: false, baflag: false,
      kinds: { age: "T", ht: "siB", n: "n" },
      spp: { PL: { age: "12", ht: "18", n: "2000" } } } },
    { label: "Improved white spruce plantation", note: "Tree improvement: three genetic worth scenarios", form: {
      id: "Example improved spruce", standAge: "", projectTo: "200", psflag: false, baflag: false,
      kinds: { age: "T", ht: "siB", n: "n" },
      spp: { SW: { age: "15", ht: "17", n: "1600" } },
      ti: true, tiv: { SW: { gw1: "5", gw2: "10", gw3: "15", selAge: "15" } } } },
  ];

  // Stand total charts (the chart under the results, and the Charts tab)
  const GROUPS = [["con", "Conifer", 3], ["dec", "Deciduous", 1], ["all", "Total", 2]];
  const GROUP_MEASURES = [
    ["mvol_",   "Merchantable volume", "m³/ha"],
    ["mai_sa_", "Merchantable MAI (stand age)", "m³/ha/yr"],
    ["tvol_",   "Total volume", "m³/ha"],
  ];

  const S = {
    gypsy: null,
    kinds: { age: "T", ht: "ht", n: "n" },
    result: null,      // last successful run (see derive())
    live: false,       // after the first run, re-run as inputs change
    tiCount: TI_DEFAULT,   // scenario columns on the tree improvement card
    set: null,         // projections of the last run: unimproved, then scenarios
    // Projection shown on each card, by name; "all" overlaps them (charts)
    pick: { sum: null, culm: null, yield: null, chart: "all", export: null },
    groupsShown: new Set(["con", "dec"]),   // chart under the results
    scenariosHidden: new Set(),             //   (scenario names)
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
    hr.appendChild(document.createElement("th"));   // above the clear buttons
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
      const clear = GypsyUI.button("Clear", () => { clearSpecies([s]); $(`s_${FIELDS[0].key}_${s}`).focus(); }, "link");
      clear.type = "button";
      clear.setAttribute("aria-label", `Clear ${SPP_NAMES[s]}`);
      tr.insertCell().appendChild(clear);
    }

    const ti = $("sTiTable");
    const tig = ti.createTHead().insertRow();
    for (const text of ["", "Genetic worth (%)", null, ""]) {
      const th = document.createElement("th");
      if (text === null) {   // above the gap before selection age
        th.className = "ti-gap";
        th.appendChild($("sTiAdd"));
      } else th.textContent = text;
      tig.appendChild(th);
    }
    const tih = ti.tHead.insertRow();
    for (const x of [{ label: "Species" }, ...TI_FIELDS]) {
      if (x.key === "selAge") tih.appendChild(Object.assign(document.createElement("th"), { className: "ti-gap" }));
      const th = document.createElement("th");
      th.textContent = x.label;
      if (x.gw) {
        th.dataset.gw = x.gw;
        const del = GypsyUI.button("×", () => removeScenario(x.gw), "link");
        del.type = "button";
        del.className = "link gw-del";
        del.setAttribute("aria-label", `Remove GW ${x.gw}`);
        del.title = `Remove GW ${x.gw}`;
        th.appendChild(del);
      }
      tih.appendChild(th);
    }
    const tib = ti.createTBody();
    for (const s of TI_SPP) {
      const tr = tib.insertRow();
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = s;
      th.title = SPP_NAMES[s];
      tr.appendChild(th);
      for (const x of TI_FIELDS) {
        if (x.key === "selAge") tr.insertCell().className = "ti-gap";
        const inp = document.createElement("input");
        Object.assign(inp, { type: "number", step: x.step, min: "0", id: `s_${x.key}_${s}` });
        inp.setAttribute("aria-label", `${SPP_NAMES[s]}, ${x.aria}`);
        const td = tr.insertCell();
        if (x.gw) td.dataset.gw = x.gw;
        td.appendChild(inp);
      }
    }

    for (const x of UTIL) {
      const l = document.createElement("label");
      l.className = "field";
      const inp = document.createElement("input");
      Object.assign(inp, { type: "number", step: x.step, min: "0", placeholder: String(x.def), id: `s_${x.key}_all` });
      l.append(x.label, inp);
      $("sUtilAll").appendChild(l);
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
      id: $("sStandId").value, standAge: $("sStandAge").value,
      projectTo: $("sProjectTo").value, psflag: $("sPsflag").checked, baflag: $("sBaflag").checked,
      kinds: { ...S.kinds }, spp: {}, util: {}, utilAll: {}, utilBySpp: utilSpp(),
      ti: !$("sTiCard").hidden, tiv: {}, tiCount: S.tiCount,
    };
    for (const x of UTIL) if ($(`s_${x.key}_all`).value !== "") o.utilAll[x.key] = $(`s_${x.key}_all`).value;
    for (const s of TI_SPP) {
      const t = {};
      for (const x of TI_FIELDS) if ($(`s_${x.key}_${s}`).value !== "") t[x.key] = $(`s_${x.key}_${s}`).value;
      if (Object.keys(t).length) o.tiv[s] = t;
    }
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
    for (const x of UTIL) $(`s_${x.key}_all`).value = o.utilAll?.[x.key] ?? "";
    // Forms saved before the switch had only species limits
    setUtilSpp(o.utilBySpp ?? Object.keys(o.util || {}).length > 0);
    for (const s of TI_SPP) {
      const t = { ...o.tiv?.[s] };
      if (t.gw != null && t.gw1 == null) t.gw1 = t.gw;   // saved before scenarios
      for (const x of TI_FIELDS) $(`s_${x.key}_${s}`).value = t[x.key] ?? x.def ?? "";
    }
    S.tiCount = o.tiCount ?? Math.max(TI_DEFAULT, ...SCENARIOS.filter(k => TI_SPP.some(s => $(`s_gw${k}_${s}`).value !== "")));
    tiColumns();
    showTi(!!o.ti);
  }

  // Utilization limits: universal (one set for every species) or
  // species-specific (a set per species; blank cells use the universal
  // limits, shown greyed)
  const utilSpp = () => $("sUtilMode").querySelector('[data-util="spp"]').getAttribute("aria-checked") === "true";
  function setUtilSpp(on) {
    for (const b of $("sUtilMode").querySelectorAll("[data-util]"))
      b.setAttribute("aria-checked", (b.dataset.util === "spp") === on);
    utilBySpp();
  }
  function utilBySpp() {
    const on = utilSpp();
    $("sUtil").hidden = !on;
    $("sUtilAll").hidden = on;
    $("sUtilHint").textContent = on
      ? "Blank cells use the universal limits, shown greyed."
      : "Apply to every species. Blank boxes use the defaults shown.";
    for (const x of UTIL) {
      const shared = $(`s_${x.key}_all`).value || String(x.def);
      for (const s of SPECIES) $(`s_${x.key}_${s}`).placeholder = shared;
    }
  }

  // The tree improvement card: shown, the stand is an improved seedlot;
  // hidden, it is projected unimproved (entries are kept)
  function showTi(on) {
    $("sTiCard").hidden = !on;
    $("sTiShow").hidden = on;
    $("sTiShow").setAttribute("aria-expanded", on);
    selAgeEnabled();
  }

  // Show S.tiCount scenario columns
  function tiColumns() {
    for (const el of document.querySelectorAll("#sTiTable [data-gw]")) el.hidden = Number(el.dataset.gw) > S.tiCount;
    $("sTiTable").tHead.rows[0].cells[1].colSpan = S.tiCount;
    for (const b of document.querySelectorAll("#sTiTable .gw-del")) b.hidden = S.tiCount < 2;
    $("sTiAdd").disabled = S.tiCount >= SCENARIOS.length;
  }

  // Remove a scenario: later ones move left to keep GW 1, 2, ... in order
  function removeScenario(k) {
    for (const s of TI_SPP) {
      for (let j = k; j < SCENARIOS.length; j++) $(`s_gw${j}_${s}`).value = $(`s_gw${j + 1}_${s}`).value;
      $(`s_gw${SCENARIOS.length}_${s}`).value = "";
    }
    S.tiCount--;
    tiColumns();
    selAgeEnabled();
    changed();
  }

  // Selection age only applies once a genetic worth is entered
  function selAgeEnabled() {
    for (const s of TI_SPP) $(`s_selAge_${s}`).disabled = SCENARIOS.every(k => $(`s_gw${k}_${s}`).value === "");
  }

  // Projections: unimproved (k 0), then each scenario with a genetic worth
  // for a species in the stand
  function scenarioList(o) {
    const list = [{ k: 0, name: o.ti ? "Unimproved" : "" }];
    if (!o.ti) return list;
    for (const k of SCENARIOS)
      if (TI_SPP.some(s => { const g = Number(o.tiv[s]?.[`gw${k}`]); return isPresent(o, s) && Number.isFinite(g) && g !== 0; }))
        list.push({ k, name: `GW ${k}` });
    return list;
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

    if (!$("sTiCard").hidden) {
      add("sTiCard", "warn", TI_WARN);
      let improved = 0;
      for (const s of TI_SPP) {
        const id = k => `s_${k}_${s}`;
        const sel = val(id("selAge"));
        const inStand = FIELDS.some(f => $(`s_${f.key}_${s}`).value !== "");
        const gws = SCENARIOS.map(k => {
          const gw = val(id(`gw${k}`));
          if (gw === "bad") add(id(`gw${k}`), "err", `${sppLabel(s)}: GW ${k} is not a number.`);
          else if (inStand && (gw < 0 || gw > 30)) add(id(`gw${k}`), "warn", `${sppLabel(s)}: GW ${k} is usually between 0 and 30%.`);
          return gw;
        });
        if (sel === "bad") add(id("selAge"), "err", `${sppLabel(s)}: selection age is not a number.`);
        const any = gws.some(g => Number.isFinite(g) && g !== 0);
        if (!inStand) {
          if (gws.some(Number.isFinite)) add(id("gw1"), "warn", `${sppLabel(s)}: genetic worth is given but ${s} is not in the stand.`);
          continue;
        }
        if (!gws.some(g => Number.isFinite(g) || g === "bad")) {
          add(id("gw1"), "warn", `${sppLabel(s)}: no genetic worth given; projected unimproved in every scenario.`);
          continue;
        }
        if (any) {
          improved++;
          if (!Number.isFinite(sel) && sel !== "bad") add(id("selAge"), "err", `${sppLabel(s)}: selection age is needed with a genetic worth.`);
          else if (sel <= 0) add(id("selAge"), "err", `${sppLabel(s)}: selection age must be more than 0.`);
          else if (sel > 50) add(id("selAge"), "warn", `${sppLabel(s)}: selection age is over 50, the site index age.`);
        }
      }
      if (!improved && present) add("s_gw1_SW", "warn", "Tree improvement is open, but no scenario has a genetic worth for SW or PL in the stand; only the unimproved stand is projected.");
    }

    // Shared limits, then each species' (only while switched on)
    const shared = {};
    for (const who of ["all", ...(utilSpp() ? SPECIES : [])]) {
      const name = who === "all" ? "Utilization" : `${who} utilization`;
      const u = {};
      for (const x of UTIL) {
        u[x.key] = val(`s_${x.key}_${who}`);
        if (u[x.key] === "bad") add(`s_${x.key}_${who}`, "err", `${name}: not a number.`);
        else if (Number.isNaN(u[x.key])) u[x.key] = who === "all" ? x.def : shared[x.key];
      }
      if (who === "all") Object.assign(shared, u);
      if (u.stumpDob <= u.topDib) add(`s_stumpDob_${who}`, "err", `${name}: stump DOB must be more than top DIB.`);
      if (u.stumpHt < 0.1 || u.stumpHt > 0.3) add(`s_stumpHt_${who}`, "err", `${name}: stump height must be between 0.1 and 0.3 m.`);
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
    $("sChecks").innerHTML = $("sTiChecks").innerHTML = "";
    for (const c of list) {
      const el = $(c.id);
      const holder = el.closest("td") || el.closest(".field");
      if (holder && !(holder.classList.contains("err"))) {
        holder.classList.remove("warn");
        holder.classList.add(c.level);
      }
      // Input boxes only: their titles are cleared on each check above
      if (el.tagName === "INPUT") el.title = (el.title ? el.title + "\n" : "") + c.text;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "check-item " + c.level;
      b.textContent = (c.level === "err" ? "Error: " : "Check: ") + c.text;
      b.addEventListener("click", () => { selectTab("s-input"); el.focus(); });
      // Tree improvement's own checks go on its card
      $(el.closest("#sTiCard") ? "sTiChecks" : "sChecks").appendChild(b);
    }
  }

  // ---- Running ---------------------------------------------------------------------
  const isPresent = (o, s) => !!o.spp[s];

  // k: tree improvement scenario (0 unimproved)
  function modelInput(o, standAge, nOverride = {}, k = 0) {
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
        // In a scenario, a missing SW or PL genetic worth is 0
        gw:      present.map(s => (k && TI_SPP.includes(s) ? (o.tiv[s]?.[`gw${k}`] != null ? Number(o.tiv[s][`gw${k}`]) : 0) : NaN)),
        sel_age: present.map(s => (k && TI_SPP.includes(s) ? num(o.tiv[s]?.selAge) : NaN)),
      },
    };
  }

  function utilOptions(o) {
    const out = {};
    for (const x of UTIL) {
      const shared = o.utilAll?.[x.key] != null ? Number(o.utilAll[x.key]) : x.def;
      out[x.key] = SPECIES.map(s => (o.utilBySpp && o.util[s]?.[x.key] != null ? Number(o.util[s][x.key]) : shared));
    }
    return out;
  }

  const initValues = res => Object.fromEntries(res.init.names.map((n, k) => [n, res.init.columns[k][0]]));

  // Observed densities that give the entered initial densities (N0): each
  // species in turn by bisection on the log of density, repeated until no
  // density changes (the conifers' N0 also depends on aspen density).
  // Observed density is at most N0; very low densities give no N0, which
  // counts as too low.
  function solveN0(o, opts, k = 0) {
    const target = {};
    for (const s of SPECIES) if (isPresent(o, s)) target[s] = Number(o.spp[s].n);
    const n = { ...target };
    const den0 = s => initValues(GypsyAPI.run(S.gypsy, modelInput(o, 100, n, k).input, { ...opts, simlen: 1, ti: k > 0 }))[`${lc(s)}_den0`];
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
      // (tree improvement doesn't change it)
      const first = GypsyAPI.run(S.gypsy, modelInput(o, 100, nObs).input, { ...opts, simlen: 1 });
      const i0 = initValues(first);
      const tmax = i0.totage_max;
      if (!Number.isFinite(tmax)) throw new Error("No total age could be determined for the stand.");
      const standAge = o.standAge !== "" ? Number(o.standAge) : Math.ceil(tmax - 1e-9);
      const to = Number(o.projectTo);
      // Stand age in year k (1-based) is totage_0 + k - 1 + (stand age - leading age)
      const simlen = Math.max(1, Math.ceil(to - (standAge - tmax) - i0.totage_0 + 1 + 1e-9));
      // Unimproved, then each tree improvement scenario
      const warnings = new Set();
      const set = scenarioList(o).map(sc => {
        const n = sc.k && S.kinds.n === "n0" ? solveN0(o, opts, sc.k) : nObs;
        const { present, input } = modelInput(o, standAge, n, sc.k);
        const res = GypsyAPI.run(S.gypsy, input, { ...opts, simlen, ti: sc.k > 0 });
        for (const w of res.warnings) warnings.add(w);
        return Object.assign(derive(o, present, standAge, tmax, to, res, n), { scenario: sc });
      });
      for (const D of set) {
        D.set = set;
        if (sc(D)) D.label += ` – ${sc(D)}`;
      }
      const ms = performance.now() - t0;

      const after = checkAfter(set[0]);
      showChecks([...list, ...after]);
      if (after.some(c => c.level === "err")) {
        $("sStatus").textContent = "Fix the errors in the Stand tab to run";
        markStale(true);
        return false;
      }
      for (const w of warnings) message("sMessages", w, "warn");
      S.set = set;
      markStale(false);
      fillScenarios();
      render();
      $("sStatus").textContent = `Projected ${set.length > 1 ? set.length + " scenarios " : ""}to stand age ${to} in ${ms < 1000 ? ms.toFixed(0) + " ms" : (ms / 1000).toFixed(1) + " s"}`;
      return true;
    } catch (e) {
      message("sMessages", e.message, "err");
      $("sStatus").textContent = "Stopped with an error";
      markStale(true);
      return false;
    }
  }

  // Name of a result's scenario ("" without tree improvement)
  const sc = D => D.scenario.name;

  // The projection a card shows: its pick if that is still there, else the
  // first scenario. Charts can show all ("all": returns null).
  function picked(card) {
    const set = S.set;
    if (card === "chart" && S.pick.chart === "all") return null;
    return set.find(D => sc(D) === S.pick[card]) || set[Math.min(1, set.length - 1)];
  }

  // Scenario menus on the cards they affect, shown with more than one
  // projection
  function fillScenarios() {
    const set = S.set || [];
    for (const sel of document.querySelectorAll("#mode-single select[data-pick]")) {
      const card = sel.dataset.pick;
      sel.innerHTML = "";
      if (card === "chart") sel.add(new Option("All, overlapped", "all"));
      for (const D of set) sel.add(new Option(gwLabel(D), sc(D)));
      if (set.length) sel.value = card === "chart" && S.pick.chart === "all" ? "all" : sc(picked(card));
      sel.closest(".scenario-pick").hidden = set.length < 2;
    }
  }

  // A species' genetic worth in a scenario, e.g. "10%"
  const gwPct = (D, s) => `${Number((D.init[`${lc(s)}_gw`] || 0).toFixed(2))}%`;

  // " (SW 10%, PL 5%)" for a scenario
  function scenarioGw(D) {
    if (!D.scenario.k) return "";
    const parts = D.improved.map(s => `${s} ${gwPct(D, s)}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  // Chart label for a projection: "Unimproved", or species and genetic
  // worth: "SW 10%, PL 5%", or "SW 10%" for one species s
  function gwLabel(D, s) {
    if (!D.scenario.k) return sc(D);
    return (s ? [s] : D.improved).map(x => `${x} ${gwPct(D, x)}`).join(", ");
  }

  function markStale(stale) {
    const has = !!S.set;
    for (const id of ["s-yield", "s-charts"]) enableTab(id, has);
    $("sResults").hidden = !has;
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
    // Species whose site index was adjusted
    const improved = present.filter(s => TI_SPP.includes(s) && Number.isFinite(init[`${lc(s)}_gw`]) && init[`${lc(s)}_gw`] !== 0);
    return { form, present, standAge, tmax, to, res, col, len, init, obs, nObs, groups, improved,
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

  // Tree improvement: genetic worth, age-age correlation and site index
  // before and after, one row per improved species
  function tiTable(D) {
    const head = ["Species", ["Genetic worth", "%"], ["Selection age", "years"], ["Age-age correlation", ""],
                  ["SI, BH age 50, unimproved", "m"], ["SI, BH age 50, improved", "m"],
                  ["SI, total age 50, unimproved", "m"], ["SI, total age 50, improved", "m"]];
    const values = D.improved.map(s => {
      const x = lc(s), i = D.init;
      return [s, i[`${x}_gw`], i[`${x}_sel_age`], i[`${x}_aacor`], i[`${x}_si_bh_base`], i[`${x}_si_bh`], i[`${x}_si_t_base`], i[`${x}_si_t`]];
    });
    const digits = [null, 1, 0, 3, 2, 2, 2, 2];
    return { head, values, rows: values.map(r => r.map((v, j) => (j ? fmt(v, digits[j]) : `${v} – ${SPP_NAMES[v]}`))) };
  }

  // Total merchantable MAI culmination (stand age), and the volume there
  function totalCulmination(D) {
    const m = D.col.mai_sa_all;
    let k = -1;
    for (let r = 0; r < m.length; r++) if (Number.isFinite(m[r]) && (k < 0 || m[r] > m[k])) k = r;
    return k < 0 ? { mai: NaN, age: NaN, vol: NaN } : { mai: m[k], age: D.col.standage[k], vol: D.col.mvol_all[k] };
  }

  // One row per projection: genetic worth and SI of the tree improvement
  // species, total MAI culmination, and the gain over unimproved
  function scenarioTable(set) {
    const spp = TI_SPP.filter(s => set[0].present.includes(s));
    const base = totalCulmination(set[0]);
    const end = D => D.col.mvol_all[D.len - 1];
    const head = ["", ...spp.map(s => [`${s} genetic worth`, "%"]), ...spp.map(s => [`${s} SI, BH age 50`, "m"]),
                  ["Total MAI culmination", "m³/ha/yr"], ["at stand age", "years"], ["Merch. vol. there", "m³/ha"],
                  ["MAI gain", "%"], [`Merch. vol. at age ${fmt(set[0].col.standage[set[0].len - 1], 0)}`, "m³/ha"]];
    const values = set.map(D => {
      const c = totalCulmination(D);
      return [sc(D), ...spp.map(s => (D.scenario.k ? (D.init[`${lc(s)}_gw`] || 0) : NaN)), ...spp.map(s => D.init[`${lc(s)}_si_bh`]),
              c.mai, c.age, c.vol, D.scenario.k ? 100 * (c.mai / base.mai - 1) : NaN, end(D)];
    });
    const digits = [null, ...spp.map(() => 1), ...spp.map(() => 2), 3, 0, 1, 1, 1];
    return { head, values, rows: values.map(r => r.map((v, j) => (j ? (Number.isFinite(v) ? fmt(v, digits[j]) : "–") : v))) };
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
  // Stand totals for the groups given, every projection overlapped. One
  // projection: coloured by group. Several (tree improvement): coloured by
  // projection, dashed by group.
  function groupChart(D, prefix, label, unit, groups, set = [D]) {
    const many = set.length > 1;
    const series = [];
    for (const E of set) {
      const i = D.set.indexOf(E);
      for (const [g, name, slot] of GROUPS.filter(([g]) => groups.includes(g)))
        series.push({ label: many ? `${name} – ${gwLabel(E)}` : name, slot: many ? i + 1 : slot,
                      dash: many ? ["con", "dec", "all"].indexOf(g) : 0, x: E.col.standage, y: E.col[prefix + g] });
    }
    return { key: prefix + "group", title: label, yLabel: `${label.replace(/ \(.*\)$/, "")} (${unit})`, series, xLabel: X_LABEL };
  }

  // Groups in the stand: conifer and deciduous when both are there (alone,
  // either is the same as the total)
  const standGroups = D => (D.groups.con && D.groups.dec ? ["all", "con", "dec"] : ["all"]);

  // Charts, as in the Excel tool's report, for the projections in set
  // (overlapped when there are several: species improved in some scenario
  // get a line per projection, dashed by projection)
  function chartSpecs(set) {
    const D = set[0], many = set.length > 1;
    const bySpp = (prefix, label, unit) => ({
      key: prefix.replace(/_$/, ""), title: prefix === "sc_" ? label : `${label} by species`, yLabel: `${label} (${unit})`,
      series: D.present.flatMap(s => {
        const improved = many && set.some(E => E.improved.includes(s));
        return (improved ? set : [D]).map(E => ({
          label: !improved ? s : E.scenario.k ? gwLabel(E, s) : `${s} – ${sc(E)}`, slot: SPECIES.indexOf(s) + 1, dash: improved ? D.set.indexOf(E) : 0,
          x: E.col.standage, y: E.col[prefix + lc(s)] }));
      }),
    });
    return [
      ...GROUP_MEASURES.map(([p, label, unit]) => groupChart(D, p, label, unit, standGroups(D), set)),
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

  function render() {
    renderSummary();
    renderCulm();
    renderYield();
    const q = $("sQuickChart"), keep = q.value || GROUP_MEASURES[0][0];
    q.innerHTML = "";
    for (const [p, label] of GROUP_MEASURES) q.add(new Option(label, p));
    q.value = keep;
    renderQuickPick();
    renderQuick();
    renderCharts();
  }

  function renderSummary() {
    const D = picked("sum");
    $("sSummaryTitle").textContent = D.label;
    const info = [`Stand age ${fmt(D.standAge, 0)}${D.form.standAge === "" ? ` (from the oldest species' total age, ${fmt(D.tmax, 1)})` : ""}`];
    info.push(`Percent stocking ${D.form.psflag ? "used" : "not used"}`, `BA adjustment ${D.form.baflag ? "on" : "off"}`);
    if (D.form.ti) info.push(D.scenario.k ? `Tree improvement ${sc(D)}${scenarioGw(D)}` : "Unimproved (tree improvement comparison)");
    $("sSummaryInfo").textContent = info.join(" · ");

    const calc = calcTable(D);
    $("sCalc").replaceWith(Object.assign(makeTable(calc.head, calc.rows), { id: "sCalc" }));
    $("sTiBox").hidden = !D.improved.length;
    if (D.improved.length) {
      const ti = tiTable(D);
      $("sTiCalc").replaceWith(Object.assign(makeTable(ti.head, ti.rows), { id: "sTiCalc" }));
      $("sTiNote").textContent = TI_NOTE;
    }
    $("sScenBox").hidden = D.set.length < 2;
    if (D.set.length > 1) {
      const st = scenarioTable(D.set);
      $("sScenCalc").replaceWith(Object.assign(makeTable(st.head, st.rows), { id: "sScenCalc" }));
      $("sScenNote").textContent = "MAI gain is over the unimproved stand's total MAI culmination.";
    }
  }

  function renderCulm() {
    const cu = culmination(picked("culm"));
    $("sCulm").replaceWith(Object.assign(makeTable(cu.head, cu.rows), { id: "sCulm" }));
    $("sCulmNote").textContent = cu.note;
  }

  function renderYield() {
    if (!S.set) return;
    const D = picked("yield");
    const y = yieldTable(D, $("sYieldKind").value, Number($("sYieldStep").value));
    $("sYield").replaceWith(Object.assign(makeTable(y.head, y.rows, { groups: y.groups }), { id: "sYield" }));
    $("sYieldTitle").textContent = `Yield table for ${D.label}`;
    $("sYieldNote").textContent = $("sYieldKind").value === "yield"
      ? "MAI is merchantable volume over stand age. Piece size is merchantable stems per cubic metre of merchantable volume."
      : "Merchantable MAI by species is over the species' total age.";
  }

  // Chart under the results: tick boxes for conifer, deciduous and total,
  // and for each projection
  function renderQuickPick() {
    const D = S.set[0], box = $("sQuickPick");
    box.innerHTML = "";
    const column = () => box.appendChild(Object.assign(document.createElement("div"), { className: "pick-col" }));
    const totals = column();
    for (const [g, name] of GROUPS) {
      const there = g === "all" || D.groups[g];
      totals.appendChild(GypsyUI.checkbox(name, there && S.groupsShown.has(g), on => {
        if (on) S.groupsShown.add(g); else S.groupsShown.delete(g);
        renderQuick();
      }, !there));
    }
    if (D.set.length < 2) return;
    const scenarios = column();
    for (const E of D.set) {
      scenarios.appendChild(GypsyUI.checkbox(gwLabel(E), !S.scenariosHidden.has(sc(E)), on => {
        if (on) S.scenariosHidden.delete(sc(E)); else S.scenariosHidden.add(sc(E));
        renderQuick();
      }));
    }
  }

  const QUICK_HEIGHT = 300;
  function renderQuick() {
    if (!S.set) return;
    const D = S.set[0];
    const [p, label, unit] = GROUP_MEASURES.find(m => m[0] === $("sQuickChart").value);
    const groups = GROUPS.map(([g]) => g).filter(g => (g === "all" || D.groups[g]) && S.groupsShown.has(g));
    const spec = groupChart(D, p, label, unit, groups, D.set.filter(E => !S.scenariosHidden.has(sc(E))));
    GypsyChart.line($("sQuickBox"), { ...spec, height: QUICK_HEIGHT });
  }

  function renderCharts() {
    const box = $("sCharts");
    box.innerHTML = "";
    if (!S.set) return;
    const one = picked("chart"), D = one || S.set[0];
    for (const spec of chartSpecs(one ? [one] : S.set)) {
      const panel = document.createElement("div");
      panel.className = "chart-panel";
      const chartBox = document.createElement("div");
      let svg;
      panel.draw = () => { svg = GypsyChart.line(chartBox, { ...spec, height: 260 }); };
      const actions = document.createElement("div");
      actions.className = "chart-actions";
      const file = `${fileStem(one ? D.label : D.form.id.trim() || "New stand")}_${spec.key}.svg`;
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
      ["Stand ID", D.label], ["Stand age", D.standAge],
      ["Stand age from", f.standAge === "" ? "Oldest species' total age (rounded up)" : "Entered"],
      ["Project to stand age", D.to], ["Use percent stocking", f.psflag ? "YES" : "NO"],
      ["Adjust to observed basal area", f.baflag ? "YES" : "NO"], [],
      ["Species", AGE_KINDS[S.kinds.age], HT_KINDS[S.kinds.ht], DEN_KINDS[S.kinds.n], "Percent stocking (%)", "Basal area (m²/ha)"],
      ...SPECIES.map(s => [s, ...FIELDS.map(x => (f.spp[s]?.[x.key] != null ? Number(f.spp[s][x.key]) : ""))]), [],
      ["Species", ...UTIL.map(x => x.label)],
      ...SPECIES.map((s, i) => [s, ...UTIL.map(x => utilOptions(f)[x.key][i])]), [],
      ["Tree improvement", f.ti ? "YES" : "NO"],
      ...(f.ti ? [["Species", ...SCENARIOS.slice(0, f.tiCount).map(k => `GW ${k} (%)`), "Selection age (years)"],
                  ...TI_SPP.map(s => [s, ...TI_FIELDS.filter(x => !x.gw || x.gw <= f.tiCount)
                                       .map(x => (f.tiv[s]?.[x.key] != null ? Number(f.tiv[s][x.key]) : ""))]),
                  ["Results in this workbook", sc(D)]] : []),
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
    if (!S.set) return;
    const D = picked("export");
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

    if (D.improved.length) {
      const ti = tiTable(D);
      const tiAoa = headRows(ti);
      for (const r of ti.values) tiAoa.push(r.map(v => (typeof v === "string" || Number.isFinite(v) ? v : "")));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tiAoa), "Tree improvement");
    }
    if (D.set.length > 1) {
      const st = scenarioTable(D.set);
      const stAoa = headRows(st);
      for (const r of st.values) stAoa.push(r.map(v => (typeof v === "string" || Number.isFinite(v) ? v : "")));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stAoa), "Scenarios");
    }

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
    if (!S.set) return;
    const D = picked("export");
    // Without stand_idx, toCSV labels row r with standLabels[r]
    download(GypsyAPI.toCSV(yearlyTable(D), Array(D.len).fill(D.label)), `${fileStem(D.label)}_yearly.csv`);
    $("sExportMenu").open = false;
  });

  $("sYieldCsv").addEventListener("click", () => {
    if (!S.set) return;
    const D = picked("yield");
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
    if (!S.set) return;
    const D = picked("export");
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
    if (D.improved.length) {
      h("h2", "Tree improvement");
      const ti = tiTable(D);
      r.appendChild(makeTable(ti.head, ti.rows));
      h("p", TI_NOTE, "small");
    }
    if (D.set.length > 1) {
      h("h2", "Scenario comparison");
      const st = scenarioTable(D.set);
      r.appendChild(makeTable(st.head, st.rows));
      h("p", "MAI gain is over the unimproved stand's total MAI culmination.", "small");
    }
    h("h2", "Merchantable MAI culmination");
    const cu = culmination(D);
    r.appendChild(makeTable(cu.head, cu.rows));
    h("p", cu.note, "small");

    h("h2", "Charts");
    const grid = document.createElement("div");
    grid.className = "print-charts";
    r.appendChild(grid);
    for (const spec of chartSpecs(S.set)) {   // every projection, for comparison
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
  // Spinner: on from an input change until the rerun is done, for long
  // enough to be seen (runs take milliseconds)
  const SPIN_MIN_MS = 400;
  let spinStart = 0, spinTimer;
  function spinOn() {
    clearTimeout(spinTimer);
    spinStart = spinStart || performance.now();
    $("sSpinner").classList.add("on");
  }
  function spinOff() {
    spinTimer = setTimeout(() => {
      $("sSpinner").classList.remove("on");
      spinStart = 0;
    }, Math.max(0, SPIN_MIN_MS - (performance.now() - spinStart)));
  }

  let timer;
  function changed() {
    store.set("single", JSON.stringify(formState()));
    clearTimeout(timer);
    const rerun = S.live && S.gypsy;
    if (rerun) spinOn();
    timer = setTimeout(() => {
      if (rerun) { runStand(); spinOff(); }
      else showChecks(check());
    }, 350);
  }
  // (the results' own controls, below the inputs, aren't input changes)
  const isInput = e => !e.target.closest("#sResults");
  $("s-input").addEventListener("input", e => { if (isInput(e)) changed(); });
  $("s-input").addEventListener("change", e => { if (isInput(e) && (e.target.type === "checkbox" || e.target.tagName === "SELECT")) changed(); });
  $("sTiTable").addEventListener("input", selAgeEnabled);
  $("sTiAdd").addEventListener("click", () => {
    S.tiCount++;
    tiColumns();
    changed();
    $(`s_gw${S.tiCount}_${TI_SPP[0]}`).focus();
  });
  $("sUtilMode").addEventListener("click", e => {
    const b = e.target.closest("[data-util]");
    if (!b || (b.dataset.util === "spp") === utilSpp()) return;
    setUtilSpp(b.dataset.util === "spp");
    changed();
  });
  $("sUtilAll").addEventListener("input", utilBySpp);
  $("sTiShow").addEventListener("click", () => {
    showTi(true);
    changed();
    $(`s_gw1_${TI_SPP[0]}`).focus();
  });
  $("sTiHide").addEventListener("click", () => {
    showTi(false);
    changed();
    $("sTiShow").focus();
  });

  $("sRun").addEventListener("click", () => {
    spinOn();
    const ok = runStand();
    spinOff();
    if (ok) {
      if (!S.live) $("sResults").scrollIntoView({ behavior: "smooth", block: "start" });
      S.live = true;
      $("sRun").disabled = true;   // results follow the inputs from here
    } else selectTab("s-input");
  });
  for (const ex of EXAMPLES) {
    const b = GypsyUI.button("", () => {
      setForm(ex.form);
      $("sExampleMenu").open = false;
      changed();
    }, "link");
    b.type = "button";
    b.append(Object.assign(document.createElement("span"), { textContent: ex.label }),
             Object.assign(document.createElement("span"), { className: "menu-note", textContent: ex.note }));
    $("sExampleList").appendChild(b);
  }
  // Empty species rows (results follow, as for any input change)
  function clearSpecies(list) {
    for (const s of list) for (const f of FIELDS) $(`s_${f.key}_${s}`).value = "";
    changed();
  }
  $("sClear").addEventListener("click", () => {
    if (confirm("Clear all four species rows?")) clearSpecies(SPECIES);
  });
  const RENDER = { sum: renderSummary, culm: renderCulm, yield: renderYield, chart: renderCharts, export: () => {} };
  for (const sel of document.querySelectorAll("#mode-single select[data-pick]"))
    sel.addEventListener("change", () => {
      S.pick[sel.dataset.pick] = sel.value;
      RENDER[sel.dataset.pick]();
    });
  $("sQuickChart").addEventListener("change", renderQuick);
  $("sYieldKind").addEventListener("change", renderYield);
  $("sYieldStep").addEventListener("change", renderYield);
  // Close the export menu when clicking elsewhere
  document.addEventListener("click", e => {
    for (const id of ["sExportMenu", "sExampleMenu"]) if (!e.target.closest("#" + id)) $(id).open = false;
  });

  buildForm();
  setForm({});
  try { const saved = JSON.parse(store.get("single") || "null"); if (saved) setForm(saved); } catch (e) { /* ignore */ }

  GypsyUI.model.then(m => {
    S.gypsy = m;
    $("sRun").disabled = false;
    $("sStatus").textContent = "Ready";
  }).catch(e => { $("sStatus").textContent = "Could not load the model: " + e; });
})();
