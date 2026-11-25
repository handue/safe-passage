// Wireframe scaffolding only (not app code): shared header, drill band,
// disclaimer, icons, and a schematic map. All values are SAMPLE DATA.
(function () {
  const body = document.body;
  const step = body.dataset.step || "";
  const steps = [
    ["address", "Address", "01-landing.html"],
    ["household", "Household", "02-household.html"],
    ["map", "Home map", "03-home-map.html"],
    ["drill", "Drill", "04-drill-setup.html"],
    ["fix", "Fix", "07-fix-plan.html"],
    ["plan", "Plan", "08-personal-plan.html"],
  ];

  const page = document.querySelector(".page");
  const header = document.createElement("header");
  header.className = "top";
  header.innerHTML =
    '<a class="brand" href="index.html">Safe Passage</a>' +
    '<nav aria-label="Progress"><ol class="steps">' +
    steps.map(([id, name, href]) =>
      `<li><a href="${href}"${id === step ? ' aria-current="step"' : ""}>${name}</a></li>`).join("") +
    "</ol></nav>" +
    '<div class="end"><span class="sample">SAMPLE DATA</span><a href="09-how-made.html">How this plan was made</a></div>';
  page.prepend(header);

  if (body.hasAttribute("data-drill")) {
    const band = document.createElement("div");
    band.className = "drillband";
    band.textContent = "DRILL · SIMULATED FIRE · NOT A LIVE ALERT";
    header.after(band);
  }

  const warn = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 22 21H2Z"/><path d="M12 10v5M12 18v.5"/></svg>';
  const foot = document.createElement("footer");
  foot.className = "disclaimer";
  foot.innerHTML = warn + "<p><b>Simplified model for practice only.</b> Do not use it for real emergency decisions. In a real fire, follow official alerts and local evacuation orders.</p>";
  page.append(foot);

  const icons = {
    warn,
    closed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M6 18 18 6"/></svg>',
    oneway: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 4v16M19 4v16M12 18V7M8 11l4-4 4 4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12.5 10 18 20 6"/></svg>',
  };
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icons[el.dataset.icon];
    const svg = el.firstElementChild;
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
  });

  // Schematic map. Modes: overview | setup | running | results | fix
  const road = (d, w = 7, c = "#a8a8a8") => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const label = (x, y, t, a = "middle") => `<text x="${x}" y="${y}" text-anchor="${a}">${t}</text>`;
  const primary = "M430 320 V400 L310 420 L190 470 L90 475 V560";
  const backup = "M430 320 V400 L560 412 L660 335 L720 190";

  function map(mode, i) {
    const hatch = `h${i}`;
    let s = `<svg viewBox="0 0 800 600" role="img" aria-label="Schematic map, sample data: home, two ways out, candidate destinations${mode === "overview" ? "" : ", simulated fire"}">`;
    s += `<defs><pattern id="${hatch}" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="#d0d0d0"/><rect width="4" height="10" fill="#4a4a4a"/></pattern></defs>`;
    // terrain contours
    [[170, 150, 150, 100], [170, 150, 100, 66], [170, 150, 52, 34], [640, 500, 130, 70]].forEach(([x, y, rx, ry]) => {
      s += `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="none" stroke="#c9c9c9" stroke-width="1.5"/>`;
    });
    // fire
    const stage = { running: 1, results: 2, fix: 2 }[mode];
    if (stage) {
      const shape = stage === 1
        ? "M130 130 C190 90 270 140 300 210 C340 270 330 340 270 345 C215 355 200 290 160 260 C110 225 90 160 130 130Z"
        : "M130 130 C200 85 300 140 340 220 C390 310 380 400 330 450 C275 500 215 450 225 380 C230 320 190 290 150 260 C100 220 90 160 130 130Z";
      s += `<path d="${shape}" fill="url(#${hatch})" stroke="#161616" stroke-width="3"/>`;
    }
    s += road("M90 40 V560", 12) + road(primary) + road(backup) + road("M430 320 L440 220 L520 150") + road("M310 420 L330 540");
    // routes
    if (mode !== "overview" && mode !== "setup") {
      if (mode === "fix") s += road(backup, 8, "#161616").replace('stroke-linecap="round"', 'stroke-dasharray="18 12"');
      if (mode === "running") s += road(primary, 9, "#161616");
      else {
        s += road(primary, 9, "#161616").replace('stroke-linecap="round"', 'stroke-dasharray="3 13" stroke-linecap="round"');
        s += `<g stroke="#161616" stroke-width="5"><circle cx="280" cy="428" r="17" fill="#fff"/><path d="M269 439 291 417"/></g>`;
        s += label(300, 520, "Creek Rd closes T+30", "start");
      }
    }
    if (stage) s += label(215, 215, "SIMULATED FIRE");
    // names
    s += label(100, 30, "Highway", "start") + label(150, 502, "Creek Rd") + label(585, 440, "Ridge Rd") + label(446, 368, "Willow Dr", "start");
    // home
    s += `<circle cx="430" cy="320" r="15" fill="#161616" stroke="#fff" stroke-width="4"/>` + label(450, 315, "Home", "start");
    // candidate destinations
    const dest = (x, y, n) => `<rect x="${x - 15}" y="${y - 15}" width="30" height="30" fill="#fff" stroke="#161616" stroke-width="3"/>` + `<text x="${x}" y="${y + 5}" text-anchor="middle">${n}</text>`;
    s += dest(90, 560, "D1") + dest(720, 185, "D2");
    s += label(115, 575, "School (candidate)", "start") + label(780, 155, "Hall (candidate)", "end");
    if (mode === "overview") s += label(250, 405, "Way out A") + label(640, 305, "Way out B", "end") + label(170, 70, "Slope rises NW");
    if (mode === "setup") {
      [[170, 160, "1", true], [330, 110, "2"], [620, 500, "3"]].forEach(([x, y, n, on]) => {
        s += `<circle cx="${x}" cy="${y}" r="20" fill="${on ? "#161616" : "#fff"}" stroke="#161616" stroke-width="3"/>`;
        s += `<text x="${x}" y="${y + 5}" text-anchor="middle">${n}</text>`;
      });
      s += label(170, 205, "Ignition point (selected)");
    }
    // wind
    s += `<g transform="translate(715 40)"><path d="M0 0 40 40M40 40V16M40 40H16" fill="none" stroke="#161616" stroke-width="5"/></g>`;
    s += label(780, 110, "Wind from NW 22 mph", "end");
    if (mode === "fix") s += label(780, 385, "Backup (dashed)", "end");
    if (mode === "running") s += label(200, 448, "Your route (solid)");
    s += label(780, 585, "Schematic · not real geography", "end");
    return s + "</svg>";
  }
  document.querySelectorAll("[data-map]").forEach((el, i) => {
    el.classList.add("map");
    el.innerHTML = map(el.dataset.map, i);
  });
})();
