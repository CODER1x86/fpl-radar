"""Alert engine: diff fresh observations against the previous snapshot, then deduplicate and apply quiet hours."""
from __future__ import annotations

from datetime import timedelta

from .core import digest, iso, local, parse_iso

SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "info": 3}
BAD = {"i": "injured", "s": "suspended", "u": "unavailable", "n": "not in squad / ineligible", "d": "doubtful"}


def _hours_to(deadline, now):
    d = parse_iso(deadline)
    return (d - now).total_seconds() / 3600 if d else None


def _alert(key, sev, typ, title, what, *, player=None, club=None, source="FPL official API (bootstrap-static)",
           observed=None, impact="", action="", deadline=None, confidence="High (official data)"):
    return {"key": key, "severity": sev, "type": typ, "title": title, "what": what, "player": player, "club": club,
            "source": source, "observed_at": observed, "impact": impact, "action": action, "deadline": deadline,
            "confidence": confidence}


def detect(prev, cur, teams, squad, watch, gw, now, cfg, prev_dec=None, dec=None, prev_bd=None, bd=None):
    out = []
    obs = iso(now)
    hrs = _hours_to(gw.get("next_deadline"), now)
    dl = (f"GW{gw['next']} deadline {gw['next_deadline']} ({hrs:.1f}h away)" if hrs is not None else None)
    own_thr = cfg["alerts"]["ownership_threshold"]
    squad, watch = set(squad), set(watch)
    if prev:
        for i, c in cur.items():
            p = prev.get(i)
            if not p:
                continue
            mine, watched, popular = i in squad, i in watch, c["own"] >= own_thr
            if not (mine or watched or popular):
                continue
            club = teams.get(c["team"], "?")
            tag = "your squad" if mine else ("watchlist" if watched else f"{c['own']:.1f}% owned")
            # availability
            if (p["status"], p["chance"]) != (c["status"], c["chance"]):
                worse = (c["status"] != "a" and p["status"] == "a") or (
                    (c["chance"] if c["chance"] is not None else 100) < (p["chance"] if p["chance"] is not None else 100))
                if mine:
                    sev = "critical" if worse and hrs is not None and hrs < 48 else "high"
                else:
                    sev = "medium" if watched or c["own"] >= 30 else "info"
                st = BAD.get(c["status"], "available")
                ch = f" ({c['chance']}% chance)" if c["chance"] is not None else ""
                out.append(_alert(
                    f"status|{i}|{c['status']}|{c['chance']}", sev, "availability",
                    f"{c['name']} ({club}) now {st}{ch}",
                    f"Status {p['status']}/{p['chance']} -> {c['status']}/{c['chance']}. News: {c['news'] or '—'}",
                    player=c["name"], club=club, observed=c.get("news_added") or obs,
                    impact=(f"{tag}: starting-XI and captaincy affected" if mine else tag),
                    action=("Check bench order / transfer out before deadline" if mine and worse else
                            "Re-check if a transfer target" if worse else "Availability improved — re-evaluate"),
                    deadline=dl))
            elif c["news"] and c["news"] != p["news"] and (mine or watched):
                out.append(_alert(f"news|{i}|{digest(c['news'])}", "high" if mine else "medium", "news",
                                  f"News update: {c['name']} ({club})", c["news"], player=c["name"], club=club,
                                  observed=c.get("news_added") or obs, impact=tag, action="Read and re-check availability",
                                  deadline=dl))
            # price
            if abs(c["cost"] - p["cost"]) >= 0.05:
                up = c["cost"] > p["cost"]
                sev = "high" if mine else ("medium" if watched else "info")
                out.append(_alert(
                    f"price|{i}|{c['cost']:.1f}", sev, "price",
                    f"Price {'rise' if up else 'fall'}: {c['name']} ({club}) £{p['cost']:.1f}m -> £{c['cost']:.1f}m",
                    f"Net transfers this GW: {c['tin'] - c['tout']:+,}", player=c["name"], club=club, observed=obs,
                    impact=(f"{tag}: selling price may change (+/-0.1 only after a +0.2 rise)" if mine else tag),
                    action=("Budget for planned moves changed — re-check funds" if mine or watched else ""),
                    deadline=dl))
    # decision changes
    if prev_dec and dec:
        if prev_dec.get("captain") and dec.get("captain") and prev_dec["captain"] != dec["captain"]:
            out.append(_alert(f"captain|{gw.get('next')}|{dec['captain']}", "high", "model",
                              f"Model captain changed: {prev_dec.get('captain_name')} -> {dec.get('captain_name')}",
                              f"Baseline xP {dec.get('captain_xp')} vs {dec.get('captain_alt_xp')} for the previous pick",
                              source=f"Model {dec.get('model')}", observed=obs, impact="your captaincy",
                              action="Review captain before deadline", deadline=dl,
                              confidence="Model output — medium"))
        a, b = prev_dec.get("top_transfer"), dec.get("top_transfer")
        if b and a != b and dec.get("top_transfer_gain", 0) >= 2.0:
            out.append(_alert(f"transfer|{gw.get('next')}|{b}", "medium", "model", f"Top transfer now: {b}",
                              f"3-GW baseline gain +{dec.get('top_transfer_gain')} (was: {a or 'none'})",
                              source=f"Model {dec.get('model')}", observed=obs, impact="transfer plan",
                              action="Compare with your planned moves", deadline=dl,
                              confidence="Model output — medium"))
    # doubles / blanks newly visible
    if prev_bd is not None and bd is not None:
        for g, v in bd.items():
            pv = prev_bd.get(str(g)) or prev_bd.get(g) or {"doubles": [], "blanks": []}
            for kind in ("doubles", "blanks"):
                new = set(v[kind]) - set(pv[kind])
                if new:
                    names = ", ".join(teams.get(t, str(t)) for t in sorted(new))
                    out.append(_alert(f"{kind}|{g}|{','.join(map(str, sorted(new)))}", "high", "fixtures",
                                      f"GW{g} {kind[:-1]}: {names}", "Official fixture list changed",
                                      source="FPL official API (fixtures)", observed=obs,
                                      impact="chip planning (Bench Boost / Free Hit / Triple Captain)",
                                      action="Re-plan chips and transfers", deadline=dl))
    # deadline reminders
    if hrs is not None:
        for w in sorted(cfg["alerts"]["deadline_warn_hours"]):
            if 0 < hrs <= w:
                out.append(_alert(f"deadline|{gw['next']}|{w}", "high" if w <= 3 else "medium", "deadline",
                                  f"GW{gw['next']} deadline in {hrs:.1f}h",
                                  f"Deadline {gw['next_deadline']} UTC; local "
                                  f"{local(parse_iso(gw['next_deadline']), cfg['manager']['timezone']):%a %d %b %H:%M}",
                                  source="FPL official API (events)", observed=obs, impact="all decisions",
                                  action=(f"Model: captain {dec.get('captain_name')}, top move {dec.get('top_transfer') or 'roll'}"
                                          if dec else "Review team"), deadline=dl))
                break
    out.sort(key=lambda a: SEV_ORDER[a["severity"]])
    return out


