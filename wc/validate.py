"""Schema validation. Anything that fails here is rejected and never reaches the model or the dashboard."""
from __future__ import annotations

from .core import parse_iso


class SchemaError(Exception):
    pass


ELEMENT_FIELDS = {
    "id": int, "web_name": str, "team": int, "element_type": int, "now_cost": int, "status": str,
    "minutes": int, "starts": int, "selected_by_percent": str, "total_points": int,
    "expected_goals": str, "expected_assists": str, "expected_goals_conceded": str,
    "bonus": int, "saves": int, "clean_sheets": int, "transfers_in_event": int, "transfers_out_event": int,
    "cost_change_event": int, "news": str,
}
OPTIONAL_ELEMENT = {"defensive_contribution": int, "chance_of_playing_next_round": (int, type(None)),
                    "penalties_order": (int, type(None)), "news_added": (str, type(None))}


def _need(cond, msg):
    if not cond:
        raise SchemaError(msg)


def bootstrap(d) -> list[str]:
    """Validate bootstrap-static. Returns non-fatal warnings; raises SchemaError when unusable."""
    warn = []
    _need(isinstance(d, dict), "bootstrap is not an object")
    for k in ("events", "teams", "elements", "element_types"):
        _need(isinstance(d.get(k), list) and d[k], f"bootstrap.{k} missing or empty")
    teams = {t.get("id") for t in d["teams"]}
    _need(len(teams) == 20 and teams == set(range(1, 21)), f"expected 20 teams with ids 1..20, got {sorted(teams)[:25]}")
    ev_ids = [e.get("id") for e in d["events"]]
    _need(ev_ids == list(range(1, len(ev_ids) + 1)) and len(ev_ids) == 38, "events must be GW1..GW38")
    for e in d["events"]:
        _need(parse_iso(e.get("deadline_time")) is not None, f"GW{e.get('id')} bad deadline_time")
    _need(sum(1 for e in d["events"] if e.get("is_next")) <= 1, "more than one is_next event")
    els = d["elements"]
    _need(len(els) >= 400, f"only {len(els)} elements — truncated response?")
    ids = set()
    for el in els:
        for k, typ in ELEMENT_FIELDS.items():
            _need(k in el, f"element {el.get('id')} missing field '{k}' — schema change?")
            _need(isinstance(el[k], typ) and not (typ is int and isinstance(el[k], bool)),
                  f"element {el.get('id')} field '{k}' has type {type(el[k]).__name__}, expected {typ.__name__}")
        for k, typ in OPTIONAL_ELEMENT.items():
            if k in el and not isinstance(el[k], typ):
                raise SchemaError(f"element {el['id']} field '{k}' unexpected type {type(el[k]).__name__}")
        _need(el["id"] not in ids, f"duplicate element id {el['id']}")
        ids.add(el["id"])
        _need(el["team"] in teams, f"element {el['id']} has unknown team {el['team']}")
        _need(el["element_type"] in (1, 2, 3, 4, 5), f"element {el['id']} bad element_type")
        _need(30 <= el["now_cost"] <= 200, f"element {el['id']} implausible now_cost {el['now_cost']}")
        for k in ("expected_goals", "expected_assists", "expected_goals_conceded", "selected_by_percent"):
            try:
                float(el[k])
            except ValueError:
                raise SchemaError(f"element {el['id']} field {k}='{el[k]}' not numeric")
    if not any("defensive_contribution" in el for el in els):
        warn.append("defensive_contribution absent from all elements — DC term disabled")
    return warn


def fixtures(fx, team_ids=range(1, 21)) -> list[str]:
    warn = []
    _need(isinstance(fx, list) and len(fx) >= 300, f"fixtures list too short ({len(fx) if isinstance(fx, list) else 'n/a'})")
    seen = set()
    tids = set(team_ids)
    for f in fx:
        for k in ("id", "team_h", "team_a", "team_h_difficulty", "team_a_difficulty", "finished"):
            _need(k in f, f"fixture missing '{k}'")
        _need(f["id"] not in seen, f"duplicate fixture {f['id']}")
        seen.add(f["id"])
        _need(f["team_h"] in tids and f["team_a"] in tids and f["team_h"] != f["team_a"], f"fixture {f['id']} bad teams")
        _need(1 <= f["team_h_difficulty"] <= 5 and 1 <= f["team_a_difficulty"] <= 5, f"fixture {f['id']} bad FDR")
        ev = f.get("event")
        _need(ev is None or (isinstance(ev, int) and 1 <= ev <= 38), f"fixture {f['id']} bad event {ev}")
    unsched = sum(1 for f in fx if f.get("event") is None)
    if unsched:
        warn.append(f"{unsched} fixtures without a gameweek (postponed / to be rescheduled)")
    return warn


def picks(d) -> None:
    _need(isinstance(d, dict) and isinstance(d.get("picks"), list), "picks payload malformed")
    _need(len(d["picks"]) == 15, f"expected 15 picks, got {len(d['picks'])}")
    for pk in d["picks"]:
        _need(isinstance(pk.get("element"), int) and isinstance(pk.get("position"), int), "pick missing element/position")
    eh = d.get("entry_history") or {}
    _need(isinstance(eh.get("bank"), int) and isinstance(eh.get("value"), int), "entry_history bank/value missing")


def live(d) -> None:
    _need(isinstance(d, dict) and isinstance(d.get("elements"), list) and d["elements"], "live payload malformed")
    for el in d["elements"][:5]:
        _need("id" in el and "stats" in el and "total_points" in el["stats"], "live element missing stats.total_points")
