// Fills the design doc's live numbers from data/products.json (meta block written by merge.py).
const nf = new Intl.NumberFormat("en-US");
const tile = ([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
try {
  const { meta: m } = await (await fetch("data/products.json", { cache: "no-cache" })).json();
  const pct = m.quotes_total ? Math.round((100 * m.quotes_grounded) / m.quotes_total) : 0;
  const cost = m.tokens_in * 4e-6 + m.tokens_out * 20e-6;  // Opus 5.5 list price per token
  document.querySelectorAll("[data-meta]").forEach((el) => (el.textContent = m[el.dataset.meta] ?? ""));
  document.querySelectorAll("[data-meta-k]").forEach((el) => (el.textContent = nf.format(m[el.dataset.metaK] ?? 0)));
  document.getElementById("cost").textContent = `$${cost.toFixed(2)}`;
  document.getElementById("doc-stats").innerHTML = [
    [m.pages_crawled, "pages crawled"], [m.products, "products"], [m.edges, "dependency edges"], [`$${cost.toFixed(2)}`, "LLM cost, full run"],
  ].map(tile).join("");
  document.getElementById("quality-stats").innerHTML = [
    [`${pct}%`, `evidence quotes verified (${m.quotes_grounded}/${m.quotes_total})`],
    [m.records_dropped_ungrounded, "records dropped: no verified quote"],
    [m.pages_with_products, "pages that described ≥1 product"],
    [m.pages_failed, "pages failed"],
  ].map(tile).join("");
} catch {
  document.getElementById("doc-stats").innerHTML = `<p class="muted">Run the pipeline to populate live numbers.</p>`;
}
