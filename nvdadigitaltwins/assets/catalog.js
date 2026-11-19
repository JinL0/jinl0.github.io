// Renders everything data-driven on index.html from data/products.json:
// stat tiles, the layered "stack" diagram with hover-to-trace dependencies,
// the filterable product catalog, the detail drawer, and the customer list.
const FAMILIES = [  // fixed order = fixed categorical slot (color follows the family, never rank)
  "Platform", "Simulation", "World foundation models", "Physics AI",
  "Blueprint / reference workflow", "Domain digital twin", "Operations AI", "Other",
];
const famColor = (f) => `var(--fam-${FAMILIES.indexOf(f) + 1 || 8})`;
const LAYERS = [
  { name: "Operate & optimize", sub: "act on the live twin", fams: ["Operations AI"] },
  { name: "Industry twins & blueprints", sub: "reference workflows per domain", fams: ["Blueprint / reference workflow", "Domain digital twin"] },
  { name: "AI for the physical world", sub: "generate, predict, accelerate", fams: ["World foundation models", "Physics AI"] },
  { name: "Simulate", sub: "physics, sensors, robots", fams: ["Simulation"] },
  { name: "Describe & render", sub: "OpenUSD scene + RTX", fams: ["Platform"] },
  { name: "Robotics & enabling tech", sub: "robot stacks, libraries, orchestration", fams: ["Other"] },
];

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en-US");

