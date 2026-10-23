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
    res, sims = {}, {}
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
            sims[i] = g1
            rec.update(u1=round(float(np.percentile(g1, 90)), 1), u3=round(float(np.percentile(s3, 90)), 1),
                       u5=round(float(np.percentile(s5, 90)), 1), mc1=round(float(g1.mean()), 2),
                       h1=round(float((g1 >= 10).mean()), 3), h3=round(float((s3 >= 25).mean()), 3),
                       h5=round(float((s5 >= 40).mean()), 3), cap20=round(float((2 * g1 >= 20).mean()), 3),
                       blank=round(float((g1 <= 2).mean()), 3), sd1=round(float(g1.std()), 2))
        q0 = qb[0][0] if qb[0] else None
        rec["sp"] = round(q0["pr"], 2) if q0 else 0.0
        rec["em"] = round(q0["pr"] * q0["mps"] + 0.07 * 20, 0) if q0 else 0.0
        rec["ngw"] = [len(qs) for qs in qb]
        rec["conf"] = ("High" if p["mins"] >= 540 and p["status"] == "a" else
                       "Low" if p["mins"] < 270 or p["status"] in ("i", "s", "u", "n") else "Medium")
        rec["ovr"] = ovr[i]["source"] if i in ovr else None
        res[i] = rec
    return res, sims


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


def dream_team(players, proj, k=0, per_pos=25, max_club=3):
    """Highest-xP valid XI for GW index k (formation rules, max 3 per club, no budget limit)."""
    pool = {pos: sorted((i for i in proj if players.get(i, {}).get("pos") == pos and players[i]["status"] not in ("u", "n")),
                        key=lambda i: -proj[i]["b"][k])[:per_pos] for pos in (1, 2, 3, 4)}
    best = None
    for d, m, f in FORMS:
        need = {1: 1, 2: d, 3: m, 4: f}
        cand = sorted((i for pos in pool for i in pool[pos]), key=lambda i: -proj[i]["b"][k])
        got, clubs = {1: [], 2: [], 3: [], 4: []}, {}
        for i in cand:
            pos, t = players[i]["pos"], players[i]["team"]
            if len(got[pos]) < need[pos] and clubs.get(t, 0) < max_club:
                got[pos].append(i)
                clubs[t] = clubs.get(t, 0) + 1
        xi = got[1] + got[2] + got[3] + got[4]
        if len(xi) != 11:
            continue
        v = sum(proj[i]["b"][k] for i in xi)
        if best is None or v > best[0]:
            best = (v, xi, f"{d}-{m}-{f}")
    if not best:
        return None
    v, xi, form = best
    cap = max(xi, key=lambda i: proj[i]["b"][k])
    return {"xi": xi, "formation": form, "captain": cap, "xp": round(v + proj[cap]["b"][k], 2),
            "cost": round(sum(players[i]["cost"] for i in xi), 1)}


def team_distribution(xi, captain, proj, sims, k=0, thresholds=(40, 50, 60, 70, 80)):
    """Distribution of a lineup's GW points from the per-player Monte-Carlo draws (captain doubled).
    Players are simulated independently, so the spread is somewhat understated (no team/match correlation)."""
    n = len(next(iter(sims.values()))) if sims else 0
    if not n:
        return None
    tot = np.zeros(n)
    for i in xi + [captain]:
        tot += sims[i] if i in sims else proj.get(i, {"b": [0] * (k + 1)})["b"][k]
    return {"mean": round(float(tot.mean()), 1), "p10": round(float(np.percentile(tot, 10)), 0),
            "p50": round(float(np.percentile(tot, 50)), 0), "p90": round(float(np.percentile(tot, 90)), 0),
            "prob": {str(t): round(float((tot >= t).mean()), 3) for t in thresholds},
            "note": "independent-player simulation; real spread is wider"}


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


# ------------------------------------------------------------------ gameweek plan, chips, scenarios
def weighted_value(ids, players, proj, weights):
    tot = 0.0
    for k, w in enumerate(weights):
        r = best_xi(ids, players, lambda i, k=k: proj[i]["b"][k] if i in proj else 0.0)
        tot += w * (r["xp"] if r else 0.0)
    return tot


