"""Update cadence: quiet between gameweeks, full updates only in the last hours before a deadline.

Phases (computed from the official deadline_time, UTC):
- focus  : 0 < hours to next deadline <= focus_hours (default 36). Full updates: model, plan, prices, reminders.
- quiet  : more than focus_hours to the deadline. One cheap availability check per interval; the ONLY alerts are
           confirmed absences (injured / suspended / unavailable / 0% chance) of your squad or planned buys,
           each with the best replacement, so you can move before the price changes.
- live   : the current gameweek's deadline has passed and its matches are not finished. Light checks only.

The pipeline publishes the next due time in public/schedule.json; the Cloudflare cron reads it and only starts a run
when one is due, and the GitHub backup schedule is gated the same way."""
from __future__ import annotations

from datetime import timedelta

from .core import iso, parse_iso

CONFIRMED_OUT = {"i", "s", "u", "n"}


def settings(cfg):
    c = cfg.get("cadence", {})
    return {"focus_hours": c.get("focus_hours", 36), "focus_minutes": c.get("focus_minutes", 10),
            "final_hours": c.get("final_hours", 3), "final_minutes": c.get("final_minutes", 5),
            "quiet_minutes": c.get("quiet_minutes", 60), "live_minutes": c.get("live_minutes", 120)}


def phase(gw, now, cfg):
    s = settings(cfg)
    dl = parse_iso(gw.get("next_deadline"))
    hrs = (dl - now).total_seconds() / 3600 if dl else None
    cur = gw.get("current")
    live = bool(cur and not gw.get("current_finished"))
    if hrs is not None and 0 < hrs <= s["focus_hours"]:
        name = "focus"
        mins = s["final_minutes"] if hrs <= s["final_hours"] else s["focus_minutes"]
    elif live:
        name, mins = "live", s["live_minutes"]
    else:
        name, mins = "quiet", s["quiet_minutes"]
    focus_from = dl - timedelta(hours=s["focus_hours"]) if dl else None
    nxt = now + timedelta(minutes=mins)
    if name != "focus" and focus_from and now < focus_from < nxt:
        nxt = focus_from  # never miss the start of the focus window
    return {"phase": name, "interval_minutes": mins, "hours_to_deadline": round(hrs, 2) if hrs is not None else None,
            "deadline": gw.get("next_deadline"), "gw": gw.get("next"), "focus_hours": s["focus_hours"],
            "focus_from": iso(focus_from) if focus_from else None, "next_due": iso(nxt), "computed_at": iso(now)}


def confirmed_out(p):
    return p["status"] in CONFIRMED_OUT or p.get("chance") == 0


def new_absences(prev, cur, ids):
    """Players in ids who became confirmed-out since the previous snapshot."""
    out = []
    for i in ids:
        c, p = cur.get(i), (prev or {}).get(i)
        if c and p and confirmed_out(c) and not confirmed_out(p):
            out.append(i)
    return out


QUIET_TYPES = {"health", "deadline"}


def filter_quiet(alerts, absent_ids, players):
    """Between gameweeks keep only confirmed absences of the given players, plus health / deadline notices."""
    names = {players[i]["name"] for i in absent_ids if i in players}
    keep = []
    for a in alerts:
        if a["type"] in QUIET_TYPES or a["key"].startswith(("deadline-moved|", "recovered|", "failing|")):
            keep.append(a)
        elif a["type"] == "availability" and a.get("player") in names:
            keep.append(a)
    return keep
