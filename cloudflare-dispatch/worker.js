// validator-tracker-dispatch
//
// Cron-only bridge: Cloudflare Cron Trigger (every 5 minutes) asks GitHub
// to run the 42-validator-tracker "collect" workflow via workflow_dispatch.
// This replaces reliance on GitHub's own schedule trigger, which GitHub
// throttles to roughly one run per hour on this repo. The GitHub schedule
// stays enabled in collect.yml as a backup, and the workflow's concurrency
// guard serializes runs so the two triggers can never race on data commits.
//
// Required Worker secret (set out-of-band, never in this repo):
//   GH_PAT - fine-grained GitHub PAT with Actions: write on
//            QL1-Infinite42-Guppy-Histoire/42-validator-tracker.
// While GH_PAT is unset the scheduled handler logs and exits gracefully;
// nothing is dispatched.

const DISPATCH_URL =
  "https://api.github.com/repos/QL1-Infinite42-Guppy-Histoire/42-validator-tracker/actions/workflows/collect.yml/dispatches";

async function dispatch(env) {
  if (!env.GH_PAT) {
    console.log("GH_PAT secret is not set; skipping dispatch.");
    return;
  }
  const res = await fetch(DISPATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "validator-tracker-dispatch",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // GitHub answers 204 No Content on a successful dispatch.
  console.log(`workflow_dispatch collect.yml -> HTTP ${res.status}`);
  if (res.status !== 204) {
    console.log(`dispatch failed: ${await res.text()}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },

  // Harmless health text only. This handler never dispatches.
  async fetch() {
    return new Response(
      "validator-tracker-dispatch: cron-only worker. Every 5 minutes it " +
        "dispatches the collect workflow of " +
        "QL1-Infinite42-Guppy-Histoire/42-validator-tracker on GitHub.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};
