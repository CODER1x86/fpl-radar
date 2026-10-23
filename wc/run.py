"""Orchestrator. Usage: python -m wc.run {auto|validate|notify-test|export} [--force-model] [--dry-notify]

Every step is isolated: a failing source never deletes the last-known-good state, and the status file always
records what happened. No value is ever invented for a missing observation."""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
import traceback
from datetime import timedelta

from . import alerts as AL
from . import model as M
from . import normalize as N
from . import notify as NT
from . import validate as V
from .core import parse_iso as datetime_from
from .core import (DATA, SourceError, append_jsonl, digest, get_json, iso, load_config, now_utc, p, parse_iso,
                   read_json, read_jsonl, write_json)


class Ctx:
    def __init__(self, cfg, now, dry_notify=False):
        self.cfg, self.now, self.dry = cfg, now, dry_notify
        self.status = read_json(p("state", "status.json"), {}) or {}
        self.status.setdefault("sources", {})
        self.http = read_json(p("cache", "http.json"), {}) or {}
        self.errors, self.warnings, self.events = [], [], []
        self.t0 = time.time()

    def src_ok(self, name, meta):
        s = self.status["sources"].setdefault(name, {})
        s.update(last_ok=iso(self.now), last_status=meta.get("status"), ms=meta.get("ms"),
                 bytes=meta.get("bytes"), not_modified=meta.get("not_modified"), attempts=meta.get("attempts"),
                 last_error=None)

    def src_err(self, name, err):
        s = self.status["sources"].setdefault(name, {})
        s.update(last_error=f"{iso(self.now)} {err}")
        self.errors.append(f"{name}: {err}")

    def due(self, key, minutes):
        t = parse_iso(self.status.get(key))
        return t is None or self.now - t >= timedelta(minutes=minutes)


def fetch(ctx, name, path, validator=None, cache_file=None):
    """Fetch + validate. On 304 or failure, fall back to the cached valid copy (flagged)."""
    try:
        data, meta = get_json(path, ctx.http)
        if data is None and cache_file:
            data = read_json(cache_file)
            if data is None:  # cache lost: refetch unconditionally
                ctx.http.pop(path, None)
                data, meta = get_json(path, ctx.http)
        if validator:
            w = validator(data)
            if w:
                ctx.warnings += [f"{name}: {x}" for x in w]
        if cache_file and not meta.get("not_modified"):
            write_json(cache_file, data)
        ctx.src_ok(name, meta)
        return data, True
    except (SourceError, V.SchemaError) as e:
        kind = "schema" if isinstance(e, V.SchemaError) else "fetch"
        ctx.src_err(name, f"{kind}: {e}")
        ctx.http.pop(path, None)
        cached = read_json(cache_file) if cache_file else None
        return cached, False


def material_hash(players, fx, squad):
    keys = ("status", "chance", "cost", "mins", "starts", "xg", "xa", "xgc", "dc", "bonus", "saves")
    return digest([[i, [pl[k] for k in keys]] for i, pl in sorted(players.items())] +
                  [[f["id"], f.get("event"), f["finished"], f["team_h_difficulty"], f["team_a_difficulty"]] for f in fx] +
                  [sorted(squad)])


