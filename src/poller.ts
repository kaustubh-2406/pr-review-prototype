import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.ts";
import { decide } from "./filters.ts";
import type { Logger } from "./log.ts";
import type { State } from "./state.ts";
import type { GitHubClient } from "./types.ts";

export interface PollDeps {
  github: GitHubClient;
  state: State;
  config: Config;
  viewer: string;
  log: Logger;
  /** Called after a poll that queued work, so the worker can start at once. */
  onQueued?: () => void;
  /** Called after every poll in the loop, with its summary or error. */
  onPolled?: (result: PollSummary | Error) => void;
  /** A new request starts only once the next poll still sees it (default). Off for a one-shot run. */
  confirmRequests?: boolean;
}

export interface PollSummary {
  found: number;
  queued: number;
  skipped: number;
  known: number;
  errors: number;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export async function pollOnce(deps: PollDeps): Promise<PollSummary> {
  const { github, state, config, viewer, log, confirmRequests = true } = deps;
  const requests = await github.searchReviewRequests();
  const summary: PollSummary = {
    found: requests.length,
    queued: 0,
    skipped: 0,
    known: 0,
    errors: 0,
  };

  for (const { repo, number } of requests) {
    try {
      const pr = await github.getPull(repo, number);
      const decision = decide(pr, config, viewer);
      const result = state.recordSeen({
        repo,
        pr: number,
        headSha: pr.headSha,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        decision,
        confirm: confirmRequests,
      });
      const fields = {
        repo,
        pr: number,
        sha: pr.headSha.slice(0, 7),
        title: pr.title,
        url: pr.url,
      };

      if (result === "known") {
        summary.known++;
        log.debug(fields, "already seen");
      } else if (result === "confirmed") {
        summary.queued++;
        log.info(fields, "request confirmed");
      } else if (decision.action === "queue") {
        summary.queued++;
        log.info(fields, result === "requeued" ? "requeued" : "queued");
      } else {
        summary.skipped++;
        log.info({ ...fields, reason: decision.reason }, "skipped");
      }
    } catch (err) {
      // One broken PR should not stop the others from being picked up.
      summary.errors++;
      log.error({ err, repo, pr: number }, "failed to process PR");
    }
  }
  // Requested, then removed before the next poll saw it again: never reviewed.
  for (const job of state.dropUnconfirmed(requests.map((r) => ({ repo: r.repo, pr: r.number })))) {
    summary.skipped++;
    log.info({ repo: job.repo, pr: job.pr, title: job.title }, "request removed before confirming");
  }
  if (summary.queued > 0) deps.onQueued?.();
  return summary;
}

/** Poll until the signal aborts. Runs never overlap; failures back off up to 5 minutes. */
export async function startPolling(deps: PollDeps, signal: AbortSignal): Promise<void> {
  const intervalMs = deps.config.pollIntervalSec * 1000;
  let failures = 0;

  while (!signal.aborted) {
    try {
      const summary = await pollOnce(deps);
      failures = 0;
      deps.log.debug(summary, "poll finished");
      deps.onPolled?.(summary);
    } catch (err) {
      failures++;
      deps.log.error({ err, failures }, "poll failed");
      deps.onPolled?.(err as Error);
    }

    const delay =
      failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    try {
      await sleep(delay, undefined, { signal });
    } catch {
      break; // aborted during the wait
    }
  }
}
