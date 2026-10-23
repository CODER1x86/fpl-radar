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
        if dec.get("plan_key") and prev_dec.get("plan_key") and dec["plan_key"] != prev_dec["plan_key"]:
            out.append(_alert(f"plan|{gw.get('next')}|{dec['plan_key']}", "high" if hrs is not None and hrs < 48 else "medium",
                              "plan", f"GW{gw.get('next')} plan updated — new best final team",
                              dec.get("plan_text", ""), source=f"Model {dec.get('model')} (re-run after new data)",
                              observed=obs, impact="your transfers / XI / bench / captain",
                              action="Apply the updated plan in the FPL app (open FPL Radar → GW plan)", deadline=dl,
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
    # deadline reminders — planned from the real (UTC) deadline of THIS gameweek
    plan = deadline_plan(gw.get("next"), gw.get("next_deadline"), now, cfg)
    due = [r for r in plan if parse_iso(r["at"]) <= now < parse_iso(gw["next_deadline"])]
    if due:
        r = due[-1]  # only the most recent due reminder (a delayed run never sends a backlog)
        flagged = [f"{cur[i]['name']} ({cur[i]['status']}{' ' + str(cur[i]['chance']) + '%' if cur[i]['chance'] is not None else ''})"
                   for i in squad if i in cur and cur[i]["status"] != "a"]
        sev = r["severity"]
        if r["label"] == "final" and flagged:
            sev = "critical"
        out.append(_alert(
            f"deadline|{gw['next']}|{gw['next_deadline']}|{r['label']}", sev, "deadline",
            f"GW{gw['next']} deadline in {_fmt_left(hrs)} — {when_text(gw['next_deadline'], cfg)}",
            ("Final check before the deadline. " if r["label"] == "final" else "") +
            (f"Flagged in your squad: {', '.join(flagged)}. " if flagged else "No flagged players in your squad. ") +
            (f"Model: captain {dec.get('captain_name')}, top move {dec.get('top_transfer') or 'roll the transfer'}"
             f"{' (+' + str(dec.get('top_transfer_gain')) + ' xP over 3 GWs)' if dec and dec.get('top_transfer') else ''}."
             if dec else ""),
            source="FPL official API (events.deadline_time, UTC)", observed=obs, impact="all GW decisions",
            action=r["action"] + (f". Current best plan — {dec.get('plan_text')}" if dec and dec.get("plan_text") else ""),
            deadline=dl, confidence="Deadline: official. Recommendations: model output"))
    out.sort(key=lambda a: SEV_ORDER[a["severity"]])
    return out


# ------------------------------------------------------------------ deadline-aware timing
def _fmt_left(hrs):
    if hrs is None:
        return "?"
    h, m = int(hrs), int(round((hrs - int(hrs)) * 60))
    return f"{h}h {m:02d}m" if h < 48 else f"{hrs / 24:.1f} days"


def when_text(deadline_iso, cfg):
    """Deadline in UTC plus the owner's zone and UK time, all via IANA tz data (DST-correct for that date)."""
    d = parse_iso(deadline_iso)
    tz = cfg["manager"]["timezone"]
    return (f"{local(d, tz):%a %d %b %H:%M} {local(d, tz).tzname()} ({tz}) · "
            f"{local(d, 'Europe/London'):%H:%M} {local(d, 'Europe/London').tzname()} UK · {d:%H:%M} UTC")


def in_quiet(dt, cfg):
    h = local(dt, cfg["manager"]["timezone"]).hour
    qs, qe = cfg["alerts"]["quiet_start_hour"], cfg["alerts"]["quiet_end_hour"]
    return (qs <= h < qe) if qs < qe else (h >= qs or h < qe)


def _before_quiet(dt, cfg):
    """Latest moment before the quiet window that contains dt (owner's local time, DST-aware)."""
    from datetime import datetime as _dt, timedelta as _td
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(cfg["manager"]["timezone"])
    loc = dt.astimezone(tz)
    qs = cfg["alerts"]["quiet_start_hour"]
    start_day = loc.date() if loc.hour >= qs else (loc - _td(days=1)).date()
    start = _dt(start_day.year, start_day.month, start_day.day, qs, 0, tzinfo=tz)
    return (start - _td(minutes=cfg["alerts"]["deadline"]["pre_quiet_minutes"])).astimezone(dt.tzinfo)


def deadline_plan(gw_id, deadline_iso, now, cfg):
    """Reminder schedule for one gameweek, computed from its real UTC deadline.

    - offsets come from config (e.g. 48h, 24h, 6h, 2h, final 75m);
    - a reminder that would land in quiet hours is moved to just before quiet hours start (the evening before);
    - reminders that collapse onto each other are merged (the later, more urgent one is kept);
    - the deadline itself always comes from the API, so a moved deadline produces a new plan automatically."""
    d = parse_iso(deadline_iso)
    if not d or not gw_id:
        return []
    c = cfg["alerts"]["deadline"]
    rows = []
    for h in c["reminder_hours"]:
        at = d - timedelta(hours=h)
        label = f"T-{h:g}h"
        sev = "medium" if h >= 24 else "high"
        action = ("Plan transfers / chips; watch press conferences" if h >= 24 else
                  "Lock in transfers; check press-conference news" if h >= 4 else
                  "Final team check: transfers, captain, bench order")
        rows.append({"label": label, "target": at, "severity": sev, "action": action})
    fm = c["final_check_minutes"]
    rows.append({"label": "final", "target": d - timedelta(minutes=fm), "severity": "high",
                 "action": "Last chance: confirm XI, captain/vice, bench order and transfers"})
    plan = []
    for r in sorted(rows, key=lambda r: r["target"]):
        at, moved = r["target"], False
        if in_quiet(at, cfg):
            at, moved = _before_quiet(at, cfg), True
        plan.append({**r, "at": at, "moved": moved})
    merged = []
    gap = timedelta(minutes=c["merge_within_minutes"])
    for r in sorted(plan, key=lambda r: r["at"]):
        if merged and r["at"] - merged[-1]["at"] < gap:
            merged[-1] = r if SEV_ORDER[r["severity"]] <= SEV_ORDER[merged[-1]["severity"]] else merged[-1]
            continue
        merged.append(r)
    return [{"gw": gw_id, "label": r["label"], "at": iso(r["at"]), "target": iso(r["target"]), "moved": r["moved"],
             "severity": r["severity"], "action": r["action"],
             "local": f"{local(r['at'], cfg['manager']['timezone']):%a %d %b %H:%M %Z}"} for r in merged
            if r["at"] < d]


def dedup_and_schedule(alerts, state, now, cfg, next_deadline=None):
    """Returns (send_now, held, state). state = {'sent': {key: ts}, 'held': [alerts]}.
    Quiet hours (owner's local time, DST-aware) hold medium/info alerts — except in the run-up to a deadline,
    when everything is sent immediately."""
    sent = state.setdefault("sent", {})
    held = state.setdefault("held", [])
    horizon = timedelta(hours=cfg["alerts"]["dedup_hours"])
    for k in [k for k, t in sent.items() if now - parse_iso(t) > timedelta(days=14)]:
        del sent[k]
    quiet = in_quiet(now, cfg)
    d = parse_iso(next_deadline)
    if quiet and d and timedelta(0) < d - now <= timedelta(hours=cfg["alerts"]["deadline"]["quiet_override_hours"]):
        quiet = False
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
