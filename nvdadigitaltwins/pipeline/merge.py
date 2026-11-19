"""Stage 3 - Merge: dedupe per-page extractions into one product catalog for the website.

The same product shows up on many pages ("NVIDIA Isaac Sim", "Isaac Sim™", ...). We merge
deterministically (no LLM): canonicalize names, vote on family, take the summary from the
best-grounded record (preferring the product's own page), and union capabilities by frequency.
Only `builds_on` edges whose target is also in the catalog are kept.

Output: ../data/products.json (published; contains our summaries + source links, no page text).

    .venv/bin/python merge.py
"""
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
EXTRACTIONS = HERE / "raw" / "extractions.jsonl"
PAGES = HERE / "raw" / "pages.jsonl"
OUT = HERE.parent / "data" / "products.json"

# Manual aliases, added after reading a run's output. key: canonical key -> preferred key.
ALIASES = {
    "omniverse platform": "omniverse",
    "omniverse enterprise": "omniverse",
    "universal scene description": "openusd",
    "openusd (universal scene description)": "openusd",
    "usd": "openusd",
    "metropolis platform": "metropolis",
    "cosmos world foundation models": "cosmos",
    "cosmos platform": "cosmos",
    "earth-2 platform": "earth-2",
    "physicsnemo framework": "physicsnemo",
}


def key(name: str) -> str:
    k = re.sub(r"[™®©]", "", name).lower()
    k = re.sub(r"^nvidia\s+", "", k).strip()
    k = re.sub(r"\s+", " ", k)
    return ALIASES.get(k, k)


def top(items, n):
    counts = Counter(i.strip() for i in items if i and i.strip())
    seen, out = set(), []
    for item, _ in counts.most_common():
        if item.lower() not in seen:
            seen.add(item.lower())
            out.append(item)
        if len(out) == n:
            break
    return out


def main():
    rows = [json.loads(l) for l in EXTRACTIONS.open()]
    pages = [json.loads(l) for l in PAGES.open()]
    groups: dict[str, list[dict]] = defaultdict(list)
    customers = Counter()
    for r in rows:
        customers.update(c.strip() for c in r.get("customers", []) if c.strip())
        for p in r.get("products", []):
            groups[key(p["name"])].append({**p, "_url": r["url"], "_title": r["title"]})

    products = []
    for k, recs in groups.items():
        # Prefer a record from the product's own page (its name is in the page title), then most evidence.
        best = max(recs, key=lambda p: (k.split()[0] in p["_title"].lower(), len(p["evidence"])))
        products.append({
            "id": re.sub(r"[^a-z0-9]+", "-", k).strip("-"),
            "key": k,
            "name": Counter(p["name"] for p in recs).most_common(1)[0][0],
            "family": Counter(p["family"] for p in recs).most_common(1)[0][0],
            "one_liner": best["one_liner"],
            "what_it_does": best["what_it_does"],
            "digital_twin_role": best["digital_twin_role"],
            "capabilities": top([c for p in recs for c in p["capabilities"]], 6),
            "industries": top([i for p in recs for i in p["industries"]], 8),
            "builds_on_raw": sorted({key(b) for p in recs for b in p["builds_on"]} - {k}),
            "mentions": len(recs),
            "evidence_count": sum(len(p["evidence"]) for p in recs),
            "sources": sorted({(p["_url"], p["_title"]) for p in recs}),
        })

    ids = {p["key"]: p["id"] for p in products}
    for p in products:
        p["builds_on"] = sorted({ids[b] for b in p.pop("builds_on_raw") if b in ids})
        p["sources"] = [{"url": u, "title": t} for u, t in p["sources"]]
        del p["key"]
    products.sort(key=lambda p: (-p["mentions"], p["name"]))

    g = [r["grounding"] for r in rows if "grounding" in r]
    usage = [r["usage"] for r in rows if "usage" in r]
    meta = {
        "generated_at": time.strftime("%Y-%m-%d", time.gmtime()),
        "model": "claude-opus-5-5",
        "pages_crawled": len(pages),
        "chars_crawled": sum(p["chars"] for p in pages),
        "pages_with_products": sum(1 for r in rows if r.get("products")),
        "pages_failed": sum(1 for r in rows if "error" in r),
        "products": len(products),
        "edges": sum(len(p["builds_on"]) for p in products),
        "quotes_total": sum(x["quotes"] for x in g),
        "quotes_grounded": sum(x["grounded"] for x in g),
        "records_dropped_ungrounded": sum(x["products_in"] - x["products_out"] for x in g),
        "tokens_in": sum(u["input"] for u in usage),
        "tokens_out": sum(u["output"] for u in usage),
        "page_kinds": dict(Counter(r.get("page_kind", "error") for r in rows)),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"meta": meta, "customers": [c for c, _ in customers.most_common(24)],
                               "products": products}, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(meta, indent=2))
    print("\nproducts:", *(f"{p['mentions']:2d}x {p['family'][:22]:22s} {p['name']}" for p in products), sep="\n  ")


if __name__ == "__main__":
    main()