def plan_transfers(squad, players, proj, bank, sell, ft, weights, roll_value=1.5, hit=4.0, max_moves=None, top=35):
    """Greedy multi-transfer plan: keep adding the best single move while its weighted xP gain beats the
    cost of making it (a banked free transfer is worth `roll_value`; beyond free transfers each costs a -4 hit)."""
    cur = list(squad)
    sp = {i: sell.get(i, players[i]["cost"]) for i in cur}
    money = bank or 0.0
    base = weighted_value(cur, players, proj, weights)
    start = base
    ft = ft if ft is not None else 1
    max_moves = max_moves if max_moves is not None else ft + 2
    pool = {}
    score = lambda i: sum(w * proj[i]["b"][k] for k, w in enumerate(weights)) if i in proj else 0
    for pos in (1, 2, 3, 4):
        c = [i for i, p in players.items() if p["pos"] == pos and i in proj and p["status"] not in ("u", "n")]
        pool[pos] = sorted(c, key=lambda i: -score(i))[:top]
    moves, stop = [], None
    while len(moves) < max_moves:
        tc = {}
        for x in cur:
            tc[players[x]["team"]] = tc.get(players[x]["team"], 0) + 1
        best = None
        for o in cur:
            po = players[o]
            budget = money + sp[o]
            for i in pool[po["pos"]]:
                if i in cur or players[i]["cost"] > budget + 1e-9:
                    continue
                if players[i]["team"] != po["team"] and tc.get(players[i]["team"], 0) >= 3:
                    continue
                v = weighted_value([x for x in cur if x != o] + [i], players, proj, weights)
                if best is None or v > best[0]:
                    best = (v, o, i)
        if not best:
            stop = "no affordable improvement"
            break
        v, o, i = best
        gain = v - base
        free = len(moves) < ft
        # a free transfer that would otherwise be lost to the 5-transfer cap is (almost) free to use
        need = (0.3 if ft - len(moves) >= 5 else roll_value) if free else hit
        if gain <= need:
            stop = {"next_out": o, "next_in": i, "next_gain": round(gain, 2), "threshold": need,
                    "reason": "next move not worth a free transfer" if free else "next move not worth a -4 hit"}
            break
        money = money + sp[o] - players[i]["cost"]
        cur = [x for x in cur if x != o] + [i]
        sp[i] = players[i]["cost"]
        moves.append({"out": o, "in": i, "gain": round(gain, 2), "type": "free" if free else "hit",
                      "bank_after": round(money, 1)})
        base = v
    hits = sum(1 for m in moves if m["type"] == "hit")
    return {"moves": moves, "squad": cur, "gain": round(base - start, 2), "net": round(base - start - 4 * hits, 2),
            "hits": hits, "ft_used": min(len(moves), ft), "ft_after": None if ft is None else min(5, ft - min(len(moves), ft) + 1),
            "bank_after": round(money, 1), "selling": sp, "stop": stop, "weights": weights}


def budget_xi(players, proj, k, budget, max_club=3):
    """Best XI under a money limit (greedy downgrade from the unconstrained best XI)."""
    d = dream_team(players, proj, k)
    if not d:
        return None
    xi = list(d["xi"])
    cost = lambda ids: sum(players[i]["cost"] for i in ids)
    guard = 0
    while cost(xi) > budget + 1e-9 and guard < 40:
        guard += 1
        tc = {}
        for x in xi:
            tc[players[x]["team"]] = tc.get(players[x]["team"], 0) + 1
        best = None
        for o in xi:
            for i, p in players.items():
                if i in xi or i not in proj or p["pos"] != players[o]["pos"] or p["cost"] >= players[o]["cost"]:
                    continue
                if p["status"] in ("u", "n") or (p["team"] != players[o]["team"] and tc.get(p["team"], 0) >= 3):
                    continue
                loss = proj[o]["b"][k] - proj[i]["b"][k]
                save = players[o]["cost"] - p["cost"]
                r = loss / save
                if best is None or r < best[0]:
                    best = (r, o, i)
        if not best:
            break
        _, o, i = best
        xi = [x for x in xi if x != o] + [i]
    cap = max(xi, key=lambda i: proj[i]["b"][k])
    return {"xi": xi, "captain": cap, "xp": round(sum(proj[i]["b"][k] for i in xi) + proj[cap]["b"][k], 2),
            "cost": round(cost(xi), 1)}


CHIP_NAMES = {"wildcard": "Wildcard", "freehit": "Free Hit", "bboost": "Bench Boost", "3xc": "Triple Captain"}