def ingest(ctx):
    cfg = ctx.cfg
    boot, ok_b = fetch(ctx, "bootstrap", "/bootstrap-static/", V.bootstrap, p("cache", "bootstrap.json.gz"))
    if boot is None:
        raise SourceError("no valid bootstrap available (live fetch failed and no cache)")
    fx_due = ctx.due("fixtures_last_ok", cfg["intervals"]["fixtures_hours"] * 60) or not ok_b
    fxfile = p("cache", "fixtures.json.gz")
    if fx_due or read_json(fxfile) is None:
        fx, ok_f = fetch(ctx, "fixtures", "/fixtures/", V.fixtures, fxfile)
        if ok_f:
            ctx.status["fixtures_last_ok"] = iso(ctx.now)
    else:
        fx, ok_f = read_json(fxfile), True
    if fx is None:
        raise SourceError("no valid fixtures available")
    gw = N.gameweeks(boot)
    players = N.players(boot)
    teams = N.teams(boot)

    # squad from public picks (reflects the team at the last deadline)
    squad, bank, squad_src = None, None, None
    mid = cfg["manager"]["id"]
    if gw["current"]:
        pk_file = p("cache", f"picks_gw{gw['current']}.json")
        if read_json(pk_file) is None or ctx.due("picks_last_ok", 360):
            pk, ok_p = fetch(ctx, "picks", f"/entry/{mid}/event/{gw['current']}/picks/", V.picks, pk_file)
            if ok_p:
                ctx.status["picks_last_ok"] = iso(ctx.now)
        else:
            pk = read_json(pk_file)
        if pk:
            squad = [x["element"] for x in pk["picks"]]
            bank = pk["entry_history"]["bank"] / 10
            squad_src = f"/entry/{mid}/event/{gw['current']}/picks/ (team as of GW{gw['current']} deadline)"
    if not squad:
        squad = cfg["squad"]["fallback_ids"]
        squad_src = "config fallback (picks unavailable)"
    hist_file = p("cache", "history.json")
    if read_json(hist_file) is None or ctx.due("history_last_ok", 360):
        h, ok_h = fetch(ctx, "history", f"/entry/{mid}/history/", None, hist_file)
        if ok_h:
            ctx.status["history_last_ok"] = iso(ctx.now)
    history = read_json(hist_file)

    prev = {int(k): v for k, v in (read_json(p("latest", "players.json"), {}) or {}).items()}
    # ---- idempotent history writes: only changes are appended; same snapshot twice writes nothing
    ts = iso(ctx.now)
    if prev:
        price_rows, status_rows = [], []
        for i, c in players.items():
            o = prev.get(i)
            if not o:
                continue
            if abs(o["cost"] - c["cost"]) >= 0.05:
                price_rows.append([ts, i, c["name"], o["cost"], c["cost"]])
            if (o["status"], o["chance"], o["news"]) != (c["status"], c["chance"], c["news"]):
                status_rows.append({"ts": ts, "id": i, "name": c["name"], "from": [o["status"], o["chance"]],
                                    "to": [c["status"], c["chance"]], "news": c["news"], "news_added": c["news_added"]})
        pf = p("history", "prices.csv")
        new = not pf.exists()
        if price_rows:
            with open(pf, "a", newline="") as f:
                w = csv.writer(f)
                if new:
                    w.writerow(["ts", "id", "name", "old", "new"])
                w.writerows(price_rows)
        append_jsonl(p("history", "status.jsonl"), status_rows)
        ctx.events.append(f"{len(price_rows)} price changes, {len(status_rows)} status/news changes")
    for old in p("history", "market", "x").parent.glob("*.csv"):
        if old.stem != ts[:10]:  # compress finished days
            import gzip, shutil
            with open(old, "rb") as fi, gzip.open(str(old) + ".gz", "wb") as fo:
                shutil.copyfileobj(fi, fo)
            old.unlink()
    if ctx.due("market_last", cfg["intervals"]["market_snapshot_minutes"] - 2):
        mf = p("history", "market", f"{ts[:10]}.csv")
        new = not mf.exists()
        with open(mf, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["ts", "gw", "id", "cost", "own", "tin", "tout", "status", "chance", "pts"])
            for i, c in players.items():
                w.writerow([ts, gw["next"], i, c["cost"], c["own"], c["tin"], c["tout"], c["status"], c["chance"], c["pts"]])
        ctx.status["market_last"] = ts
    if ok_b and ctx.due("raw_last", cfg["intervals"]["raw_snapshot_hours"] * 60 - 2):
        write_json(p("raw", ts[:10], f"bootstrap-{ts[11:13]}{ts[14:16]}Z.json.gz"), boot)
        ctx.status["raw_last"] = ts

    write_json(p("latest", "players.json"), players)
    write_json(p("latest", "gw.json"), gw)
    if ok_b:
        ctx.status["last_ingest_ok"] = ts
        ctx.status["data_observed_at"] = ts
    return dict(boot=boot, fx=fx, gw=gw, players=players, teams=teams, prev=prev, squad=squad, bank=bank,
                squad_src=squad_src, history=history, live=ok_b)


