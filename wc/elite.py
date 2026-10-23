"""Elite-manager template: aggregate picks of the top of the official overall league (public endpoints only).

Only aggregates are stored (ownership, captaincy, effective ownership, chips) — no names of other managers.
Picks for a gameweek become public only after its deadline, so this always describes the LAST deadline."""
from __future__ import annotations

import time

from . import model as M
from .core import SourceError, get_json, iso

OVERALL_LEAGUE = 314


def build(ctx, players, current_gw, n_target=100, pause=0.25):
    if not current_gw:
        return None
    entries = []
    page = 1
    while len(entries) < n_target and page <= 3:
        d, _ = get_json(f"/leagues-classic/{OVERALL_LEAGUE}/standings/?page_standings={page}", retries=2)
        res = (d or {}).get("standings", {}).get("results", [])
        if not res:
            break
        entries += [r["entry"] for r in res if isinstance(r.get("entry"), int)]
        page += 1
    entries = entries[:n_target]
    if not entries:
        raise SourceError("overall league standings returned no entries")
    own, start, capt, eo, chips, ok = {}, {}, {}, {}, {}, 0
    for e in entries:
        try:
            pk, _ = get_json(f"/entry/{e}/event/{current_gw}/picks/", retries=1, timeout=15)
        except SourceError:
            continue
        if not pk or not isinstance(pk.get("picks"), list):
            continue
        ok += 1
        if pk.get("active_chip"):
            chips[pk["active_chip"]] = chips.get(pk["active_chip"], 0) + 1
        for x in pk["picks"]:
            i, mult = x.get("element"), x.get("multiplier", 0)
            own[i] = own.get(i, 0) + 1
            if mult > 0:
                start[i] = start.get(i, 0) + 1
            if x.get("is_captain"):
                capt[i] = capt.get(i, 0) + 1
            eo[i] = eo.get(i, 0) + mult
        time.sleep(pause)
    if ok < 10:
        raise SourceError(f"only {ok} elite squads readable")
    pct = lambda dct, i: round(100 * dct.get(i, 0) / ok, 1)
    rows = sorted(({"id": i, "own": pct(own, i), "start": pct(start, i), "capt": pct(capt, i), "eo": pct(eo, i)}
                   for i in own if i in players), key=lambda r: -r["eo"])
    pseudo = {r["id"]: {"b": [r["own"] + r["eo"] / 1000]} for r in rows}   # most-owned XI (EO breaks ties)
    tmpl = M.dream_team(players, pseudo, 0, per_pos=30)
    return {"ts": iso(ctx.now), "gw": current_gw, "sample": ok, "league": "Overall (top %d)" % len(entries),
            "players": rows[:60], "template": tmpl, "chips": chips,
            "note": "Picks are public only after a deadline, so this is the elite template at the last deadline."}