def wildcard_squad(squad, players, proj, funds, weights):
    """Approximate wildcard: best weighted-horizon XI under budget plus the cheapest valid bench."""
    pseudo = {i: {"b": [sum(w * r["b"][k] for k, w in enumerate(weights))]} for i, r in proj.items()}
    xi = budget_xi(players, pseudo, 0, funds - 16.5)
    if not xi:
        return {"gain": 0.0, "changes": [], "squad": squad}
    have = {1: 0, 2: 0, 3: 0, 4: 0}
    for i in xi["xi"]:
        have[players[i]["pos"]] += 1
    need = {1: 2 - have[1], 2: 5 - have[2], 3: 5 - have[3], 4: 3 - have[4]}
    tc = {}
    for i in xi["xi"]:
        tc[players[i]["team"]] = tc.get(players[i]["team"], 0) + 1
    bench = []
    for pos, n in need.items():
        cands = sorted((i for i, p in players.items() if p["pos"] == pos and i not in xi["xi"] and p["status"] == "a"
                        and p["mins"] > 0), key=lambda i: (players[i]["cost"], -pseudo.get(i, {"b": [0]})["b"][0]))
        for i in cands:
            if n <= 0:
                break
            if tc.get(players[i]["team"], 0) < 3:
                bench.append(i)
                tc[players[i]["team"]] = tc.get(players[i]["team"], 0) + 1
                n -= 1
    new = xi["xi"] + bench
    total_cost = sum(players[i]["cost"] for i in new)
    if len(new) != 15 or total_cost > funds + 1e-9:
        return {"gain": 0.0, "changes": [], "squad": squad}
    gain = weighted_value(new, players, proj, weights) - weighted_value(squad, players, proj, weights)
    return {"gain": round(gain, 2), "changes": sorted(set(new) - set(squad)), "squad": new, "cost": round(total_cost, 1)}


def chips_plan(squad, players, proj, gws, history, bank, sell, weights):
    nxt = gws[0]
    half = (1, 19) if nxt <= 19 else (20, 38)
    used = {}
    for c in (history or {}).get("chips", []):
        if half[0] <= c.get("event", 0) <= half[1]:
            used[c["name"]] = c["event"]
    funds = (bank or 0) + sum(sell.get(i, players[i]["cost"]) for i in squad)
    per = {"3xc": [], "bboost": [], "freehit": []}
    for k, g in enumerate(gws):
        r = best_xi(squad, players, lambda i, k=k: proj[i]["b"][k] if i in proj else 0.0)
        if not r:
            continue
        per["3xc"].append({"gw": g, "value": round(proj[r["captain"]]["b"][k], 2), "who": r["captain"]})
        per["bboost"].append({"gw": g, "value": round(sum(proj[i]["b"][k] for i in r["bench"] if i in proj), 2)})
        fh = budget_xi(players, proj, k, funds - 16.5)
        per["freehit"].append({"gw": g, "value": round((fh["xp"] - r["xp"]) if fh else 0, 2), "xi": fh})
    wc = wildcard_squad(squad, players, proj, funds, weights)
    thresholds = {"3xc": 9.0, "bboost": 10.0, "freehit": 12.0, "wildcard": 15.0}
    out = []
    for c in ("wildcard", "freehit", "bboost", "3xc"):
        row = {"chip": c, "name": CHIP_NAMES[c], "available": c not in used, "used_gw": used.get(c),
               "expires_gw": half[1], "gws_left_in_half": half[1] - nxt + 1, "threshold": thresholds[c]}
        if c == "wildcard":
            row["value_now"] = wc["gain"]
            row["series"] = [{"gw": nxt, "value": wc["gain"]}]
            row["best_gw"] = nxt
            row["moves"] = len(wc["changes"])
            row["squad"] = wc["squad"]
        else:
            s = per[c]
            b = max(s, key=lambda x: x["value"]) if s else None
            row["series"] = [{"gw": x["gw"], "value": x["value"], **({"who": x["who"]} if "who" in x else {})} for x in s]
            row["value_now"] = s[0]["value"] if s else None
            row["best_gw"] = b["gw"] if b else None
        if not row["available"]:
            row["verdict"] = "used"
        elif row["best_gw"] == nxt and (row["value_now"] or 0) >= thresholds[c]:
            row["verdict"] = "use_now"
        elif half[1] - nxt + 1 <= 2 and row["available"]:
            row["verdict"] = "use_before_expiry"
        else:
            row["verdict"] = "hold"
        out.append(row)
    return {"half": half, "horizon_last_gw": gws[-1], "chips": out,
            "note": "Values are model xP gains within the projected horizon only; doubles/blanks beyond it are not known yet."}


def scenario(name, xi, players, proj, sims, mine, captain=None, k=0):
    xi = [i for i in xi if i in proj and i in players]
    if not xi:
        return None
    cap = captain if captain in xi else max(xi, key=lambda i: proj[i]["b"][k])
    rest = [i for i in xi if i != cap]
    vice = max(rest, key=lambda i: proj[i]["b"][k]) if rest else None
    xp = sum(proj[i]["b"][k] for i in xi) + proj[cap]["b"][k]
    return {"key": name, "xi": xi, "captain": cap, "vice": vice, "xp": round(xp, 2),
            "cost": round(sum(players[i]["cost"] for i in xi), 1),
            "dist": team_distribution(xi, cap, proj, sims, k),
            "overlap": sorted(set(xi) & set(mine)), "differentials": sorted(set(xi) - set(mine))}