def run_model(ctx, d):
    cfg = ctx.cfg
    gw = d["gw"]
    if not gw["next"]:
        ctx.events.append("season finished — model skipped")
        return None
    gws = [g for g in range(gw["next"], min(38, gw["next"] + cfg["model"]["horizon"] - 1) + 1)]
    fmap = N.fixture_map(d["fx"], gws)
    proj = M.project(d["players"], fmap, d["fx"], gws, cfg, ctx.now.date(), d["squad"])
    sell = {int(k): v for k, v in cfg["squad"]["selling_price_estimates"].items()}
    plr = d["players"]
    lineups = []
    for k, g in enumerate(gws):
        r = M.best_xi(d["squad"], plr, lambda i, k=k: proj[i]["b"][k] if i in proj else 0.0)
        if r:
            r["gw"] = g
        lineups.append(r)
    ft = M.free_transfers(d["history"], gw["next"])
    bank = d["bank"] if d["bank"] is not None else 0.0
    tr = M.transfer_search(d["squad"], plr, proj, bank, sell, n=3, ft=ft or 1)
    caps = sorted((i for i in d["squad"] if i in proj), key=lambda i: -proj[i]["b"][0])[:6]
    cap_pool = sorted((i for i in proj if proj[i].get("u1") is not None), key=lambda i: -proj[i]["b"][0])[:15]
    l0 = lineups[0] or {}
    dec = {"gw": gws[0], "model": M.VERSION, "captain": l0.get("captain"),
           "captain_name": plr[l0["captain"]]["name"] if l0.get("captain") else None,
           "captain_xp": proj[l0["captain"]]["b"][0] if l0.get("captain") else None,
           "vice": l0.get("vice"), "formation": l0.get("formation")}
    best = tr["best_per_out"][0] if tr["best_per_out"] else None
    if best and best["gain"] > 0:
        dec["top_transfer"] = f"{plr[best['out']]['name']} -> {plr[best['in']]['name']}"
        dec["top_transfer_gain"] = best["gain"]
    prev_dec = read_json(p("latest", "decision.json"))
    if prev_dec and prev_dec.get("captain") in proj and prev_dec.get("captain") != dec["captain"]:
        dec["captain_alt_xp"] = proj[prev_dec["captain"]]["b"][0]
    bd = N.blanks_doubles(fmap)
    ts = iso(ctx.now)
    out = {"ts": ts, "model": M.VERSION, "gws": gws, "inputs_hash": material_hash(plr, d["fx"], d["squad"]),
           "squad": d["squad"], "squad_source": d["squad_src"], "bank": d["bank"], "free_transfers_est": ft,
           "selling_prices": "estimates from config (real values need the owner's signed-in session)",
           "projections": proj, "lineups": lineups, "transfers": tr, "captain_squad": caps, "captain_pool": cap_pool,
           "blanks_doubles": bd, "fixtures": {g: fmap[g] for g in gws}, "decision": dec,
           "overrides": {k: v["source"] for k, v in M.active_overrides(cfg, ctx.now.date()).items()}}
    hrs = (datetime_from(gw["next_deadline"]) - ctx.now).total_seconds() / 3600 if gw.get("next_deadline") else 99
    archive = ctx.due("last_archive", 24 * 60 - 5) or (0 < hrs <= cfg["intervals"]["archive_deadline_hours"]
                                                        and ctx.due("last_archive", 55))
    if archive:  # git-versioned copy (forecast-vs-actual uses the last one before each deadline)
        fname = f"{ts[:13]}{ts[14:16]}Z.json.gz"
        write_json(p("projections", fname), out)
        append_jsonl(p("projections", "index.jsonl"), [{"ts": ts, "file": fname, "gws": gws, "model": M.VERSION,
                                                        "inputs_hash": out["inputs_hash"]}])
        ctx.status["last_archive"] = ts
    write_json(p("latest", "projection.json.gz"), out)
    write_json(p("latest", "decision.json"), dec)
    append_jsonl(p("history", "decisions.jsonl"), [dict(dec, ts=ts)])
    ctx.status["last_model_ok"] = ts
    ctx.status["model_inputs_hash"] = out["inputs_hash"]
    return out, prev_dec


