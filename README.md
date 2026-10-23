# FPL Radar — WildCard.exe cloud pipeline

Autonomous, free, cloud-hosted FPL data + projection + alerting service for team *WildCard.exe* (manager 4969994).
Runs on GitHub Actions; no computer or browser needs to be on.

- **Dashboard:** GitHub Pages (URL in repo About / `vars.DASHBOARD_URL`).
- **Architecture decision:** [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md)
- **Operations runbook:** [docs/OPERATIONS.md](docs/OPERATIONS.md)

```
wc/core.py        config, clock, atomic storage, HTTP (timeouts, retries, backoff+jitter, ETag)
wc/validate.py    schema checks — malformed or changed payloads are rejected
wc/normalize.py   compact player / fixture / gameweek records, blanks & doubles
wc/model.py       projection engine (baseline, conservative, Monte-Carlo upside/ceiling), lineup, captaincy, transfers
wc/alerts.py      change detection, dedup, quiet hours
wc/notify.py      GitHub Issues / ntfy / Telegram delivery
wc/run.py         orchestrator: auto | validate | notify-test | export
wc/export.py      SQLite + tarball backup
dashboard/        static dashboard served by Pages
tests/            12 tests (fake FPL server from a real 2026-10-22 snapshot)
```

Data only from the public FPL API. No credentials are used or stored; the owner's private endpoints (`/my-team/`) are
never accessed. Model outputs are estimates and labelled as such.
