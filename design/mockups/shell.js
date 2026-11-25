// Mockup scaffolding only (not app code): shared header, drill band,
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
    '<a class="brand" href="index.html"><svg class="mark" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="#122a36"/><path d="M8 22v-6l8-4V6" fill="none" stroke="#3ddcf5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="22" r="2.6" fill="#eef3f9"/><path d="M12.5 9.5 16 6l3.5 3.5" fill="none" stroke="#3ddcf5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>Safe Passage</a>' +
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
    pending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="3.5 3.5"><circle cx="12" cy="12" r="9"/></svg>',
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
  // The fire is drawn as the model's own grid cells.
  const path = (d, cls) => `<path d="${d}" class="${cls}"/>`;
  const label = (x, y, t, a = "middle", cls = "") => `<text x="${x}" y="${y}" text-anchor="${a}" class="${cls}">${t}</text>`;
  const primary = "M430 320 V400 L310 420 L190 470 L90 475 V560";
  const backup = "M430 320 V400 L560 412 L660 335 L720 190";
  const early = [[185, 185, 58], [232, 245, 66], [280, 305, 48]];
  const late = early.concat([[305, 365, 56], [288, 428, 52], [250, 455, 30]]);
  const noise = (x, y) => { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); };

  function fire(blobs, id) {
    let glow = "", cells = "";
    blobs.forEach(([x, y, r]) => { glow += `<circle cx="${x}" cy="${y}" r="${r + 22}"/>`; });
    const S = 12;
    for (let x = 96; x < 408; x += S) for (let y = 96; y < 516; y += S) {
      const d = Math.min(...blobs.map(([bx, by, r]) => Math.hypot(x + 6 - bx, y + 6 - by) / r));
      const n = noise(x, y);
      const e = d + (n - 0.5) * 0.42;
      if (e > 1.12) continue;
      const kind = e > 0.98 ? "spot" : e > 0.74 ? (n > 0.55 ? "hot" : "front") : (n > 0.9 ? "ember" : "burned");
      cells += `<rect x="${x}" y="${y}" width="${S - 1.5}" height="${S - 1.5}" rx="2" class="c-${kind}"/>`;
      if (kind === "burned") cells += `<path d="M${x + 1} ${y + 9}l8 -8" class="c-hatch"/>`;
    }
    return `<g class="glow" filter="url(#${id})">${glow}</g><g>${cells}</g>`;
  }

  function map(mode, i) {
    const blur = `b${i}`, shade = `s${i}`;
    let s = `<svg viewBox="0 0 800 600" class="m-${mode}" role="img" aria-label="Schematic map, sample data: home, two ways out, candidate destinations${mode === "overview" || mode === "setup" ? "" : ", simulated fire"}">`;
    s += `<defs><filter id="${blur}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="28"/></filter>` +
      `<radialGradient id="${shade}"><stop offset="0" stop-color="#2d5a57" stop-opacity=".55"/><stop offset="1" stop-color="#2d5a57" stop-opacity="0"/></radialGradient></defs>`;
    s += `<ellipse cx="170" cy="150" rx="260" ry="190" fill="url(#${shade})"/><ellipse cx="650" cy="500" rx="220" ry="130" fill="url(#${shade})"/>`;
    [[170, 150, 190, 130], [170, 150, 150, 100], [170, 150, 100, 66], [170, 150, 52, 34], [640, 500, 130, 70], [640, 500, 80, 40]].forEach(([x, y, rx, ry]) => {
      s += `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" class="contour"/>`;
    });
    const stage = { running: early, results: late, fix: early.concat([[298, 350, 44]]) }[mode];
    [["M90 40 V560", "hwy"], [primary, "road"], [backup, "road"], ["M310 420 L330 540", "road"]].forEach(([d, c]) => { s += path(d, c); });
    if (mode === "overview") s += path(primary, "r-main") + path(backup, "r-backup");
    if (stage) s += fire(stage, blur);
    if (stage) {
      if (mode === "fix") {
        s += path(backup, "r-unused") + path(primary, "r-halo") + path(primary, "r-main");
        s += `<circle cx="280" cy="428" r="19" class="closure-back"/><circle cx="280" cy="428" r="19" class="closure"/><path d="M262 428H205" class="leader"/>`;
        s += label(198, 434, "Closes T+30", "end", "t-closed");
        s += label(350, 508, "Before: T+33, after it closed", "start", "t-closed");
        s += label(350, 538, "After: T+25, before it closed", "start", "t-route");
      } else if (mode === "running") {
        s += path(primary, "r-halo") + path(primary, "r-main");
        s += `<circle cx="280" cy="428" r="17" class="closure"/>`;
        s += label(300, 470, "Closes T+30", "start", "t-closed");
      } else {
        s += path(primary, "r-closed");
        s += `<g class="noentry"><circle cx="280" cy="428" r="17"/><path d="M269 439 291 417"/></g>`;
        s += label(352, 520, "Creek Rd closes T+30", "start", "t-closed");
      }
      s += label(215, 215, "SIMULATED FIRE", "middle", "t-fire");
      if (mode === "fix") s += label(215, 242, "shown at T+25", "middle", "t-road");
    }
    s += label(100, 30, "Highway", "start", "t-road") + label(150, 502, "Creek Rd", "middle", "t-road") + label(585, 440, "Ridge Rd", "middle", "t-road") + label(446, 372, "Willow Dr", "start", "t-road");
    s += `<circle cx="430" cy="320" r="26" class="home-ring"/><circle cx="430" cy="320" r="11" class="home"/>` + label(462, 318, "Home", "start");
    const dest = (x, y, n) => `<rect x="${x - 21}" y="${y - 21}" width="42" height="42" rx="8" class="dest"/><text x="${x}" y="${y + 8}" text-anchor="middle" class="t-dest">${n}</text>`;
    s += dest(90, 560, "D1") + dest(720, 188, "D2");
    s += label(118, 575, "School (candidate)", "start", "t-minor") + label(780, 155, "Hall (candidate)", "end", "t-minor");
    if (mode === "overview") s += label(250, 405, "Way out A", "middle", "t-route") + label(670, 250, "Way out B", "end", "t-route") + label(200, 112, "Slope rises NW", "middle", "t-road");
    if (mode === "setup") {
      [[170, 160, "1", true], [330, 110, "2"], [620, 500, "3"]].forEach(([x, y, n, on]) => {
        if (on) s += `<circle cx="${x}" cy="${y}" r="34" class="ig-ring"/>`;
        s += `<circle cx="${x}" cy="${y}" r="20" class="ig${on ? " on" : ""}"/><text x="${x}" y="${y + 5}" text-anchor="middle" class="t-ig${on ? " on" : ""}">${n}</text>`;
      });
      s += label(170, 218, "Ignition point (selected)", "middle", "t-fire");
    }
    s += `<g transform="translate(715 40)" class="wind"><path d="M0 0 40 40M40 40V16M40 40H16"/></g>`;
    s += label(780, 110, "Wind from NW 22 mph", "end", "t-minor");
    if (mode === "fix") s += label(670, 250, "Ridge Rd: backup", "end", "t-road t-minor");
    if (mode === "running") s += label(215, 436, "Your route", "middle", "t-route t-minor");
    s += label(780, 585, "Schematic · not real geography", "end", "t-road t-minor");
    return s + "</svg>";
  }
  document.querySelectorAll("[data-map]").forEach((el, i) => {
    el.classList.add("map");
    el.innerHTML = map(el.dataset.map, i);
    const note = document.createElement("p");
    note.className = "mapnote";
    const m = el.dataset.map;
    const lines = { overview: "Solid line: way out A. Dashed: way out B.", setup: "", running: "Solid cyan line: your route.", results: "Dotted coral line: your route, closed by the fire.", fix: "Solid cyan line: your route after the changes. Dashed: Ridge Rd, your backup." };
    note.textContent = [lines[m], "Arrow: wind from NW 22 mph.", "Schematic, not real geography. D1 School and D2 Hall are candidate destinations, not confirmed shelters."].filter(Boolean).join(" ");
    el.after(note);
  });
})();
