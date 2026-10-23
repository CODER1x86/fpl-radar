"""Turn validated FPL payloads into compact, stable records."""
from __future__ import annotations

POS = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD", 5: "MGR"}


def teams(boot) -> dict[int, str]:
    return {t["id"]: t["short_name"] for t in boot["teams"]}


def players(boot) -> dict[int, dict]:
    out = {}
    for e in boot["elements"]:
        out[e["id"]] = {
            "id": e["id"], "name": e["web_name"], "team": e["team"], "pos": e["element_type"],
            "cost": e["now_cost"] / 10, "status": e["status"], "chance": e.get("chance_of_playing_next_round"),
            "news": e.get("news") or "", "news_added": e.get("news_added"),
            "own": float(e["selected_by_percent"]), "pts": e["total_points"], "mins": e["minutes"],
            "starts": e["starts"], "xg": float(e["expected_goals"]), "xa": float(e["expected_assists"]),
            "xgc": float(e["expected_goals_conceded"]), "dc": e.get("defensive_contribution", 0) or 0,
            "bonus": e["bonus"], "saves": e["saves"], "cs": e["clean_sheets"],
            "tin": e["transfers_in_event"], "tout": e["transfers_out_event"], "cce": e["cost_change_event"],
            "pen": e.get("penalties_order"),
        }
    return out


def gameweeks(boot) -> dict:
    ev = boot["events"]
    cur = next((e for e in ev if e.get("is_current")), None)
    nxt = next((e for e in ev if e.get("is_next")), None)
    return {
        "current": cur["id"] if cur else None,
        "current_finished": bool(cur and cur.get("finished")),
        "current_data_checked": bool(cur and cur.get("data_checked")),
        "next": nxt["id"] if nxt else None,
        "next_deadline": nxt["deadline_time"] if nxt else None,
        "deadlines": {e["id"]: e["deadline_time"] for e in ev},
    }


def fixture_map(fx, gws) -> dict[int, dict[int, list]]:
    """{gw: {team: [(opp, 'H'|'A', difficulty, kickoff), ...]}} — lists allow doubles; missing team = blank."""
    m = {g: {} for g in gws}
    for f in fx:
        g = f.get("event")
        if g in m:
            m[g].setdefault(f["team_h"], []).append((f["team_a"], "H", f["team_h_difficulty"], f.get("kickoff_time")))
            m[g].setdefault(f["team_a"], []).append((f["team_h"], "A", f["team_a_difficulty"], f.get("kickoff_time")))
    return m


def blanks_doubles(fmap) -> dict:
    out = {}
    for g, tm in fmap.items():
        out[g] = {"doubles": sorted(t for t, l in tm.items() if len(l) > 1),
                  "blanks": sorted(t for t in range(1, 21) if t not in tm)}
    return out
