# validator-tracker-dispatch (Cloudflare Cron → GitHub dispatch)

A tiny Cloudflare Worker whose only job is to fire this repo's **collect**
workflow every 5 minutes through GitHub's `workflow_dispatch` API.

Why: GitHub throttles `schedule:` triggers on this repo to roughly one run
per hour, so the tracker feed lagged up to ~1 hour behind the chain.
Cloudflare Cron Triggers fire on time. The GitHub schedule stays enabled as
a backup, and `collect.yml` already has a `concurrency` group
(`cancel-in-progress: false`), so runs from the two triggers are serialized
and data commits never race.

## How it works

- Cron Trigger `*/5 * * * *` runs the Worker's `scheduled` handler.
- The handler POSTs to
  `https://api.github.com/repos/QL1-Infinite42-Guppy-Histoire/42-validator-tracker/actions/workflows/collect.yml/dispatches`
  with body `{"ref":"main"}` and logs the HTTP status (204 = dispatched).
- A plain GET on the workers.dev URL returns a short health text and never
  dispatches anything.

## Secret

The Worker needs one secret, `GH_PAT`: a fine-grained GitHub personal
access token scoped to this repo with **Actions: write** permission. It is
never stored in this repo. Set it with the Cloudflare connector helper
(value read from stdin, never from argv or a file):

```text
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py \
  put-secret <account_id> validator-tracker-dispatch GH_PAT
```

While `GH_PAT` is unset, the cron still fires every 5 minutes but the
handler logs "GH_PAT secret is not set; skipping dispatch." and exits
without calling GitHub.

## Deploy / redeploy

Deploys on this machine go through the Cloudflare connector helper (the
account is authenticated through the `custom.cloudflare` connector, not
`wrangler login`):

```text
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py \
  deploy <account_id> validator-tracker-dispatch worker.js
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py \
  put-schedules <account_id> validator-tracker-dispatch "*/5 * * * *"
```

`wrangler.toml` in this folder carries the same settings (name, cron) for
anyone deploying with wrangler instead.