def forecast_vs_actual(ctx, d):
    """For each finished+checked GW not yet scored, compare the last pre-deadline projection with actual points."""
    gw = d["gw"]
    done = read_json(p("validation", "scored.json"), []) or []
    idx = read_jsonl(p("projections", "index.jsonl"))
    out = []
    for g in range(1, (gw["current"] or 0) + 1):
        if g in done or (g == gw["current"] and not gw["current_data_checked"]):
            continue
        dl = parse_iso(gw["deadlines"].get(g) or gw["deadlines"].get(str(g)))
        cand = [r for r in idx if g in r["gws"] and parse_iso(r["ts"]) < dl]
        if not cand:
            continue  # no projection was made before that deadline — nothing to score (never back-filled)
        last = max(cand, key=lambda r: r["ts"])
        proj = read_json(p("projections", last["file"]))
        if not proj:
            continue
        live, ok = fetch(ctx, "live", f"/event/{g}/live/", V.live, p("cache", f"live_gw{g}.json.gz"))
        if not ok or not live:
            continue
        actual = {e["id"]: e["stats"]["total_points"] for e in live["elements"]}
        k = proj["gws"].index(g)
        rows = [(int(i), r["b"][k], actual.get(int(i))) for i, r in proj["projections"].items()
                if actual.get(int(i)) is not None and (r["b"][k] >= 2 or int(i) in proj["squad"])]
        if not rows:
            continue
        mae = sum(abs(a - b) for _, b, a in rows) / len(rows)
        bias = sum(a - b for _, b, a in rows) / len(rows)
        res = {"gw": g, "projection_ts": last["ts"], "model": last["model"], "n": len(rows), "mae": round(mae, 3),
               "bias_actual_minus_proj": round(bias, 3),
               "squad": [{"id": i, "proj": b, "actual": a} for i, b, a in rows if i in proj["squad"]]}
        write_json(p("validation", f"gw{g}.json"), res, compact=False)
        done.append(g)
        out.append(res)
    write_json(p("validation", "scored.json"), sorted(set(done)))
    return out


def consistency(ctx, d):
    """Daily full checks; returns list of (check, ok, detail)."""
    res = []
    pl = d["players"]
    res.append(("squad has 15 known players", len(d["squad"]) == 15 and all(i in pl for i in d["squad"]),
                f"{len(d['squad'])} ids"))
    tc = {}
    for i in d["squad"]:
        if i in pl:
            tc[pl[i]["team"]] = tc.get(pl[i]["team"], 0) + 1
    res.append(("≤3 per club", max(tc.values() or [0]) <= 3, str(tc)))
    gws = {f.get("event") for f in d["fx"] if f.get("event")}
    res.append(("fixtures cover GW1..38", gws == set(range(1, 39)), f"{len(gws)} GWs"))
    per = {}
    for f in d["fx"]:
        if f.get("event"):
            per[f["event"]] = per.get(f["event"], 0) + 1
    res.append(("380 fixtures total", len(d["fx"]) == 380, str(len(d["fx"]))))
    lp = read_json(p("latest", "projection.json.gz"))
    if lp:
        bad = [i for i, r in lp["projections"].items() if any(v < 0 or v > 40 for v in r["b"])]
        res.append(("projections within [0,40]", not bad, f"{len(bad)} out of range"))
        age = (ctx.now - parse_iso(lp["ts"])).total_seconds() / 3600
        res.append(("projection age < 24h", age < 24, f"{age:.1f}h"))
    pf = p("history", "prices.csv")
    if pf.exists():
        rows = list(csv.reader(open(pf)))[1:]
        dup = len(rows) - len({tuple(r) for r in rows})
        res.append(("no duplicate price rows", dup == 0, f"{dup} duplicates"))
    return res


