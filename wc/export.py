"""Backup/export: rebuild a single SQLite database + tarball from the versioned data files."""
from __future__ import annotations

import csv
import sqlite3
import tarfile

from .core import DATA, iso, now_utc, read_json, read_jsonl


def export(out_dir=None):
    out_dir = out_dir or DATA.parent / "export"
    out_dir.mkdir(parents=True, exist_ok=True)
    db = out_dir / "wildcard.sqlite"
    if db.exists():
        db.unlink()
    con = sqlite3.connect(db)
    c = con.cursor()
    c.execute("create table prices(ts text, id int, name text, old real, new real, primary key(ts,id))")
    c.execute("create table status_changes(ts text, id int, name text, from_status text, to_status text, news text, primary key(ts,id))")
    c.execute("create table market(ts text, gw int, id int, cost real, own real, tin int, tout int, status text, chance int, pts int, primary key(ts,id))")
    c.execute("create table decisions(ts text primary key, gw int, model text, captain int, vice int, top_transfer text, gain real)")
    c.execute("create table alerts(key text, sent_at text, severity text, type text, title text, delivered int, primary key(key,sent_at))")
    c.execute("create table runs(ts text primary key, mode text, secs int, health text, errors text)")
    c.execute("create table validation(gw int primary key, projection_ts text, model text, n int, mae real, bias real)")
    pf = DATA / "history" / "prices.csv"
    if pf.exists():
        rows = list(csv.reader(open(pf)))[1:]
        c.executemany("insert or ignore into prices values(?,?,?,?,?)", rows)
    for r in read_jsonl(DATA / "history" / "status.jsonl"):
        c.execute("insert or ignore into status_changes values(?,?,?,?,?,?)",
                  (r["ts"], r["id"], r["name"], str(r["from"]), str(r["to"]), r.get("news")))
    import gzip
    for f in sorted((DATA / "history" / "market").glob("*.csv*")):
        fh = gzip.open(f, "rt") if f.suffix == ".gz" else open(f)
        rows = list(csv.reader(fh))[1:]
        c.executemany("insert or ignore into market values(?,?,?,?,?,?,?,?,?,?)",
                      [[x if x != "" else None for x in r] for r in rows])
    for r in read_jsonl(DATA / "history" / "decisions.jsonl"):
        c.execute("insert or ignore into decisions values(?,?,?,?,?,?,?)",
                  (r["ts"], r.get("gw"), r.get("model"), r.get("captain"), r.get("vice"), r.get("top_transfer"),
                   r.get("top_transfer_gain")))
    for r in read_jsonl(DATA / "state" / "alerts.jsonl"):
        c.execute("insert or ignore into alerts values(?,?,?,?,?,?)",
                  (r["key"], r.get("sent_at"), r["severity"], r["type"], r["title"], int(bool(r.get("delivered")))))
    for r in read_jsonl(DATA / "state" / "runs.jsonl"):
        c.execute("insert or ignore into runs values(?,?,?,?,?)", (r["ts"], r["mode"], r.get("secs"), r.get("health"),
                                                                  "; ".join(r.get("errors") or [])))
    for g in read_json(DATA / "validation" / "scored.json", []) or []:
        v = read_json(DATA / "validation" / f"gw{g}.json")
        if v:
            c.execute("insert or ignore into validation values(?,?,?,?,?,?)",
                      (v["gw"], v["projection_ts"], v["model"], v["n"], v["mae"], v["bias_actual_minus_proj"]))
    con.commit()
    counts = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in
              ("prices", "status_changes", "market", "decisions", "alerts", "runs", "validation")}
    con.close()
    tar = out_dir / f"wildcard-backup-{iso(now_utc())[:10]}.tar.gz"
    with tarfile.open(tar, "w:gz") as t:
        t.add(DATA, arcname="data")
        t.add(db, arcname="wildcard.sqlite")
    return {"sqlite": str(db), "tarball": str(tar), "rows": counts}
