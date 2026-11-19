"""Stage 2 - Extract: turn each crawled page into structured product records with Claude.

For every page in raw/pages.jsonl, Claude returns JSON that must match the `PageExtraction`
schema (structured outputs, so no JSON-repair code). Every record carries verbatim evidence
quotes; `ground()` drops quotes that don't appear in the page and drops products left with
none. Output: raw/extractions.jsonl (one line per page, for debugging and re-merging).

    export ANTHROPIC_API_KEY=...          # personal key (or `ant auth login`)
    .venv/bin/python extract.py           # all pages, 4 in parallel
    .venv/bin/python extract.py --limit 3 # smoke test
"""
import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from pathlib import Path

import anthropic
from pydantic import BaseModel, Field

HERE = Path(__file__).parent
PAGES = HERE / "raw" / "pages.jsonl"
OUT = HERE / "raw" / "extractions.jsonl"
MODEL = "claude-opus-5-5"


class Family(str, Enum):
    platform = "Platform"                # Omniverse, OpenUSD
    simulation = "Simulation"            # Isaac Sim, sensor / AV simulation
    world_models = "World foundation models"  # Cosmos
    physics_ai = "Physics AI"            # PhysicsNeMo, CFD
    blueprint = "Blueprint / reference workflow"  # Mega, DSX, AI-factory twin
    domain_twin = "Domain digital twin"  # Earth-2, Aerial
    operations = "Operations AI"         # Metropolis, cuOpt
    other = "Other"


class Product(BaseModel):
    name: str = Field(description="Official NVIDIA product name as written on the page, e.g. 'NVIDIA Isaac Sim'.")
    family: Family
    one_liner: str = Field(description="One sentence, <= 20 words, in your own words.")
    what_it_does: str = Field(description="2-3 sentences in your own words for an engineer new to the product.")
    digital_twin_role: str = Field(description="How this product is used to build, feed, or run a digital twin. One or two sentences.")
    capabilities: list[str] = Field(description="3-6 short capability phrases.")
    industries: list[str] = Field(description="Industries or use cases named on the page.")
    builds_on: list[str] = Field(description="Other NVIDIA products/technologies this one is built on or integrates with, as named on the page.")
    evidence: list[str] = Field(description="2-4 short quotes (8-30 words) copied EXACTLY from the page text that support the fields above.")


class PageExtraction(BaseModel):
    page_kind: str = Field(description="One of: product page, use-case page, glossary/explainer, case study, developer hub, other.")
    products: list[Product]
    customers: list[str] = Field(description="Named customer or partner companies shown using these products, if any.")


SYSTEM = """You extract facts about NVIDIA digital-twin and physical-AI products from one web page.

Rules:
- Only include products that this page actually describes (a passing mention in a nav menu or footer does not count).
- Use the product's official name exactly as the page writes it.
- Write summaries in your own words; do not copy marketing sentences. Evidence quotes are the only verbatim text.
- Every evidence quote must be copied character-for-character from the page so it can be found with a string search.
- If the page describes no product (e.g. a pure glossary), return an empty products list."""


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def ground(extraction: PageExtraction, page_text: str) -> tuple[dict, dict]:
    """Keep only evidence quotes found verbatim in the page; drop products with no grounded quote."""
    haystack = norm(page_text)
    kept, stats = [], {"quotes": 0, "grounded": 0, "products_in": len(extraction.products), "products_out": 0}
    for p in extraction.products:
        good = [q for q in p.evidence if norm(q) and norm(q) in haystack]
        stats["quotes"] += len(p.evidence)
        stats["grounded"] += len(good)
        if good:
            kept.append({**p.model_dump(mode="json"), "evidence": good})
    stats["products_out"] = len(kept)
    out = extraction.model_dump(mode="json")
    out["products"] = kept
    return out, stats


def extract_page(client: anthropic.Anthropic, page: dict) -> dict:
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "medium"},
        system=SYSTEM,
        messages=[{
            "role": "user",
            "content": f"<page url=\"{page['url']}\" title=\"{page['title']}\">\n{page['text']}\n</page>\n\n"
                       "Extract the products this page describes.",
        }],
        output_format=PageExtraction,
    )
    base = {"url": page["url"], "title": page["title"], "sha256": page["sha256"],
            "usage": {"input": response.usage.input_tokens, "output": response.usage.output_tokens}}
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        return {**base, "error": f"stop_reason={response.stop_reason}"}
    extraction, stats = ground(response.parsed_output, page["text"])
    return {**base, **extraction, "grounding": stats}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    pages = [json.loads(l) for l in PAGES.open()][: args.limit]
    client = anthropic.Anthropic(max_retries=4)  # SDK retries 429/5xx with backoff

    def run(page):
        try:
            r = extract_page(client, page)
        except (anthropic.BadRequestError, anthropic.AuthenticationError, anthropic.PermissionDeniedError):
            raise  # config problems: stop the whole run
        except anthropic.APIError as e:
            r = {"url": page["url"], "error": f"{type(e).__name__}: {e}"}
        g = r.get("grounding", {})
        print(f"  {len(r.get('products', [])):2d} products  {g.get('grounded', 0)}/{g.get('quotes', 0)} quotes grounded  "
              f"{r.get('error', '')}  {page['url']}")
        return r

    with ThreadPoolExecutor(args.workers) as pool:
        results = list(pool.map(run, pages))

    with OUT.open("w") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tin = sum(r.get("usage", {}).get("input", 0) for r in results)
    tout = sum(r.get("usage", {}).get("output", 0) for r in results)
    print(f"wrote {len(results)} -> {OUT.relative_to(HERE)} · tokens in={tin:,} out={tout:,} "
          f"· est. ${tin * 4e-6 + tout * 20e-6:.2f} at Opus 5.5 list price")


if __name__ == "__main__":
    main()