def dedup_and_schedule(alerts, state, now, cfg):
    """Returns (send_now, held, state). state = {'sent': {key: ts}, 'held': [alerts]}."""
    sent = state.setdefault("sent", {})
    held = state.setdefault("held", [])
    horizon = timedelta(hours=cfg["alerts"]["dedup_hours"])
    for k in [k for k, t in sent.items() if now - parse_iso(t) > timedelta(days=14)]:
        del sent[k]
    hour = local(now, cfg["manager"]["timezone"]).hour
    qs, qe = cfg["alerts"]["quiet_start_hour"], cfg["alerts"]["quiet_end_hour"]
    quiet = (qs <= hour < qe) if qs < qe else (hour >= qs or hour < qe)
    fresh = []
    keys = set()
    for a in alerts:
        t = sent.get(a["key"])
        if (t and now - parse_iso(t) < horizon) or a["key"] in keys:
            continue
        keys.add(a["key"])
        fresh.append(a)
    now_list, new_held = [], []
    for a in fresh:
        if quiet and a["severity"] in ("medium", "info"):
            new_held.append(a)
        else:
            now_list.append(a)
    if not quiet and held:
        now_list.extend(h for h in held if h["key"] not in keys)
        held = []
    held = [h for h in held if h["key"] not in keys] + new_held
    state["held"] = held
    return now_list, new_held, state


def mark_sent(alerts, state, now):
    for a in alerts:
        state["sent"][a["key"]] = iso(now)
