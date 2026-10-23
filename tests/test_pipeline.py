import copy
import csv
import json

import pytest

import wc.core as core
from wc import alerts as AL
from wc import run as R
from wc import validate as V
from tests.fakefpl import Fake, SQ


@pytest.fixture
def env(tmp_path, monkeypatch):
    fake = Fake()
    monkeypatch.setattr(core, "DATA", tmp_path / "data")
    monkeypatch.setattr(core, "FPL", fake.url)
    monkeypatch.setattr(core.time, "sleep", lambda s: None)
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:00:00Z")   # 14:00 Cairo, outside quiet hours
    for k in ("GITHUB_TOKEN", "NTFY_TOPIC", "TELEGRAM_BOT_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    yield fake, tmp_path / "data"
    fake.close()


def status(d):
    return json.loads((d / "state" / "status.json").read_text())


# 1 + 4: retrieval and normalisation
def test_ingest_and_normalise(env):
    fake, d = env
    assert R.main(["auto", "--dry-notify"]) == 0
    st = status(d)
    assert st["health"] == "ok" and st["sources"]["bootstrap"]["last_status"] == 200
    players = json.loads((d / "latest" / "players.json").read_text())
    assert players["411"]["name"] == "Haaland" and players["411"]["cost"] == pytest.approx(15.6, abs=0.3)
    gw = json.loads((d / "latest" / "gw.json").read_text())
    assert gw["next"] == 8 and gw["current"] == 7


# 2: schema and timestamp validation rejects malformed data
def test_schema_rejections():
    from tests.fakefpl import bootstrap, fixtures
    b = bootstrap()
    V.bootstrap(b)
    bad = copy.deepcopy(b); del bad["elements"][0]["now_cost"]
    with pytest.raises(V.SchemaError, match="missing field"):
        V.bootstrap(bad)
    bad = copy.deepcopy(b); bad["elements"] = bad["elements"][:100]
    with pytest.raises(V.SchemaError, match="truncated"):
        V.bootstrap(bad)
    bad = copy.deepcopy(b); bad["events"][3]["deadline_time"] = "soon"
    with pytest.raises(V.SchemaError, match="deadline"):
        V.bootstrap(bad)
    bad = copy.deepcopy(b); bad["elements"][5]["expected_goals"] = "n/a"
    with pytest.raises(V.SchemaError, match="not numeric"):
        V.bootstrap(bad)
    fx = fixtures()
    V.fixtures(fx)
    fx[0]["team_h_difficulty"] = 9
    with pytest.raises(V.SchemaError, match="FDR"):
        V.fixtures(fx)


# 3: storage writes/reads + idempotency (same snapshot twice -> no duplicate history)
def test_idempotent_history(env, monkeypatch):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    fake.mutate(411, now_cost=158)
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:10:00Z")
    R.main(["auto", "--dry-notify"])
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:20:00Z")
    R.main(["auto", "--dry-notify"])           # unchanged snapshot
    rows = list(csv.reader(open(d / "history" / "prices.csv")))
    assert rows[0] == ["ts", "id", "name", "old", "new"]
    assert len(rows) == 2 and rows[1][1] == "411" and rows[1][3] == "15.7" and rows[1][4] == "15.8"
    runs = [json.loads(l) for l in open(d / "state" / "runs.jsonl")]
    assert len(runs) == 3


# 5 + 6: projection engine and dashboard payload
def test_model_and_dashboard(env):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    dash = json.loads((d / "public" / "dashboard.json").read_text())
    pr = dash["projection"]
    assert pr["gws"] == [8, 9, 10, 11, 12]
    assert sorted(pr["squad"]) == sorted(SQ)
    lu = pr["lineups"][0]
    assert len(lu["xi"]) == 11 and len(lu["bench"]) == 4 and lu["captain"] in lu["xi"]
    hal = next(p for p in pr["players"] if p["id"] == 411)
    assert 4 < hal["b"][0] < 15 and hal["u1"] >= hal["b"][0] and 0 <= hal["h1"] <= 1
    szo = next(p for p in pr["players"] if p["id"] == 368)
    assert szo["b"][0] == pytest.approx(0.05, abs=0.01) and szo["ovr"]   # override applied, labelled
    assert dash["status"]["freshness"] == "current"
    assert pr["free_transfers_est"] == 5   # 1 for GW2, +1 per GW, -1 in GW3 and GW5 -> 5 (cap) for GW8
    assert pr["transfers"]["best_per_out"], "transfer search returned nothing"


# 7: alert generation and de-duplication
def test_alerts_and_dedup(env, monkeypatch):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    fake.mutate(411, status="d", chance_of_playing_next_round=75, news="Knock - 75% chance of playing")
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:10:00Z")
    R.main(["auto", "--dry-notify"])
    sent = [json.loads(l) for l in open(d / "state" / "alerts.jsonl")]
    hal = [a for a in sent if a["type"] == "availability" and a["player"] == "Haaland"]
    assert len(hal) == 1 and hal[0]["severity"] == "critical"     # squad player, deadline < 48h
    for f in ("severity", "what", "club", "source", "observed_at", "impact", "action", "deadline", "confidence"):
        assert hal[0].get(f), f
    # same observation again -> no duplicate alert
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:20:00Z")
    R.main(["auto", "--dry-notify"])
    sent2 = [json.loads(l) for l in open(d / "state" / "alerts.jsonl")]
    assert len([a for a in sent2 if a["type"] == "availability" and a["player"] == "Haaland"]) == 1


def test_quiet_hours_hold_noncritical():
    cfg = core.load_config()
    now = core.parse_iso("2026-10-23T01:00:00Z")   # 04:00 Cairo
    a = [AL._alert("x|1", "info", "price", "t", "w"), AL._alert("x|2", "critical", "availability", "t", "w")]
    send, held, st = AL.dedup_and_schedule(a, {}, now, cfg)
    assert [x["key"] for x in send] == ["x|2"] and [x["key"] for x in held] == ["x|1"]
    later = core.parse_iso("2026-10-23T07:00:00Z")  # 10:00 Cairo -> digest released
    send2, held2, st = AL.dedup_and_schedule([], st, later, cfg)
    assert [x["key"] for x in send2] == ["x|1"] and not st["held"]


# 9: failure handling — source down keeps last-known-good, marks stale, counts failures, recovers
def test_failure_and_recovery(env, monkeypatch):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    before = (d / "public" / "dashboard.json").read_text()
    fake.fail.add("/bootstrap-static/")
    for k, t in enumerate(["13:00", "13:10", "13:20"]):
        monkeypatch.setenv("WC_NOW", f"2026-10-22T{t}:00Z")
        rc = R.main(["auto", "--dry-notify"])
    st = status(d)
    assert st["consecutive_failures"] == 3 and st["health"] == "failing" and rc == 2
    assert st["freshness"] == "stale"
    assert "HTTP 503" in st["sources"]["bootstrap"]["last_error"]
    dash = json.loads((d / "public" / "dashboard.json").read_text())
    assert dash["projection"]["players"], "last-known-good projection must survive the outage"
    al = [json.loads(l) for l in open(d / "state" / "alerts.jsonl")]
    assert any(a["type"] == "health" and "failing" in a["title"] for a in al)
    fake.fail.clear()
    fake.html.add("/bootstrap-static/")   # FPL "game is updating" page must be rejected, not parsed
    monkeypatch.setenv("WC_NOW", "2026-10-22T13:30:00Z")
    R.main(["auto", "--dry-notify"])
    assert "non-JSON" in status(d)["sources"]["bootstrap"]["last_error"]
    fake.html.clear()
    monkeypatch.setenv("WC_NOW", "2026-10-22T13:40:00Z")
    assert R.main(["auto", "--dry-notify"]) == 0
    st = status(d)
    assert st["consecutive_failures"] == 0 and st["freshness"] == "current"
    al = [json.loads(l) for l in open(d / "state" / "alerts.jsonl")]
    assert any(a["title"] == "Pipeline recovered" for a in al)


def test_schema_change_does_not_corrupt(env, monkeypatch):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    good = (d / "latest" / "players.json").read_text()
    for e in fake.boot["elements"]:
        e.pop("expected_goals")
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:10:00Z")
    R.main(["auto", "--dry-notify"])
    st = status(d)
    assert "schema" in st["sources"]["bootstrap"]["last_error"]
    assert (d / "latest" / "players.json").read_text() == good   # model inputs untouched


def test_conditional_request_304(env, monkeypatch):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    monkeypatch.setenv("WC_NOW", "2026-10-22T12:10:00Z")
    R.main(["auto", "--dry-notify"])
    assert status(d)["sources"]["bootstrap"]["not_modified"] is True


# validation mode: forecast vs actual + consistency
def test_validate_mode(env, monkeypatch):
    fake, d = env
    R.main(["validate", "--dry-notify"])
    st = status(d)
    assert st["last_validate_ok"] and all(c["ok"] for c in st["consistency"]), st["consistency"]


# 10: notification formatting (delivery itself is exercised in CI with real channels)
def test_notification_dry_run(env, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "x"); monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
    from wc import notify as NT
    recs = NT.send([AL._alert("k", "high", "t", "Title", "What")], dry=True)
    assert recs == [{"channel": "github_issue", "ok": True, "dry_run": True}]
    assert "Recommended action" in NT.fmt(AL._alert("k", "high", "t", "Title", "What"))


def test_export(env):
    fake, d = env
    R.main(["auto", "--dry-notify"])
    from wc.export import export
    out = export(d.parent / "export")
    assert out["rows"]["runs"] == 1
