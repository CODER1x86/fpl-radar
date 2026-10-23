"""WildCard.exe projection engine (port of m3.py + build.py; fixtures come from the live API, doubles/blanks supported).

Outputs per player and upcoming GW: baseline xP, conservative xP, Monte-Carlo P90 upside, ceiling probabilities,
start probability and expected minutes. Then squad lineup, captaincy ranking and transfer search.
"""
from __future__ import annotations

import math
from datetime import date

import numpy as np

from .normalize import POS

GP = {1: 6, 2: 6, 3: 5, 4: 4}
CSP = {1: 4, 2: 4, 3: 1, 4: 0}
DCT = {1: 99, 2: 10, 3: 12, 4: 12}
PRIOR = {1: (0, 0), 2: (0.05, 0.05), 3: (0.20, 0.15), 4: (0.40, 0.08)}
AM = {1: 1.30, 2: 1.20, 3: 1.0, 4: 0.82, 5: 0.68}
DM = {1: 0.65, 2: 0.75, 3: 1.0, 4: 1.25, 5: 1.5}
VERSION = "m3-cloud-1.0"


def ptail(mu, k):
    if mu <= 0:
        return 0.0
    s, t = 0.0, math.exp(-mu)
    for j in range(k):
        s += t
        t *= mu / (j + 1)
    return max(0.0, 1 - s)


def team_games_played(fx) -> dict[int, int]:
    n = {t: 0 for t in range(1, 21)}
    for f in fx:
        if f.get("finished"):
            n[f["team_h"]] += 1
            n[f["team_a"]] += 1
    return n


def active_overrides(cfg, today: date) -> dict[int, dict]:
    out = {}
    for o in cfg.get("overrides", []):
        try:
            if date.fromisoformat(o["expires"]) >= today:
                out[o["id"]] = o
        except (KeyError, ValueError):
            continue
    return out


def start_prob(p, g, k, played, europe, ovr, cons):
    PM = 0.95 if cons else 1.0
    n = max(1, played.get(p["team"], 1))
    base = min(0.95, p["starts"] / n) * PM
    if p["team"] in europe and p["pos"] != 1:
        base *= 0.95
    pr = base
    if p["status"] in ("i", "s", "u", "n"):
        pr = [0, 0, .25, .5, .5][min(k, 4)] * base
    if p["status"] == "d" and p["chance"] is not None and k == 0:
        pr = base * p["chance"] / 100
    o = ovr.get(p["id"])
    if o:
        idx = g - o.get("start_gw", g)
        av = o["availability"]
        if 0 <= idx < len(av):
            pr = av[idx] * PM
        elif idx >= len(av):
            pr = av[-1] * PM if av else pr
    return pr


def params(p, g, k, opp_list, played, europe, ovr, cons=False):
    """List of per-fixture parameter dicts for player p in GW g (empty list = blank)."""
    m, pos = p["mins"], p["pos"]
    if pos not in GP or m <= 0:
        return []
    W = 0.5 if cons else 0.75
    BS = 0.5 if cons else 0.7
    mps = min(90, m / p["starts"]) if p["starts"] else min(60, m)
    f = mps / 90
    w = min(1, m / 630) * W
    xg90 = w * (p["xg"] / m * 90) + (1 - w) * PRIOR[pos][0]
    xa90 = w * (p["xa"] / m * 90) + (1 - w) * PRIOR[pos][1]
    xgc90 = p["xgc"] / m * 90
    dcmu = p["dc"] / m * 90 * f
    bon = (p["bonus"] / m * 90 * BS + (1 - BS) * 0.3) * f
    sav = p["saves"] / m * 90
    pr = start_prob(p, g, k, played, europe, ovr, cons)
    out = []
    for opp, ha, d, ko in opp_list:
        lam = xgc90 * DM[d]
        out.append(dict(pr=pr, f=f, mps=mps, eg=xg90 * f * AM[d], ea=xa90 * f * AM[d], lam=lam,
                        pdc=ptail(dcmu, DCT[pos]), bon=bon, sav=sav, pos=pos, fdr=d, opp=opp, ha=ha))
    return out


def xp_of(q):
    pos = q["pos"]
    return q["pr"] * (2 + q["eg"] * GP[pos] + q["ea"] * 3 + CSP[pos] * math.exp(-q["lam"])
                      - (0.5 * q["lam"] if pos <= 2 else 0) + 2 * q["pdc"] + q["bon"]
                      + (q["sav"] / 3 if pos == 1 else 0)) + 0.05