def write_public(ctx, d, proj_out):
    cfg = ctx.cfg
    lp = proj_out or read_json(p("latest", "projection.json.gz"))
    pl = d["players"] if d else {int(k): v for k, v in (read_json(p("latest", "players.json"), {}) or {}).items()}
    teams = d["teams"] if d else {}
    st = ctx.status
    stale_after = cfg["intervals"]["stale_after_minutes"]
    obs = parse_iso(st.get("data_observed_at"))
    age = (ctx.now - obs).total_seconds() / 60 if obs else None
    fresh = "current" if age is not None and age <= stale_after else ("stale" if age is not None else "none")
    st["freshness"] = fresh
    st["data_age_minutes"] = round(age, 1) if age is not None else None
    slim = None
    if lp:
        keep = set(lp["squad"]) | set(cfg["watchlist"]["ids"]) | set(lp["captain_pool"])
        ranked = sorted(lp["projections"].items(), key=lambda kv: -sum(kv[1]["b"]))
        top = [int(i) for i, _ in ranked[:150]]
        ids = list(dict.fromkeys(list(keep) + top))
        P = lp["projections"]
        rows = []
        for i in ids:
            i = int(i)
            r = P.get(i) or P.get(str(i))
            if not r or i not in pl:
                continue
            q = pl[i]
            rows.append({"id": i, "n": q["name"], "t": teams.get(q["team"], q["team"]), "pos": N.POS[q["pos"]],
                         "c": q["cost"], "st": q["status"], "ch": q["chance"], "news": q["news"], "own": q["own"],
                         "pts": q["pts"], "mine": i in lp["squad"], "watch": i in cfg["watchlist"]["ids"], **r})
        tname = lambda i: pl[i]["name"] if i in pl else str(i)
        lus = []
        for l in lp["lineups"]:
            if l:
                lus.append({**l, "xi_n": [tname(i) for i in l["xi"]], "bench_n": [tname(i) for i in l["bench"]],
                            "captain_n": tname(l["captain"]), "vice_n": tname(l["vice"])})
        tr = lp["transfers"]
        named = lambda s: {**s, "out_n": tname(s["out"]), "in_n": tname(s["in"])}
        fxt = {}
        for g, tm in lp["fixtures"].items():
            for t, l in tm.items():
                fxt.setdefault(teams.get(int(t), t), {})[g] = [[teams.get(o, o), ha, dd] for o, ha, dd, _ in l]
        slim = {"ts": lp["ts"], "model": lp["model"], "gws": lp["gws"], "squad": lp["squad"],
                "squad_source": lp["squad_source"], "bank": lp["bank"], "free_transfers_est": lp["free_transfers_est"],
                "selling_prices": lp["selling_prices"], "players": rows, "lineups": lus,
                "transfers": {"horizon": tr["horizon"], "best_per_out": [named(s) for s in tr["best_per_out"]],
                              "pairs": [{**x, "moves_n": [[tname(a), tname(b)] for a, b in x["moves"]]} for x in tr["pairs"]]},
                "blanks_doubles": {g: {k: [teams.get(t, t) for t in v] for k, v in x.items()}
                                   for g, x in lp["blanks_doubles"].items()},
                "fixtures": fxt, "decision": lp["decision"], "overrides": lp["overrides"]}
    gwj = d["gw"] if d else read_json(p("latest", "gw.json"), {})
    alerts = read_jsonl(p("state", "alerts.jsonl"))[-60:]
    val = [read_json(p("validation", f"gw{g}.json")) for g in (read_json(p("validation", "scored.json"), []) or [])]
    prices = []
    pf = p("history", "prices.csv")
    if pf.exists():
        prices = [dict(zip(["ts", "id", "name", "old", "new"], r)) for r in list(csv.reader(open(pf)))[1:]][-80:]
    status = {k: st.get(k) for k in ("last_ingest_ok", "last_ingest_attempt", "last_model_ok", "last_alert_check",
                                      "last_validate_ok", "data_observed_at", "freshness", "data_age_minutes",
                                      "consecutive_failures", "last_error", "health", "quota", "notify_channels",
                                      "last_delivery", "warnings")}
    status["sources"] = st.get("sources")
    status["generated_at"] = iso(ctx.now)
    status["run_url"] = os.environ.get("WC_RUN_URL")
    write_json(p("public", "status.json"), status, compact=False)
    write_json(p("public", "dashboard.json"), {"status": status, "gw": gwj, "projection": slim, "alerts": alerts,
                                                "prices": prices, "validation": [v for v in val if v],
                                                "consistency": st.get("consistency")})


