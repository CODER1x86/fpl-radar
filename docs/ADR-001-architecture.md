# ADR-001 — Cloud-first architecture for WildCard.exe Radar

Status: **Accepted** · Date: 2026-10-23 · Owner: CODER1x86 (Ahmed)

## Context
The Command Center (a claude.ai Artifact) was refreshed only when a Claude session fetched FPL data, partly through
the built-in browser on Ahmed's computer. Requirement: ingestion, calculations, history, monitoring and alerts must keep
running with the computer off, at zero cost.

## Options evaluated (limits checked against official docs, 2026-10-23)

| Option | Scheduling | Compute | Storage | Verdict |
|---|---|---|---|---|
| Google Apps Script + Sheets | time triggers; **90 min/day** total trigger runtime, 6 min/run, 20k UrlFetch/day (consumer) | JavaScript only — the Python/NumPy model would have to be rewritten | Sheets (cell limits) | Rejected: rewrite of model, daily runtime cap |
| Cloudflare Workers + Cron + D1/KV | 5 cron triggers/account | **10 ms CPU per invocation** on Free | D1/KV free tiers | Rejected for compute: Monte-Carlo (6,000 sims × ~450 players) cannot run in 10 ms |
| **GitHub Actions + repository** | cron, min 5 min, may be delayed under load; only on default branch | full Ubuntu runner, Python, 15-min timeout set | git (versioned files) + Actions cache (10 GB/repo) | **Selected** |
| Hybrid (Worker as API + Actions compute) | — | — | — | Not needed: Pages already serves the read-only data interface |

Repository visibility: **public** (chosen by owner). Consequences: standard runners are free with no minute quota;
GitHub Pages is available on the Free plan only for public repos; scheduled workflows are auto-disabled after 60 days
with no repository activity (data commits count as activity).

## Decision
- **Compute & scheduler:** GitHub Actions workflow `radar-pipeline` every 10 minutes + daily validation at 03:23 UTC + manual dispatch.
- **Storage:** `data` branch (versioned, append-only history: prices, status/news changes, hourly market snapshots,
  decisions, alerts, run log, archived projections, forecast-vs-actual). Volatile working state (raw responses,
  last-known-good normalised snapshot, public JSON) in the Actions cache, restored each run.
- **Dashboard delivery:** GitHub Pages site (static HTML + `data/dashboard.json`, `data/status.json`) redeployed every
  run. The claude.ai Artifact cannot fetch other origins (CSP), so it stays as the analysis/decision-log interface and is
  refreshed by the daily Claude scheduled task, which reads this repo.
- **Alerts:** GitHub Issues created by the workflow (`GITHUB_TOKEN`, no extra secret) → GitHub email / GitHub Mobile push
  via the owner's notification settings. Optional ntfy.sh push and Telegram bot when their secrets exist.

## Polling
| Data | Interval |
|---|---|
| bootstrap-static (prices, status, news, ownership, transfers) | every run (~10 min), conditional request |
| fixtures | every 3 h |
| public picks + history | every 6 h, and on gameweek change |
| market snapshot written to history | hourly |
| model recalculation | when material inputs change (≥15 min apart) or hourly |
| full validation + forecast-vs-actual | daily |
Real latency = schedule delay (GitHub documents delays under load) + ~1 min run.

## Failure recovery
Timeouts, 4 retries with exponential backoff + jitter, Retry-After honoured, non-JSON “game updating” pages rejected,
schema validation before anything is stored. A failing source keeps the last-known-good snapshot, the page is labelled
stale, consecutive failures are counted, an alert fires after 2/6/18 failed runs, and a recovery alert fires afterwards.
If the cache is evicted, the next run refetches and recomputes (history lives in git, unaffected).

## Backup / migration
`python -m wc.run export` (or workflow_dispatch mode=export) builds `wildcard.sqlite` + tarball from the data branch.
The data branch is plain CSV/JSONL/JSON — portable to D1, Sheets or any SQL store. `git clone -b data` is a full backup.

## Owner actions required
None for core operation. Optional: install ntfy app + add secret `NTFY_TOPIC`; Telegram bot token/chat id;
confirm GitHub notification settings (Watching the repo) for issue emails/push.

## Cost conditions
Zero while the repo is public and uses standard runners. Costs could arise only if: the repo becomes private **and** a
payment method with a budget is attached (otherwise Actions stops at 2,000 min); larger runners are selected; or
Pages/Actions are moved to a paid plan. None of these are configured.
