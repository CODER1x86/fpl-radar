"""Notification channels. Each is enabled only when its configuration exists; secrets come from env (Actions secrets)."""
from __future__ import annotations

import json
import os
import urllib.request

PRIO = {"critical": "5", "high": "4", "medium": "3", "info": "2"}
EMOJI = {"critical": "🚨", "high": "⚠️", "medium": "🔔", "info": "ℹ️"}


def _post(url, body: bytes, headers: dict, timeout=15):
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()[:500]


def fmt(a, dash=""):
    lines = [f"**{EMOJI[a['severity']]} [{a['severity'].upper()}] {a['title']}**", "",
             f"- What changed: {a['what']}"]
    if a.get("player"):
        lines.append(f"- Player / club: {a['player']} ({a.get('club') or '?'})")
    lines += [f"- Source / time: {a['source']} · {a.get('observed_at')}",
              f"- Impact on squad: {a.get('impact') or '—'}",
              f"- Recommended action: {a.get('action') or '—'}",
              f"- Deadline: {a.get('deadline') or '—'}",
              f"- Confidence: {a.get('confidence')}"]
    if dash:
        lines.append(f"- Dashboard: {dash}")
    return "\n".join(lines)


def channels():
    ch = []
    if os.environ.get("GITHUB_TOKEN") and os.environ.get("GITHUB_REPOSITORY"):
        ch.append("github_issue")
    if os.environ.get("NTFY_TOPIC"):
        ch.append("ntfy")
    if os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"):
        ch.append("telegram")
    try:
        from . import webpush
        if webpush.subscriptions():
            ch.append("webpush")
    except Exception:
        pass
    return ch


def send(alerts, dash="", test=False, dry=False):
    """Deliver a batch. Returns list of delivery records (never raises)."""
    if not alerts:
        return []
    recs = []
    top = min(alerts, key=lambda a: ["critical", "high", "medium", "info"].index(a["severity"]))
    title = (f"[TEST] " if test else "") + (top["title"] if len(alerts) == 1 else
                                            f"{top['title']} (+{len(alerts) - 1} more)")
    body = "\n\n---\n\n".join(fmt(a, dash) for a in alerts)
    body += "\n\n_Automated by WildCard.exe pipeline. Rumours are never sent as facts; model outputs are labelled._"
    for ch in channels():
        try:
            if dry:
                recs.append({"channel": ch, "ok": True, "dry_run": True})
                continue
            if ch == "github_issue":
                repo = os.environ["GITHUB_REPOSITORY"]
                labels = ["wildcard-alert", top["severity"]] + (["test"] if test else [])
                st, _ = _post(f"https://api.github.com/repos/{repo}/issues",
                              json.dumps({"title": title[:250], "body": body[:60000], "labels": labels}).encode(),
                              {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                               "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                               "User-Agent": "wildcard-exe"})
                recs.append({"channel": ch, "ok": st == 201, "status": st})
            elif ch == "ntfy":
                server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
                plain = body.replace("**", "")
                st, _ = _post(f"{server}/{os.environ['NTFY_TOPIC']}", plain[:4000].encode(),
                              {"Title": title[:200].encode("ascii", "ignore").decode(), "Priority": PRIO[top["severity"]],
                               "Tags": "soccer", "Markdown": "yes", **({"Click": dash} if dash else {})})
                recs.append({"channel": ch, "ok": 200 <= st < 300, "status": st})
            elif ch == "webpush":
                from . import webpush
                first = alerts[0]
                body = (first.get("what") or "")[:180]
                if first.get("action"):
                    body += " → " + first["action"][:120]
                if len(alerts) > 1:
                    body += f" (+{len(alerts) - 1} more)"
                res = webpush.broadcast({"title": ("[TEST] " if test else "") + first["title"][:120], "body": body,
                                         "url": dash or "./", "tag": first["key"][:60]},
                                        urgency="high" if top["severity"] in ("critical", "high") else "normal")
                recs.append({"channel": ch, "ok": any(200 <= r["status"] < 300 for r in res), "results": res})
            elif ch == "telegram":
                tok = os.environ["TELEGRAM_BOT_TOKEN"]
                st, _ = _post(f"https://api.telegram.org/bot{tok}/sendMessage",
                              json.dumps({"chat_id": os.environ["TELEGRAM_CHAT_ID"],
                                          "text": (title + "\n\n" + body.replace("**", ""))[:4000],
                                          "disable_web_page_preview": True}).encode(),
                              {"Content-Type": "application/json"})
                recs.append({"channel": ch, "ok": st == 200, "status": st})
        except Exception as e:  # delivery failure must not break the pipeline
            msg = str(e)
            for s in ("TELEGRAM_BOT_TOKEN", "NTFY_TOPIC", "GITHUB_TOKEN"):
                if os.environ.get(s):
                    msg = msg.replace(os.environ[s], "***")
            recs.append({"channel": ch, "ok": False, "error": f"{type(e).__name__}: {msg}"[:300]})
    return recs