def simulate(qs_by_gw, ns, rng):
    out = np.zeros((ns, len(qs_by_gw)))
    for k, qs in enumerate(qs_by_gw):
        for q in qs:
            if q["pr"] <= 0:
                continue
            pos = q["pos"]
            plays = rng.random(ns) < q["pr"]
            cameo = (~plays) & (rng.random(ns) < 0.07)
            G = rng.poisson(q["eg"], ns)
            A = rng.poisson(q["ea"], ns)
            GC = rng.poisson(q["lam"], ns)
            CS = GC == 0
            DC = rng.random(ns) < q["pdc"]
            ret = 2 * G + A + (CS * (pos <= 2))
            mu = 2 * q["eg"] + q["ea"] + (math.exp(-q["lam"]) if pos <= 2 else 0)
            scale = q["bon"] / mu if mu > 0 else 0
            B = np.minimum(3, np.round(ret * scale + (rng.random(ns) < 0.05)))
            pts = (2 + GP[pos] * G + 3 * A + CSP[pos] * CS - (GC // 2 if pos <= 2 else 0) + 2 * DC + B
                   + ((rng.poisson(q["sav"], ns) // 3) if pos == 1 else 0))
            out[:, k] += np.where(plays, pts, 0) + cameo * 1
    return out


def project(players, fmap, fx, gws, cfg, today: date, squad_ids=()):
    mc = cfg["model"]
    europe = set(mc.get("europe_teams", []))
    ovr = active_overrides(cfg, today)
    played = team_games_played(fx)
    rng = np.random.default_rng(mc.get("seed", 8))
    ns = int(mc.get("simulations", 6000))
    squad = set(squad_ids)
    res = {}
    for i, p in players.items():
        if p["pos"] not in GP:
            continue
        qb = [params(p, g, k, fmap[g].get(p["team"], []), played, europe, ovr) for k, g in enumerate(gws)]
        qc = [params(p, g, k, fmap[g].get(p["team"], []), played, europe, ovr, cons=True) for k, g in enumerate(gws)]
        b = [sum(xp_of(q) for q in qs) if p["mins"] > 0 else 0.0 for qs in qb]
        c = [sum(xp_of(q) for q in qs) if p["mins"] > 0 else 0.0 for qs in qc]
        rec = {"id": i, "b": [round(v, 2) for v in b], "c": [round(v, 2) for v in c]}
        if p["mins"] > 0 and (i in squad or sum(b) >= 8 or p["own"] >= 5):
            sim = simulate(qb, ns, rng)
            g1, s3, s5 = sim[:, 0], sim[:, :3].sum(1), sim.sum(1)
            rec.update(u1=round(float(np.percentile(g1, 90)), 1), u3=round(float(np.percentile(s3, 90)), 1),
                       u5=round(float(np.percentile(s5, 90)), 1), mc1=round(float(g1.mean()), 2),
                       h1=round(float((g1 >= 10).mean()), 3), h3=round(float((s3 >= 25).mean()), 3),
                       h5=round(float((s5 >= 40).mean()), 3), cap20=round(float((2 * g1 >= 20).mean()), 3),
                       blank=round(float((g1 <= 2).mean()), 3))
        q0 = qb[0][0] if qb[0] else None
        rec["sp"] = round(q0["pr"], 2) if q0 else 0.0
        rec["em"] = round(q0["pr"] * q0["mps"] + 0.07 * 20, 0) if q0 else 0.0
        rec["ngw"] = [len(qs) for qs in qb]
        rec["conf"] = ("High" if p["mins"] >= 540 and p["status"] == "a" else
                       "Low" if p["mins"] < 270 or p["status"] in ("i", "s", "u", "n") else "Medium")
        rec["ovr"] = ovr[i]["source"] if i in ovr else None
        res[i] = rec
    return res


# ------------------------------------------------------------------ squad decisions
FORMS = [(d, m, 10 - d - m) for d in range(3, 6) for m in range(2, 6) if 1 <= 10 - d - m <= 3]


def best_xi(ids, players, xp_fn):
    by = {1: [], 2: [], 3: [], 4: []}
    for i in ids:
        by[players[i]["pos"]].append(i)
    for k in by:
        by[k].sort(key=lambda i: -xp_fn(i))
    if not by[1]:
        return None
    best = None
    for d, m, f in FORMS:
        if len(by[2]) < d or len(by[3]) < m or len(by[4]) < f:
            continue
        xi = [by[1][0]] + by[2][:d] + by[3][:m] + by[4][:f]
        v = sum(xp_fn(i) for i in xi)
        if best is None or v > best[0]:
            best = (v, xi, f"{d}-{m}-{f}")
    if best is None:
        return None
    v, xi, form = best
    cap = max(xi, key=xp_fn)
    vice = max((i for i in xi if i != cap), key=xp_fn)
    bench_out = sorted((i for i in ids if i not in xi and players[i]["pos"] != 1), key=lambda i: -xp_fn(i))
    gk2 = [i for i in by[1][1:]]
    return {"xi": xi, "formation": form, "captain": cap, "vice": vice, "bench": gk2 + bench_out,
            "xp": round(v + xp_fn(cap), 2)}


def squad_value(ids, players, proj, n):
    tot = 0.0
    for k in range(n):
        r = best_xi(ids, players, lambda i, k=k: proj[i]["b"][k] if i in proj else 0.0)
        tot += r["xp"] if r else 0.0
    return tot


def transfer_search(squad, players, proj, bank, sell, n=3, top=40, ft=1):
    """Single transfers ranked by n-GW gain using baseline xP; then the best pair of distinct singles."""
    cur_val = squad_value(squad, players, proj, n)
    team_count = {}
    for i in squad:
        team_count[players[i]["team"]] = team_count.get(players[i]["team"], 0) + 1
    pool = {}
    for pos in (1, 2, 3, 4):
        c = [i for i, p in players.items() if p["pos"] == pos and i not in squad and i in proj
             and p["status"] not in ("u", "n")]
        c.sort(key=lambda i: -sum(proj[i]["b"][:n]))
        pool[pos] = c[:top]
    singles = []
    for o in squad:
        po = players[o]
        budget = bank + sell.get(o, po["cost"])
        for i in pool[po["pos"]]:
            pi = players[i]
            if pi["cost"] > budget + 1e-9:
                continue
            if pi["team"] != po["team"] and team_count.get(pi["team"], 0) >= 3:
                continue
            new = [x for x in squad if x != o] + [i]
            gain = squad_value(new, players, proj, n) - cur_val
            singles.append({"out": o, "in": i, "gain": round(gain, 2), "bank_after": round(budget - pi["cost"], 1)})
    singles.sort(key=lambda s: -s["gain"])
    seen_out, ranked = set(), []
    for s in singles:
        if s["out"] in seen_out:
            continue
        seen_out.add(s["out"])
        ranked.append(s)
    pairs = []
    cand = singles[:60]
    for a in range(len(cand)):
        for b in range(a + 1, len(cand)):
            s1, s2 = cand[a], cand[b]
            if s1["out"] == s2["out"] or s1["in"] == s2["in"]:
                continue
            outs, ins = {s1["out"], s2["out"]}, [s1["in"], s2["in"]]
            spend = sum(players[i]["cost"] for i in ins)
            funds = bank + sum(sell.get(o, players[o]["cost"]) for o in outs)
            if spend > funds + 1e-9:
                continue
            new = [x for x in squad if x not in outs] + ins
            tc = {}
            for x in new:
                tc[players[x]["team"]] = tc.get(players[x]["team"], 0) + 1
            if max(tc.values()) > 3:
                continue
            gain = squad_value(new, players, proj, n) - cur_val
            hit = 0 if ft >= 2 else 4
            pairs.append({"moves": [[s1["out"], s1["in"]], [s2["out"], s2["in"]]], "gain": round(gain, 2),
                          "net": round(gain - hit, 2), "hit": hit, "bank_after": round(funds - spend, 1)})
    pairs.sort(key=lambda s: -s["net"])
    return {"horizon": n, "current_value": round(cur_val, 2), "best_per_out": ranked[:15], "singles": singles[:25],
            "pairs": pairs[:10]}


def free_transfers(history: dict | None, upto_gw: int) -> int | None:
    """Estimate banked free transfers for GW upto_gw from public history (rules: +1 per GW, cap 5;
    WC/FH weeks keep the count). Returns None if history unavailable."""
    if not history or not history.get("current"):
        return None
    chips = {c["event"]: c["name"] for c in history.get("chips", [])}
    rows = {r["event"]: r for r in history["current"]}
    ft = 1
    for g in range(2, upto_gw):
        r = rows.get(g)
        if r is None:
            ft = min(5, ft + 1)
            continue
        if chips.get(g) in ("wildcard", "freehit"):
            pass
        else:
            ft = max(0, ft - r.get("event_transfers", 0))
        ft = min(5, ft + 1)
    return ft


def pos_name(p):
    return POS.get(p["pos"], "?")
