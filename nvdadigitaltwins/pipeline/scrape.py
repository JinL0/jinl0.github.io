"""Stage 1 - Crawl: fetch public NVIDIA digital-twin product pages with Playwright.

Seeds + one hop of keyword-filtered link discovery, robots.txt checked, polite delay.
Output: raw/pages.jsonl (one JSON object per page). raw/ is git-ignored: we publish
summaries with links back to the source, never NVIDIA's page text.

    .venv/bin/python scrape.py            # default: up to 30 pages
    .venv/bin/python scrape.py --max 10
"""
import argparse
import asyncio
import hashlib
import json
import re
import time
import urllib.robotparser
from pathlib import Path
from urllib.parse import urldefrag, urlparse

from playwright.async_api import async_playwright

HERE = Path(__file__).parent
OUT = HERE / "raw" / "pages.jsonl"
USER_AGENT = "Mozilla/5.0 (Macintosh) jinl0-portfolio-research (+https://jinl0.github.io)"
DELAY_S = 1.5  # between requests, per politeness


SEEDS = [
    "https://www.nvidia.com/en-us/omniverse/",
    "https://www.nvidia.com/en-us/glossary/digital-twin/",
    "https://developer.nvidia.com/isaac/sim",
    "https://www.nvidia.com/en-us/high-performance-computing/earth-2/",
    "https://www.nvidia.com/en-us/ai/cosmos/",
    "https://developer.nvidia.com/physicsnemo",
    "https://www.nvidia.com/en-us/autonomous-machines/intelligent-video-analytics-platform/",
    "https://www.nvidia.com/en-us/ai-data-science/products/cuopt/",
    "https://www.nvidia.com/en-us/glossary/openusd/",
]
# A discovered link is kept only if its path matches one of these digital-twin topics.
KEYWORDS = re.compile(
    r"digital-twin|omniverse|blueprint|isaac|cosmos|earth-2|mega|ai-factor|dsx|"
    r"metropolis|cuopt|physicsnemo|openusd|/usd|simulation|robotics",
    re.I,
)
SKIP = re.compile(r"/(news|blog|events?|on-demand|careers|shop|support|login|search|forums)/|\.(pdf|zip|png|jpg|mp4)$", re.I)


def normalize(url: str) -> str:
    url, _ = urldefrag(url)
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}{p.path if p.path.endswith('/') or '.' in p.path.rsplit('/', 1)[-1] else p.path + '/'}"


class Robots:
    def __init__(self):
        self._cache: dict[str, urllib.robotparser.RobotFileParser] = {}

    def allowed(self, url: str) -> bool:
        host = urlparse(url).netloc
        if host not in self._cache:
            rp = urllib.robotparser.RobotFileParser(f"https://{host}/robots.txt")
            rp.read()
            self._cache[host] = rp
        return self._cache[host].can_fetch("*", url)


async def fetch(page, url: str) -> dict | None:
    resp = await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
    try:  # JS-rendered sections: give the page a moment to settle, but don't hang on trackers
        await page.wait_for_load_state("networkidle", timeout=8_000)
    except Exception:
        pass
    if not resp or resp.status >= 400:
        return None
    # Drop chrome that adds noise for the LLM: nav, footer, cookie banners, scripts.
    text = await page.evaluate(
        """() => {
            const root = document.querySelector('main') || document.body;
            const clone = root.cloneNode(true);
            clone.querySelectorAll('nav, footer, header, script, style, noscript, [role=dialog], #onetrust-consent-sdk')
                 .forEach(n => n.remove());
            return clone.innerText;
        }"""
    )
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    links = await page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
    return {
        "url": normalize(page.url),  # after redirects
        "requested_url": url,
        "status": resp.status,
        "title": await page.title(),
        "text": text,
        "chars": len(text),
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "links": sorted({normalize(l) for l in links if l.startswith("http")}),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


async def crawl(max_pages: int) -> list[dict]:
    robots, seen, pages = Robots(), set(), []
    queue = [(normalize(u), 0) for u in SEEDS]  # (url, depth); depth 1 = discovered from a seed
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(user_agent=USER_AGENT)
        while queue and len(pages) < max_pages:
            url, depth = queue.pop(0)
            if url in seen:
                continue
            seen.add(url)
            if not robots.allowed(url):
                print(f"  skip (robots)  {url}")
                continue
            try:
                doc = await fetch(page, url)
            except Exception as e:  # timeouts, navigation errors: log and move on
                print(f"  error          {url}  {str(e)[:60]}")
                doc = None
            await asyncio.sleep(DELAY_S)
            if not doc or doc["chars"] < 1500 or doc["url"] in {d["url"] for d in pages}:
                continue
            doc["depth"] = depth
            pages.append(doc)
            print(f"  [{len(pages):2d}] d{depth} {doc['chars']:6d} chars  {doc['url']}")
            if depth == 0:  # one hop of discovery from each seed
                for link in doc["links"]:
                    host = urlparse(link).netloc
                    in_scope = host == "developer.nvidia.com" or (host == "www.nvidia.com" and "/en-us/" in link)
                    if in_scope and KEYWORDS.search(urlparse(link).path) and not SKIP.search(link) and link not in seen:
                        queue.append((link, 1))
        await browser.close()
    return pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=30)
    args = ap.parse_args()
    pages = asyncio.run(crawl(args.max))
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w") as f:
        for d in pages:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    print(f"wrote {len(pages)} pages -> {OUT.relative_to(HERE)}")


if __name__ == "__main__":
    main()