async function main() {
  let data;
  try {
    data = await (await fetch("data/products.json", { cache: "no-cache" })).json();
  } catch {
    $("#catalog-grid").innerHTML = `<p class="empty">Product data not generated yet - run the pipeline (see the technical doc).</p>`;
    return;
  }
  const { meta, products, customers } = data;
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  // builds_on means "built on or integrates with", so the UI treats it as an undirected connection.
  const links = Object.fromEntries(products.map((p) => [p.id, new Set(p.builds_on)]));
  products.forEach((p) => p.builds_on.forEach((b) => links[b]?.add(p.id)));
  const neighbors = (id) => [...(links[id] || [])].filter((x) => x !== id && byId[x])
    .sort((a, b) => byId[b].mentions - byId[a].mentions);

  // ---- stats ---------------------------------------------------------------------
  const grounded = meta.quotes_total ? Math.round((100 * meta.quotes_grounded) / meta.quotes_total) : 0;
  $("#stats").innerHTML = [
    [meta.pages_crawled, "public pages crawled"],
    [meta.products, "products extracted"],
    [meta.edges, "product connections"],
    [`${grounded}%`, "evidence quotes verified"],
  ].map(([v, k]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");
  document.querySelectorAll("[data-meta]").forEach((el) => (el.textContent = meta[el.dataset.meta] ?? ""));

  // ---- stack diagram ---------------------------------------------------------------
  const stack = $("#stack");
  const top = (fams, n) => products.filter((p) => fams.includes(p.family)).slice(0, n);
  stack.innerHTML = `<svg class="edges" aria-hidden="true"></svg>` + LAYERS.map((l) => {
    const items = top(l.fams, 9);
    if (!items.length) return "";
    return `<div class="layer"><div class="lname">${esc(l.name)}<small>${esc(l.sub)}</small></div><div class="pills">${
      items.map((p) => `<button class="pill" data-id="${esc(p.id)}" style="--c:${famColor(p.family)}"><i></i>${esc(shortName(p.name))}</button>`).join("")
    }</div></div>`;
  }).join("");
  const svg = $("svg.edges", stack);
  const pillOf = (id) => $(`.pill[data-id="${CSS.escape(id)}"]`, stack);
  function trace(id) {
    const related = new Set(id ? neighbors(id) : []);
    stack.classList.toggle("focus", !!id);
    stack.querySelectorAll(".pill").forEach((el) => {
      el.classList.toggle("on", el.dataset.id === id);
      el.classList.toggle("rel", related.has(el.dataset.id));
    });
    svg.innerHTML = "";
    if (!id) return;
    const box = stack.getBoundingClientRect(), a = pillOf(id).getBoundingClientRect();
    const ax = a.left + a.width / 2 - box.left, ay = a.top + a.height / 2 - box.top;
    related.forEach((rid) => {
      const el = pillOf(rid);
      if (!el) return;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2 - box.left, by = b.top + b.height / 2 - box.top;
      // Bow the curve perpendicular to the straight line, so it arcs around pills in between
      // (same-row links arc upward; vertical links arc sideways).
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const off = Math.min(90, len * 0.3) * (dx >= 0 ? -1 : 1);
      const cx = (ax + bx) / 2 + (-dy / len) * off, cy = (ay + by) / 2 + (dx / len) * off;
      svg.insertAdjacentHTML("beforeend", `<path d="M${ax},${ay} Q${cx},${cy} ${bx},${by}"/>`);
    });
  }
  stack.addEventListener("pointerover", (e) => { const p = e.target.closest(".pill"); if (p) trace(p.dataset.id); });
  stack.addEventListener("pointerleave", () => trace(null));
  stack.addEventListener("focusin", (e) => { const p = e.target.closest(".pill"); if (p) trace(p.dataset.id); });
  stack.addEventListener("click", (e) => { const p = e.target.closest(".pill"); if (p) openDrawer(p.dataset.id); });

  // ---- catalog ---------------------------------------------------------------------
  let family = "All", query = "";
  const counts = Object.fromEntries(FAMILIES.map((f) => [f, products.filter((p) => p.family === f).length]));
  $("#chips").innerHTML = ["All", ...FAMILIES.filter((f) => counts[f])].map((f) =>
    `<button class="chip" data-f="${esc(f)}" aria-pressed="${f === "All"}" ${f !== "All" ? `style="--c:${famColor(f)}"` : ""}>` +
    `${f !== "All" ? "<i></i>" : ""}${esc(f)} <span class="n">${f === "All" ? products.length : counts[f]}</span></button>`).join("");
  $("#chips").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    family = c.dataset.f;
    document.querySelectorAll("#chips .chip").forEach((x) => x.setAttribute("aria-pressed", x === c));
    renderGrid();
  });
  $("#search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); renderGrid(); });

  function renderGrid() {
    const list = products.filter((p) => (family === "All" || p.family === family) &&
      (!query || [p.name, p.one_liner, ...p.capabilities, ...p.industries].join(" ").toLowerCase().includes(query)));
    $("#catalog-grid").innerHTML = list.length ? list.map((p, i) =>
      `<button class="card" data-id="${esc(p.id)}" style="--c:${famColor(p.family)};--i:${Math.min(i, 20)}">
        <div class="fam">${esc(p.family)}</div><h3>${esc(p.name)}</h3><p>${esc(p.one_liner)}</p>
        <div class="meta">described on ${p.sources.length} page${p.sources.length > 1 ? "s" : ""}${neighbors(p.id).length ? ` · works with ${neighbors(p.id).length}` : ""}</div>
      </button>`).join("") : `<p class="empty">No products match.</p>`;
  }
  $("#catalog-grid").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openDrawer(c.dataset.id); });
  renderGrid();

  // ---- drawer ----------------------------------------------------------------------
  const dlg = $("#drawer");
  function openDrawer(id) {
    const p = byId[id]; if (!p) return;
    const link = (rid) => byId[rid] ? `<a href="#" data-open="${esc(rid)}">${esc(shortName(byId[rid].name))}</a>` : "";
    $("#drawer-body").innerHTML = `
      <div class="eyebrow" style="color:${famColor(p.family)}">${esc(p.family)}</div>
      <h2>${esc(p.name)}</h2><p class="lede" style="font-size:16px">${esc(p.what_it_does)}</p>
      <h4>Role in a digital twin</h4><p style="color:var(--text-secondary)">${esc(p.digital_twin_role)}</p>
      ${p.capabilities.length ? `<h4>Capabilities</h4><ul>${p.capabilities.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
      ${p.industries.length ? `<h4>Industries &amp; use cases</h4><div class="tags">${p.industries.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : ""}
      ${neighbors(id).length ? `<h4>Works with</h4><div class="tags">${neighbors(id).map(link).join("")}</div>` : ""}
      <h4>Sources (${p.sources.length})</h4><ul>${p.sources.map((s) =>
        `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join("")}</ul>
      <p class="small muted" style="margin-top:20px">Summary generated by Claude from the pages above and checked against ${p.evidence_count} verbatim quote(s). Verify details on nvidia.com.</p>`;
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
  }
  dlg.addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]");
    if (a) { e.preventDefault(); openDrawer(a.dataset.open); }
    else if (e.target === dlg) dlg.close();  // click on backdrop
  });
  $("#drawer .close").addEventListener("click", () => dlg.close());

  $("#customers").innerHTML = (customers || []).map((c) => `<span>${esc(c)}</span>`).join("");
}

function shortName(n) { return n.replace(/^NVIDIA\s+/i, "").replace(/[™®]/g, ""); }

main();
