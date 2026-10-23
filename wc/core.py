"""Shared helpers: config, clock, atomic storage, resilient HTTP."""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import random
import time
import tomllib
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("WC_DATA_DIR", ROOT / "data"))
FPL = os.environ.get("WC_FPL_BASE", "https://fantasy.premierleague.com/api")
UA = "WildCardExe-personal-pipeline/1.0 (+github actions; low-frequency, cached)"


def load_config() -> dict:
    with open(ROOT / "config.toml", "rb") as f:
        return tomllib.load(f)


def now_utc() -> datetime:
    fixed = os.environ.get("WC_NOW")  # tests only
    if fixed:
        return datetime.fromisoformat(fixed.replace("Z", "+00:00"))
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str | None) -> datetime | None:
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def local(dt: datetime, tz: str) -> datetime:
    return dt.astimezone(ZoneInfo(tz))


# ---------------------------------------------------------------- storage
def p(*parts: str) -> Path:
    path = DATA.joinpath(*parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, obj, compact=True) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(obj, separators=(",", ":") if compact else None, indent=None if compact else 1,
                      ensure_ascii=False, sort_keys=False)
    if path.suffix == ".gz":
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            f.write(data)
    else:
        tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path, default=None):
    try:
        if path.suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8") as f:
                return json.load(f)
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, EOFError, OSError):
        return default


def append_jsonl(path: Path, rows) -> int:
    rows = list(rows)
    if rows:
        with open(path, "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")
    return len(rows)


def read_jsonl(path: Path) -> list:
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except FileNotFoundError:
        pass
    return out


def digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


# ---------------------------------------------------------------- http
class SourceError(Exception):
    def __init__(self, msg, status=None):
        super().__init__(msg)
        self.status = status


def get_json(path: str, cache: dict | None = None, timeout=20, retries=4, base_delay=2.0, opener=None):
    """GET {FPL}{path} with timeout, bounded retries, exponential backoff + jitter, Retry-After,
    and conditional requests (ETag / Last-Modified). Returns (json|None-if-304, meta)."""
    url = FPL.rstrip("/") + path
    cache = cache if cache is not None else {}
    hdr = {"User-Agent": UA, "Accept": "application/json", "Accept-Encoding": "gzip"}
    c = cache.get(path) or {}
    if c.get("etag"):
        hdr["If-None-Match"] = c["etag"]
    if c.get("last_modified"):
        hdr["If-Modified-Since"] = c["last_modified"]
    opener = opener or urllib.request.urlopen
    last = None
    t0 = time.time()
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=hdr)
            with opener(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                ctype = r.headers.get("Content-Type", "")
                if "json" not in ctype and not raw.lstrip().startswith((b"{", b"[")):
                    # FPL serves an HTML holding page while the game is updating
                    raise SourceError(f"non-JSON response ({ctype or 'unknown'}) — FPL may be updating", 503)
                data = json.loads(raw)
                cache[path] = {"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified")}
                return data, {"url": url, "status": r.status, "bytes": len(raw), "attempts": attempt + 1,
                              "ms": int((time.time() - t0) * 1000), "not_modified": False}
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return None, {"url": url, "status": 304, "attempts": attempt + 1,
                              "ms": int((time.time() - t0) * 1000), "not_modified": True}
            last = SourceError(f"HTTP {e.code}", e.code)
            if e.code in (400, 401, 403, 404):
                raise last  # not retryable; never try to get around access controls
            wait = None
            if e.code == 429:
                ra = e.headers.get("Retry-After") if e.headers else None
                wait = float(ra) if ra and ra.isdigit() else None
        except SourceError as e:
            last = e
            wait = None
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError, OSError) as e:
            last = SourceError(f"{type(e).__name__}: {e}")
            wait = None
        if attempt < retries:
            delay = wait if wait is not None else base_delay * (2 ** attempt)
            time.sleep(min(60, delay) + random.uniform(0, base_delay))
    raise last or SourceError("unknown fetch failure")
