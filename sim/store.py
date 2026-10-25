"""SQLite cache for HTTP responses and fitted results.

Locally the file lives in .cache/. On Vercel only /tmp is writable, so the cache lasts as long as
a function instance stays warm.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import zlib

_DIR = "/tmp" if os.environ.get("VERCEL") else os.path.join(os.path.dirname(os.path.dirname(__file__)), ".cache")
PATH = os.environ.get("SIM_CACHE") or os.path.join(_DIR, "sim.db")

_local = threading.local()


def db() -> sqlite3.Connection:
    con = getattr(_local, "con", None)
    if con is None:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        con = sqlite3.connect(PATH, timeout=10)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("CREATE TABLE IF NOT EXISTS http (url TEXT PRIMARY KEY, at REAL, body BLOB)")
        con.execute("CREATE TABLE IF NOT EXISTS memo (key TEXT PRIMARY KEY, at REAL, body BLOB)")
        _local.con = con
    return con


def cache_get(url: str, ttl: float) -> bytes | None:
    row = db().execute("SELECT at, body FROM http WHERE url = ?", (url,)).fetchone()
    if row and time.time() - row[0] < ttl:
        return zlib.decompress(row[1])
    return None


def cache_put(url: str, body: bytes) -> None:
    with db() as con:
        con.execute("INSERT OR REPLACE INTO http VALUES (?, ?, ?)", (url, time.time(), zlib.compress(body, 6)))


def memoize(prefix: str, ttl: float):
    """Cache a function's JSON-serializable result by its arguments."""

    def wrap(fn):
        def inner(*args):
            key = prefix + ":" + ":".join(str(a) for a in args)
            row = db().execute("SELECT at, body FROM memo WHERE key = ?", (key,)).fetchone()
            if row and time.time() - row[0] < ttl:
                return json.loads(zlib.decompress(row[1]))
            value = fn(*args)
            body = zlib.compress(json.dumps(value, separators=(",", ":")).encode(), 6)
            with db() as con:
                con.execute("INSERT OR REPLACE INTO memo VALUES (?, ?, ?)", (key, time.time(), body))
            return value

        inner.__name__ = fn.__name__
        inner.__doc__ = fn.__doc__
        return inner

    return wrap
