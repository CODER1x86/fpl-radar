"""Test double for the FPL API.

Built from REAL observations where we have them (players snapshot of 2026-10-22, GW8-19 fixtures), plus
clearly SYNTHETIC filler (GW1-7 and GW20-38 pairings, deadlines beyond GW11) needed only to satisfy the schema.
Never used outside tests."""
from __future__ import annotations

import copy
import csv
import gzip
import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent / "fixtures"
ns = {}
exec((HERE / "fixtures_gw8_19.py").read_text(), ns)
T, F = ns["T"], ns["F"]
SQ = [109, 497, 4, 175, 204, 304, 423, 427, 124, 368, 426, 571, 411, 346, 165]


def bootstrap():
    els = []
    for r in csv.DictReader(open(HERE / "players_snapshot_2026-10-22.csv")):
        els.append({
            "id": int(r["id"]), "web_name": r["name"], "team": int(r["team"]), "element_type": int(r["pos"]),
            "now_cost": int(r["cost"]), "status": r["status"],
            "chance_of_playing_next_round": int(r["chance"]) if r["chance"] else None,
            "minutes": int(r["minutes"]), "starts": int(r["starts"]), "selected_by_percent": r["own"],
            "total_points": int(r["pts"]), "expected_goals": r["xg"], "expected_assists": r["xa"],
            "expected_goals_conceded": r["xgc"], "bonus": int(r["bonus"]), "saves": int(r["saves"]),
            "clean_sheets": int(r["cs"]), "transfers_in_event": 0, "transfers_out_event": 0, "cost_change_event": 0,
            "news": "Injury - test" if r["status"] in "isu" else "", "news_added": None,
            "defensive_contribution": int(r["dc"]), "penalties_order": int(r["pen"]) if r["pen"] else None})
    base = datetime(2026, 10, 23, 17, 30, tzinfo=timezone.utc)
    events = []
    for g in range(1, 39):
        dl = base + timedelta(days=7 * (g - 8))
        events.append({"id": g, "deadline_time": dl.strftime("%Y-%m-%dT%H:%M:%SZ"), "is_current": g == 7,
                       "is_next": g == 8, "finished": g <= 7, "data_checked": g <= 7})
    return {"events": events, "teams": [{"id": i, "short_name": s, "name": s} for i, s in T.items()],
            "elements": els, "element_types": [{"id": i} for i in range(1, 5)]}


def fixtures():
    out, fid = [], 1
    teams = list(range(1, 21))
    for g in range(1, 39):
        if g in F:
            pairs = [(h, a, hd, ad) for h, a, hd, ad in F[g]]
        else:  # synthetic circle-method round robin
            r = teams[:1] + teams[1:][(g % 19):] + teams[1:][:(g % 19)]
            pairs = [(r[i], r[19 - i], 3, 3) for i in range(10)]
        for h, a, hd, ad in pairs:
            out.append({"id": fid, "event": g, "team_h": h, "team_a": a, "team_h_difficulty": hd,
                        "team_a_difficulty": ad, "finished": g <= 7, "kickoff_time": None})
            fid += 1
    return out


def picks():
    return {"picks": [{"element": e, "position": k + 1} for k, e in enumerate(SQ)],
            "entry_history": {"bank": 1, "value": 1003, "event": 7}}


def elite_picks():
    ids = [1, 4, 8, 5, 115, 427, 124, 13, 40, 411, 165, 68, 330, 173, 346]   # synthetic test template
    return {"active_chip": None, "picks": [{"element": e, "position": k + 1, "multiplier": (2 if e == 411 else 1) if k < 11 else 0,
                                            "is_captain": e == 411} for k, e in enumerate(ids)]}


def history():
    return {"current": [{"event": g, "event_transfers": 1 if g in (3, 5) else 0} for g in range(1, 8)], "chips": []}


def live(boot):
    return {"elements": [{"id": e["id"], "stats": {"total_points": 2}} for e in boot["elements"]]}


class Fake:
    def __init__(self):
        self.boot = bootstrap()
        self.fx = fixtures()
        self.fail = set()      # paths returning 503
        self.html = set()      # paths returning an HTML holding page
        self.hits = {}
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                path = self.path.split("/api", 1)[-1]
                fake.hits[path] = fake.hits.get(path, 0) + 1
                if path in fake.fail:
                    self.send_response(503); self.end_headers(); return
                if path in fake.html:
                    b = b"<html>The game is being updated</html>"
                    self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
                    self.wfile.write(b); return
                body = {"/bootstrap-static/": lambda: fake.boot, "/fixtures/": lambda: fake.fx,
                        "/entry/4969994/event/7/picks/": picks, "/entry/4969994/history/": history,
                        "/event/7/live/": lambda: live(fake.boot),
                        "/leagues-classic/314/standings/?page_standings=1": lambda: {"standings": {"results": [
                            {"entry": 1000 + k, "rank": k + 1} for k in range(12)]}},
                        "/leagues-classic/314/standings/?page_standings=2": lambda: {"standings": {"results": []}},
                        }.get(path)
                if body is None and path.startswith("/entry/10") and path.endswith("/event/7/picks/"):
                    body = elite_picks
                if not body:
                    self.send_response(404); self.end_headers(); return
                raw = json.dumps(body()).encode()
                etag = '"%x"' % (hash(raw) & 0xffffffff)
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304); self.end_headers(); return
                gz = gzip.compress(raw)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Encoding", "gzip")
                self.send_header("ETag", etag)
                self.end_headers()
                self.wfile.write(gz)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}/api"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()

    def mutate(self, eid, **kw):
        for e in self.boot["elements"]:
            if e["id"] == eid:
                e.update(kw)
