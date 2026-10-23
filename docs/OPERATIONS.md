# Operations runbook — FPL Radar

## Where things live
| What | Where |
|---|---|
| Code | `main` branch |
| Versioned history (prices, status/news changes, hourly market, decisions, alerts, runs, archived projections, validation) | `data` branch |
| Working state (raw responses, last-known-good normalised snapshot, public JSON) | Actions cache `wc-state-*` (rebuildable) |
| Dashboard | GitHub Pages — `https://coder1x86.github.io/fpl-radar/` (Pages source must be "GitHub Actions") |
| Alerts | Issues labelled `wildcard-alert` + severity; optional ntfy / Telegram |
| Decision log + analysis UI | claude.ai Command Center artifact (unchanged) |

## Schedules
- `radar-pipeline` every 5 min (`*/5 * * * *`), daily validation `23 3 * * *` (UTC), manual `workflow_dispatch`.
- Claude scheduled task "WildCard.exe daily FPL brief (cloud)" 08:31 Cairo: reads the data branch, adds news research, republishes the artifact.
- Scheduled workflows run only on the default branch and may be delayed by GitHub under load; in public repos they are
  disabled after 60 days with no repository activity (data commits prevent this).

## Manual operations (Actions → radar-pipeline → Run workflow)
| mode | effect |
|---|---|
| `auto` | normal run (tick `force_model` to recompute now) |
| `validate` | full consistency checks + forecast-vs-actual |
| `notify-test` | sends a `[TEST]` alert through every configured channel |
| `export` | builds SQLite + tarball (in the run workspace; add an upload step if a downloadable copy is needed) |

## Adding optional channels (secrets, never in code)
Settings → Secrets and variables → Actions → New repository secret:
- `NTFY_TOPIC` — a long random topic name; subscribe to it in the ntfy app (push to phone).
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — from @BotFather and your chat.
Variable `DASHBOARD_URL` adds a dashboard link to every alert.

## Updating squad assumptions
Edit `config.toml`: `selling_price_estimates`, `watchlist`, `[[overrides]]` (each needs `source` and `expires`).
The squad itself is read from the public picks endpoint (team as of the last deadline).

## Failure behaviour
- Source down / schema change / "game is updating" page → nothing is overwritten; dashboard shows last-known-good with a
  stale banner; status.json records the error; alert after 2, 6 and 18 consecutive failed runs; "Pipeline recovered" alert afterwards.
- Cache evicted → next run refetches and recomputes; history on the `data` branch is unaffected.
- Workflow broken → GitHub emails the failed run; fix on `main`, then dispatch `auto`.

## Backup and recovery
- Full backup: `git clone -b data https://github.com/CODER1x86/fpl-radar`.
- SQLite export: `WC_DATA_DIR=<clone> python -m wc.run export` → `export/wildcard.sqlite` + tarball.
- Restore elsewhere: copy the data branch into `data/`, run `python -m wc.run auto`.

## Retention / growth control
Raw bootstrap: one per day (~170 KB gz). Market snapshots hourly, compressed per day. Projections archived daily plus
hourly in the last 3 h before each deadline. Heartbeat-only changes are committed every 15 min, not every run.

## Known limitations
- Prices/ownership/news are from the official API only; press-conference news is added by the daily Claude task, not the pipeline.
- Real selling prices, bank changes made after the last deadline, and pending transfers are private to the signed-in owner; the pipeline uses estimates and the team at the last deadline.
- "Real-time" means every ~5 min, subject to GitHub schedule delays.
- Price-change *predictions* are not produced; only observed changes and net-transfer counts.
