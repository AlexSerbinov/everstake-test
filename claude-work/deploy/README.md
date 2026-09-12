# Running the freshness scheduler on the deployment

The demo host runs the API in one container (`kb`) and the incremental re-check in a second one
(`refresher`), both from the same image and both mounting the same `data/kb.db`. That is the
whole deployment story; there is no cron on the host and no systemd unit to keep in sync with
`config/kb.yaml`.

```
docker compose up -d --build          # starts kb + refresher
docker compose logs -f refresher      # what the last pass found
docker compose stop refresher         # pause re-checking without touching the API
```

## Why a second container and not a timer inside the API

The scheduler is one `setInterval` in `src/refresh/schedule.ts`, and the API process can run it
(`REFRESH_SCHEDULER=1`). It is deliberately **not** enabled there on this deployment, for two
reasons:

- **Blast radius.** A refresh holds the SQLite write lock while it re-embeds and re-extracts. In
  the API process that competes with answering questions; in its own process the API keeps
  reading (WAL allows concurrent readers) and only the refresher blocks.
- **One writer.** The overlap guard in the scheduler is per process. Two processes both running
  the loop would both see the same documents as due and both fetch them. Exactly one container
  runs it, which is a property you can check with `docker compose ps` rather than a claim.

`npm run refresh` from a shell is still safe at any time: it writes a `refresh_runs` row, and the
scheduler's next pass simply finds fewer documents due.

## What the container does

`node dist/refresh/schedule.js` wakes every `freshness.scheduler.tick_minutes` (15 by default),
asks `refresh()` what is due, and goes back to sleep. There is no schedule state anywhere: dueness
is computed from `documents.checked_at` against each source type's interval, so a missed tick, a
restart or a redeploy costs nothing but a slightly later first pass.

`REFRESH_SCHEDULER=1` in the compose file is what turns it on; without it the process exits the
loop immediately, which is why the same image is safe to run as the API.

## Environment

| Variable | Why |
|---|---|
| `GITHUB_TOKEN` | Optional, no scopes needed for public repos. Unauthenticated GitHub allows 60 requests/hour **per IP**, shared with everything else on the host; a token raises it to 5 000. Without it the GitHub source is skipped with a warning on a busy host rather than failing the run. |
| `REFRESH_SCHEDULER` | `1` turns the in-process loop on. Set on the `refresher` service only. |
| `GEMINI_API_KEY` etc. | The refresher spends money only when a page actually changed and its depth is `refacts`. It needs the same keys as the API. |

## If you would rather use a host timer

Nothing about the design requires the container. `npm run refresh` is idempotent and safe to run
from anywhere that can see the database, so a systemd timer works too:

```ini
# /etc/systemd/system/everstake-kb-refresh.service
[Unit]
Description=everstake-kb incremental refresh
[Service]
Type=oneshot
WorkingDirectory=/opt/everstake-kb
EnvironmentFile=/opt/everstake-kb/.env
ExecStart=/usr/bin/docker compose run --rm kb node dist/cli.js refresh
```

```ini
# /etc/systemd/system/everstake-kb-refresh.timer
[Unit]
Description=Run the everstake-kb refresh every 15 minutes
[Timer]
OnBootSec=10min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
```

`systemctl enable --now everstake-kb-refresh.timer`. The trade-off is the one the compose service
avoids: the timer's cadence is now a second place where "how often do we check" is written down,
and it can disagree with `config/kb.yaml` without anything complaining.