def quota(ctx):
    runs = read_jsonl(p("state", "runs.jsonl"))
    month = iso(ctx.now)[:7]
    mine = [r for r in runs if r.get("ts", "").startswith(month)]
    billable = sum(max(1, -(-int(r.get("secs", 60)) // 60)) for r in mine)  # GitHub rounds each job up to a minute
    return {"month": month, "runs": len(mine), "est_billable_minutes": billable,
            "private_repo_allowance": 2000, "note": "Public repos: standard runners free. Private: 2,000 min/month on Free."}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["auto", "validate", "notify-test", "export"])
    ap.add_argument("--force-model", action="store_true")
    ap.add_argument("--dry-notify", action="store_true")
    a = ap.parse_args(argv)
    cfg = load_config()
    now = now_utc()
    ctx = Ctx(cfg, now, a.dry_notify)
    dash = os.environ.get("WC_DASHBOARD_URL") or cfg["alerts"].get("dashboard_url") or ""
    ctx.status["notify_channels"] = NT.channels()

    if a.mode == "notify-test":
        test = [AL._alert(f"test|{iso(now)}", "info", "test", "WildCard.exe test notification",
                          "Manual delivery test — no action needed", observed=iso(now), source="pipeline self-test",
                          impact="none", action="Confirm you received this", confidence="n/a")]
        recs = NT.send(test, dash, test=True, dry=a.dry_notify)
        append_jsonl(p("state", "deliveries.jsonl"), [{"ts": iso(now), "test": True, "records": recs}])
        ctx.status["last_delivery"] = {"ts": iso(now), "test": True, "records": recs}
        write_json(p("state", "status.json"), ctx.status, compact=False)
        print(recs)
        return 0 if recs and all(r["ok"] for r in recs) else 1

    if a.mode == "export":
        from .export import export
        print(export())
        return 0

    ctx.status["last_ingest_attempt"] = iso(now)
    d, proj_out, fatal = None, None, None
    try:
        d = ingest(ctx)
        mh = material_hash(d["players"], d["fx"], d["squad"])
        hrs = None
        if d["gw"].get("next_deadline"):
            hrs = (parse_iso(d["gw"]["next_deadline"]) - now).total_seconds() / 3600
        gap = cfg["intervals"]["model_min_gap_minutes"]
        need = (a.force_model or a.mode == "validate" or read_json(p("latest", "projection.json.gz")) is None or ctx.due("last_model_ok", cfg["intervals"]["model_max_age_minutes"])
                or (mh != ctx.status.get("model_inputs_hash") and ctx.due("last_model_ok", gap)))
        if need:
            r = run_model(ctx, d)
            prev_dec = None
            if r:
                proj_out, prev_dec = r
        else:
            prev_dec = None
        # alerts
        prev_bd = ctx.status.get("blanks_doubles")
        bd = proj_out["blanks_doubles"] if proj_out else None
        found = AL.detect(d["prev"], d["players"], d["teams"], d["squad"], cfg["watchlist"]["ids"], d["gw"], now,
                          cfg, prev_dec, proj_out["decision"] if proj_out else read_json(p("latest", "decision.json")),
                          prev_bd, bd)
        if bd is not None:
            ctx.status["blanks_doubles"] = {str(k): v for k, v in bd.items()}
        if ctx.status.get("consecutive_failures", 0) >= 2:
            found.append(AL._alert(f"recovered|{iso(now)[:13]}", "medium", "health", "Pipeline recovered",
                                   f"Data flowing again after {ctx.status['consecutive_failures']} failed runs "
                                   f"(last error: {ctx.status.get('last_error')})", source="pipeline monitor",
                                   observed=iso(now), confidence="High"))
        st = read_json(p("state", "alerts.json"), {}) or {}
        send_now, held, st = AL.dedup_and_schedule(found, st, now, cfg)
        if send_now:
            recs = NT.send(send_now, dash, dry=ctx.dry)
            ok = any(r["ok"] for r in recs) if recs else False
            if ok or not recs:
                AL.mark_sent(send_now, st, now)
            append_jsonl(p("state", "alerts.jsonl"), [dict(x, sent_at=iso(now), delivered=ok, channels=recs)
                                                      for x in send_now])
            ctx.status["last_delivery"] = {"ts": iso(now), "n": len(send_now), "records": recs}
        write_json(p("state", "alerts.json"), st)
        ctx.status["last_alert_check"] = iso(now)
        ctx.events.append(f"alerts: {len(found)} detected, {len(send_now)} sent, {len(held)} held (quiet hours)")
        # validation
        if a.mode == "validate" or ctx.due("last_validate_ok", cfg["intervals"]["validate_hours"] * 60):
            fva = forecast_vs_actual(ctx, d)
            cons = consistency(ctx, d)
            ctx.status["consistency"] = [{"check": c, "ok": ok, "detail": det} for c, ok, det in cons]
            ctx.status["last_validate_ok"] = iso(now)
            ctx.events.append(f"validation: {sum(1 for c in cons if c[1])}/{len(cons)} checks ok, {len(fva)} GWs scored")
    except Exception as e:  # graceful degradation: keep last-known-good public files
        fatal = f"{type(e).__name__}: {e}"
        ctx.errors.append(fatal)
        traceback.print_exc()
    live_ok = bool(d and d.get("live"))
    if live_ok and not fatal:
        ctx.status["consecutive_failures"] = 0
    else:
        ctx.status["consecutive_failures"] = ctx.status.get("consecutive_failures", 0) + 1
        ctx.status["last_error"] = f"{iso(now)} {'; '.join(ctx.errors)[:500]}"
        if ctx.status["consecutive_failures"] in (2, 6, 18):
            al = [AL._alert(f"failing|{ctx.status['consecutive_failures']}|{iso(now)[:10]}", "high", "health",
                            f"Pipeline failing ({ctx.status['consecutive_failures']} runs in a row)",
                            "; ".join(ctx.errors)[:800], source="pipeline monitor", observed=iso(now),
                            impact="dashboard shows last-known-good data, labelled stale",
                            action="No action needed unless this persists >2h", confidence="High")]
            recs = NT.send(al, dash, dry=ctx.dry)
            append_jsonl(p("state", "alerts.jsonl"), [dict(al[0], sent_at=iso(now), channels=recs)])
    ctx.status["warnings"] = ctx.warnings[-20:]
    ctx.status["health"] = "ok" if not ctx.errors else ("degraded" if live_ok else "failing")
    secs = int(time.time() - ctx.t0)
    append_jsonl(p("state", "runs.jsonl"), [{"ts": iso(now), "mode": a.mode, "secs": secs, "health": ctx.status["health"],
                                             "errors": ctx.errors[:5], "events": ctx.events,
                                             "run": os.environ.get("GITHUB_RUN_ID")}])
    ctx.status["quota"] = quota(ctx)
    try:
        write_public(ctx, d, proj_out)
    except Exception as e:
        ctx.errors.append(f"write_public: {e}")
        traceback.print_exc()
    write_json(p("cache", "http.json"), ctx.http)
    write_json(p("state", "status.json"), ctx.status, compact=False)
    print(f"[{iso(now)}] health={ctx.status['health']} events={ctx.events} errors={ctx.errors} warnings={len(ctx.warnings)}")
    return 0 if ctx.status["health"] != "failing" else 2


if __name__ == "__main__":
    sys.exit(main())
