import {
  APPROVED_BY_YOU,
  DISCARDED_REASON,
  HELD_REASON,
  type Job,
  STOPPED_REASON,
} from "../state.ts";

/** How loud a state looks; each is a color pair in the page's styles. */
export type Tone = "change" | "comment" | "pending" | "work" | "ok" | "quiet";

export interface Look {
  label: string;
  tone: Tone;
  /** A short second line, e.g. why it failed. The hold timer is shown on its own. */
  note: string | null;
}

/** Who a PR waits on, which is also its column on the board. */
export type Group = "needs" | "progress" | "author" | "done";
export const GROUPS: Group[] = ["needs", "progress", "author", "done"];
export const GROUP_LABELS: Record<Group, string> = {
  needs: "Needs you",
  progress: "Claude is on it",
  author: "Waiting on the author",
  done: "Done",
};

export const TABS = ["needs", "open", "all"] as const;
export type Tab = (typeof TABS)[number];
export const TAB_LABELS: Record<Tab, string> = { needs: "Needs you", open: "Open", all: "All" };

/** A PR that is done and quiet this long leaves the Open tab; All still has it. */
export const OPEN_DAYS = 7;

export const droppedIds = (job: Job): string[] => {
  try {
    const ids = JSON.parse(job.dropped ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

/** A left-as-draft review that needs you, e.g. an approval only you can give. */
const isDraftForYou = (job: Job) =>
  job.status === "done" &&
  job.event === "PENDING" &&
  (job.reason ?? "").startsWith(`${HELD_REASON}:`);

/** What a job's state means to you. */
export function describeJob(job: Job, { paused }: { paused: boolean }): Look {
  const look = (label: string, tone: Tone, note: string | null = null): Look => ({
    label,
    tone,
    note,
  });
  switch (job.status) {
    case "done":
      if (job.reason === "dry-run") return look("Dry run", "quiet", "Nothing posted");
      if (job.event === "CHANGES_REQUESTED") return look("Requested changes", "change");
      if (job.event === "APPROVED")
        return look("Approved", "ok", job.reason === APPROVED_BY_YOU ? "Approved by you" : null);
      if (job.event === "PENDING") {
        return isDraftForYou(job)
          ? look("Needs your OK", "pending", (job.reason ?? "").slice(HELD_REASON.length + 2))
          : look("Pending draft", "pending", "Only you can see it");
      }
      return look("Commented", "comment");
    case "held": {
      const dropped = droppedIds(job).length;
      return look("Needs your OK", "pending", dropped ? `${dropped} dropped` : null);
    }
    case "reviewed":
      if (paused) return look("Waiting to post", "pending", "Posting is paused");
      if (job.reason === "waiting for CI") return look("Waiting for CI", "work");
      return look("Posting soon", "work");
    case "queued":
      if (job.next_attempt_at && /^session usage /.test(job.reason ?? ""))
        return look("Usage limit", "pending", job.reason);
      return job.next_attempt_at
        ? look("Retrying later", "work", job.error)
        : look("Queued", "quiet");
    case "preparing":
      return look("Checking out…", "work");
    case "reviewing":
      return look("Reviewing…", "work");
    case "posting":
      return look("Posting…", "work");
    case "failed":
      return look("Failed", "change", job.error);
    case "skipped":
      if (job.reason === STOPPED_REASON)
        return look("Stopped", "quiet", "Review now starts it again");
      if (job.reason === DISCARDED_REASON) return look("Discarded", "quiet", "Nothing posted");
      return look("Skipped", "quiet", job.reason);
  }
}

export function groupOf(job: Job): Group {
  if (job.status === "held" || job.status === "failed" || isDraftForYou(job)) return "needs";
  if (["queued", "preparing", "reviewing", "reviewed", "posting"].includes(job.status))
    return "progress";
  if (
    job.status === "done" &&
    job.reason !== "dry-run" &&
    (job.event === "CHANGES_REQUESTED" || job.event === "COMMENTED" || job.event === "PENDING")
  )
    return "author";
  return "done";
}

/**
 * A round is a commit Claude reviewed or was asked to: not one skipped by the rules or replaced
 * by a newer push. A review you stopped or discarded still counts, so you can find it again.
 */
export const isRound = (job: Job) =>
  job.status !== "skipped" || job.reason === STOPPED_REASON || job.reason === DISCARDED_REASON;

export interface PrView {
  repo: string;
  pr: number;
  title: string;
  url: string;
  author: string | null;
  /** Rounds, oldest first: R1 is rounds[0]. */
  rounds: Job[];
  /** Commits skipped or replaced before Claude reviewed them. */
  skipped: number;
  /** The newest job; it decides the PR's state, even when it is a skipped commit. */
  latest: Job;
  group: Group;
  updatedAt: string;
  costUsd: number;
}

/** One view per PR from any jobs, newest activity first. */
export function groupByPr(jobs: Job[]): PrView[] {
  const byPr = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = `${job.repo}#${job.pr}`;
    byPr.set(key, [...(byPr.get(key) ?? []), job]);
  }
  return [...byPr.values()]
    .map((list) => toPrView(list))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The view of one PR from its jobs (any order). */
export function toPrView(jobs: Job[]): PrView {
  const sorted = [...jobs].sort((a, b) => a.id - b.id);
  const latest = sorted[sorted.length - 1] as Job;
  const rounds = sorted.filter(isRound);
  return {
    repo: latest.repo,
    pr: latest.pr,
    title: latest.title,
    url: latest.url,
    author: sorted.find((j) => j.author)?.author ?? null,
    rounds,
    skipped: sorted.length - rounds.length,
    latest,
    group: groupOf(latest),
    updatedAt: sorted.reduce((max, j) => (j.updated_at > max ? j.updated_at : max), ""),
    costUsd: sorted.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0),
  };
}

export function inTab(pr: PrView, tab: Tab, now: Date): boolean {
  if (tab === "needs") return pr.group === "needs";
  if (tab === "open")
    return pr.group !== "done" || now.getTime() - Date.parse(pr.updatedAt) < OPEN_DAYS * 86_400_000;
  return true;
}

/** Needs you: a running timer first, soonest first; then the rest, newest first. */
export function byUrgency(a: PrView, b: PrView): number {
  const until = (p: PrView) => (p.latest.status === "held" ? p.latest.hold_until : null);
  const ua = until(a);
  const ub = until(b);
  if (ua && ub) return ua.localeCompare(ub);
  if (ua || ub) return ua ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** The PR page's path. */
export const prPath = (pr: { repo: string; pr: number }) => `/pr/${pr.repo}/${pr.pr}`;
