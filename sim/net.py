"""HTTP for the three free sources the app reads: SEC EDGAR, Yahoo Finance and the World Bank.

SEC requests carry a declared User-Agent and stay under ten a second, as the SEC asks of
automated clients. Every response is cached.
"""
from __future__ import annotations

import json
import os
import threading
import time

import httpx

from .store import cache_get, cache_put

SEC_UA = os.environ.get("SEC_USER_AGENT", "").strip() or "Berkshire Simulator research tool admin@example.com"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

HOUR = 3600
DAY = 24 * HOUR


class NotFound(Exception):
    pass


class Upstream(Exception):
    pass


_client = httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True)
_lock = threading.Lock()
_last = 0.0


def _sec_turn():
    global _last
    with _lock:
        wait = _last + 0.11 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last = time.monotonic()


def get(url: str, ttl: int = DAY) -> bytes:
    hit = cache_get(url, ttl)
    if hit is not None:
        return hit
    sec = "sec.gov" in url
    headers = {"User-Agent": SEC_UA if sec else BROWSER_UA, "Accept-Encoding": "gzip, deflate"}
    last = ""
    for attempt in range(3):
        if sec:
            _sec_turn()
        try:
            r = _client.get(url, headers=headers)
        except httpx.HTTPError as e:
            last = type(e).__name__
        else:
            if r.status_code == 200:
                cache_put(url, r.content)
                return r.content
            if r.status_code == 404:
                raise NotFound(url)
            last = f"HTTP {r.status_code}"
        time.sleep(0.8 * (attempt + 1))
    raise Upstream(f"Request failed ({last}): {url.split('?')[0]}")


def get_json(url: str, ttl: int = DAY):
    return json.loads(get(url, ttl))
