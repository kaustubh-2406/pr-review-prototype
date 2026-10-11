import { describe, expect, it } from "vitest";
import type { Finding, ReviewRun } from "../src/reviewer.ts";
import type { Job } from "../src/state.ts";
import type { TicketContext } from "../src/ticket.ts";
import { html, raw, richText, toHtmlString } from "../src/web/html.ts";
import type { Chrome } from "../src/web/layout.ts";
import { renderListPage } from "../src/web/list-page.ts";
import { byUrgency, groupByPr, inTab, toPrView } from "../src/web/prs.ts";
import { renderReviewPage } from "../src/web/review-page.ts";

const NOW = new Date("2026-10-11T12:00:00Z");
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

let nextId = 1;
function job(over: Partial<Job> = {}): Job {
  return {
    id: nextId++,
    repo: "acme/api",
    pr: 1,
    head_sha: "abc1234def",
    title: "Add retries",
    url: "https://github.com/acme/api/pull/1",
    status: "done",
    reason: null,
    attempts: 0,
    review_id: 1,
    findings: 1,
    error: null,
    next_attempt_at: null,
    started_at: null,
    output_dir: null,
    cost_usd: 0.5,
    duration_ms: 1,
    review_url: "https://github.com/acme/api/pull/1#r1",
    event: "CHANGES_REQUESTED",
    round: 1,
    parent_job_id: null,
    waiting_since: null,
    hold_until: null,
    released: null,
    dropped: null,
    author: "dev",
    awaiting_confirm: 0,
    created_at: at(60),
    updated_at: at(60),
    ...over,
  };
}

const chrome = (over: Partial<Chrome> = {}): Chrome => ({
  token: "tok",
  nonce: "n0nce",
  back: "/",
  error: null,
  now: NOW,
  viewer: "me",
  lastPollAt: at(1),
  lastPollError: null,
  pollIntervalSec: 60,
  postingPaused: false,
  publishMode: "submit",
  sessionUsage: null,
  maxSessionUsagePct: null,
  picks: {
    model: "claude-opus-5-5",
    effort: "high",
    style: "readable",
    holdMin: 30,
    models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    efforts: ["low", "medium", "high"],
    styles: [{ key: "readable", label: "Readable" }],
    holdChoices: [0, 30],
  },
  ...over,
});

const finding = (over: Record<string, unknown> = {}): Finding =>
  ({
    id: "F1",
    path: "src/a.ts",
    line: 3,
    severity: "bug",
    title: "Retries never stop",
    problem: "The loop ignores `takeRetry()`.",
    impact: "It retries forever.",
    fix: "FIX-TEXT return early",
    suggestion: "SUGGESTION-CODE",
    why: "WHY-TEXT traced it",
    ...over,
  }) as Finding;
const run = (over: Partial<ReviewRun> = {}): ReviewRun =>
  ({
    costUsd: 1,
    durationMs: 1,
    numTurns: 1,
    sessionId: "s",
    review: { summary: "Summary.", verdict: "request_changes", findings: [finding()] },
    ...over,
  }) as ReviewRun;

describe("html helper", () => {
  it("escapes every value unless it is html itself", () => {
    const out = toHtmlString(
      html`<p title="${`"><script>`}">${"<b>&'"}${raw("<i>ok</i>")}${[html`<br>`, "<x>"]}${null}${false}</p>`,
    );
    expect(out).toBe(
      '<p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;&amp;&#39;<i>ok</i><br>&lt;x&gt;</p>',
    );
  });

  it("shows backtick spans as code, still escaped", () => {
    expect(toHtmlString(richText("call `a<b>()` now"))).toBe("call <code>a&lt;b&gt;()</code> now");
  });
});

describe("PRs from jobs", () => {
  it("groups commits into one PR: rounds, skipped commits, and the newest decides the state", () => {
    const jobs = [
      job({ id: 1, status: "skipped", reason: "superseded" }),
      job({ id: 2, updated_at: at(50) }),
      job({ id: 3, status: "held", event: null, round: 2, hold_until: at(-20), updated_at: at(5) }),
      job({ id: 4, pr: 2, status: "reviewing", updated_at: at(1) }),
    ];
    const [second, first] = groupByPr(jobs);
    expect(second?.pr).toBe(2);
    expect(first).toMatchObject({ pr: 1, skipped: 1, group: "needs", costUsd: 1.5 });
    expect(first?.rounds.map((j) => j.id)).toEqual([2, 3]);
    expect(second?.group).toBe("progress");
  });

  it("counts a review you stopped or discarded as a round", () => {
    const pr = toPrView([
      job({ status: "skipped", reason: "discarded by you" }),
      job({ status: "skipped", reason: "draft" }),
    ]);
    expect(pr.rounds).toHaveLength(1);
    expect(pr.skipped).toBe(1);
    expect(pr.group).toBe("done");
  });

  it("keeps what waits on you or Claude in Open; the rest leaves after 2 quiet days", () => {
    const open = (j: Partial<Job>) => inTab(toPrView([job(j)]), "open", NOW);
    expect(open({ event: "APPROVED", updated_at: at(1440) })).toBe(true);
    expect(open({ event: "APPROVED", updated_at: at(3 * 1440) })).toBe(false);
    // Waiting on the author: a merged or abandoned PR looks just like this, so it leaves too.
    expect(open({ event: "COMMENTED", updated_at: at(1440) })).toBe(true);
    expect(open({ event: "COMMENTED", updated_at: at(12 * 1440) })).toBe(false);
    expect(open({ status: "held", updated_at: at(30 * 1440) })).toBe(true);
    expect(open({ status: "queued", updated_at: at(30 * 1440) })).toBe(true);
    const old = toPrView([job({ event: "APPROVED", updated_at: at(30 * 1440) })]);
    expect(inTab(old, "all", NOW)).toBe(true);
    expect(inTab(old, "needs", NOW)).toBe(false);
  });

  it("orders Needs you by the timer that runs out first", () => {
    const later = toPrView([job({ status: "held", hold_until: at(-30) })]);
    const sooner = toPrView([job({ status: "held", hold_until: at(-5) })]);
    const noTimer = toPrView([job({ status: "failed", updated_at: at(0) })]);
    expect([noTimer, later, sooner].sort(byUrgency)).toEqual([sooner, later, noTimer]);
  });
});

describe("list page", () => {
  const prs = groupByPr([
    job({ id: 10, pr: 1, status: "held", event: null, hold_until: at(-20), updated_at: at(2) }),
    job({ id: 11, pr: 2, status: "reviewing", updated_at: at(1) }),
    job({ id: 12, pr: 3, event: "APPROVED", updated_at: at(3) }),
  ]);
  const render = (tab: "needs" | "open" | "all") =>
    renderListPage({ chrome: chrome(), tab, prs, tickets: new Map([["acme/api#1", ["AXY-1"]]]) });

  it("Needs you: full rows with the live timer", () => {
    const out = render("needs");
    expect(out).toContain('class="row"');
    expect(out).toContain(`class="countdown" data-until="${at(-20)}"`);
    expect(out).toContain("by dev · AXY-1 · $0.50 total");
    expect(out).not.toContain("acme/api#2");
    expect(out).toContain("<title>(1) Proxy Reviewer</title>");
  });

  it("Open: a board with a column for each who it waits on", () => {
    const out = render("open");
    expect(out).toContain('class="board"');
    for (const col of ["Needs you", "Claude is on it", "Waiting on the author", "Done"])
      expect(out).toContain(col);
  });

  it("All: one dense line per PR with round pills", () => {
    const out = render("all");
    expect(out.match(/class="line"/g)).toHaveLength(3);
    expect(out).toContain('href="/pr/acme/api/3?round=1"');
  });
});

describe("review page", () => {
  const held = job({
    id: 21,
    status: "held",
    event: null,
    round: 2,
    hold_until: at(-20),
    dropped: '["F2"]',
  });
  const first = job({ id: 20 });
  const pr = toPrView([first, held]);
  const runs = new Map<number, ReviewRun | null>([
    [20, run({ review: { summary: "First.", verdict: "request_changes", findings: [finding()] } })],
    [
      21,
      run({
        review: {
          summary: "Second.",
          verdict: "request_changes",
          findings: [
            finding({ id: "F2", title: "Race in refill" }),
            finding({ id: "F3", title: "Token in logs" }),
          ],
        },
        followUp: {
          round: 2,
          parentJobId: 20,
          prevSha: "abc1234",
          linear: true,
          sinceLastLines: 3,
          ledger: [],
          previous: [
            {
              ...finding(),
              sha: "abc",
              round: 1,
              status: "fixed",
              thread: null,
              verdict: "fixed",
              evidence: "e",
              reply: "Fixed now.",
              fixedAt: [],
              threadResolved: true,
            },
          ],
        },
      } as Partial<ReviewRun>),
    ],
  ]);
  const render = (openRound: number | null = null) =>
    renderReviewPage({
      chrome: chrome({ back: "/pr/acme/api/1" }),
      pr,
      runs,
      ticket: undefined,
      openRound,
      canApprove: true,
    });

  it("shows only what's wrong and what happens if not fixed, never the fix or the reasoning", () => {
    const out = render();
    expect(out).toContain("What's wrong:");
    expect(out).toContain("What happens if not fixed:");
    for (const hidden of ["FIX-TEXT", "SUGGESTION-CODE", "WHY-TEXT", "Why I think so"])
      expect(out).not.toContain(hidden);
  });

  it("cuts the fix off an old one-body finding", () => {
    const old = job({ id: 40 });
    const classic = {
      id: "F1",
      path: "a.ts",
      line: 1,
      severity: "bug",
      body: "Loop never ends. Load spikes. Fix: return early.",
    } as Finding;
    const out = renderReviewPage({
      chrome: chrome(),
      pr: toPrView([old]),
      runs: new Map([
        [40, run({ review: { summary: "S.", verdict: "request_changes", findings: [classic] } })],
      ]),
      ticket: undefined,
      openRound: null,
      canApprove: false,
    });
    expect(out).toContain("Loop never ends. Load spikes.");
    expect(out).not.toContain("return early");
  });

  it("puts every round on one timeline, newest open, with each finding's later verdict", () => {
    const out = render();
    expect(out.indexOf('id="r2"')).toBeLessThan(out.indexOf('id="r1"'));
    expect(out).toMatch(/id="r2" open/);
    expect(out).not.toMatch(/id="r1" open/);
    expect(out).toContain("R1 raised → R2 fixed");
    expect(render(1)).toMatch(/id="r1" open/);
  });

  it("offers Drop/Keep on the held round and the actions in the side panel", () => {
    const out = render();
    expect(out).toContain('action="/do/jobs/21/drop"');
    expect(out).toContain(
      '<input type="hidden" name="id" value="F2"><input type="hidden" name="dropped" value="0"><button class="small"',
    );
    expect(out).toContain("1 to post");
    expect(out).toContain("Post 1 finding");
    for (const a of ["handle", "discard", "rereview"])
      expect(out).toContain(`action="/do/jobs/21/${a}"`);
    expect(out).toContain(`class="countdown" data-until="${at(-20)}"`);
  });
});

describe("escaping", () => {
  const EVIL = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
  const evilFinding = finding({
    id: "F1",
    path: EVIL,
    title: EVIL,
    problem: `${EVIL} \`${EVIL}\``,
    impact: EVIL,
    body: EVIL,
  });
  const jobs = [
    job({
      id: 31,
      title: EVIL,
      author: EVIL,
      reason: EVIL,
      error: EVIL,
      status: "failed",
      updated_at: at(9),
    }),
    job({
      id: 32,
      pr: 2,
      title: EVIL,
      author: EVIL,
      status: "held",
      event: null,
      round: 2,
      dropped: EVIL,
      updated_at: at(8),
    }),
    job({ id: 33, pr: 3, title: EVIL, status: "skipped", reason: EVIL, updated_at: at(7) }),
    job({
      id: 34,
      pr: 4,
      title: EVIL,
      status: "done",
      event: "PENDING",
      reason: `needs your OK: ${EVIL}`,
      updated_at: at(6),
    }),
  ];
  const ticket: TicketContext = {
    truncated: false,
    tickets: [
      { id: EVIL, title: EVIL, url: "javascript:alert(3)", description: EVIL, templateOnly: false },
    ],
  };
  const evilRun = run({
    review: {
      summary: EVIL,
      verdict: "request_changes",
      findings: [evilFinding, { ...evilFinding, id: "F2", title: undefined }],
    },
    followUp: {
      round: 2,
      parentJobId: 1,
      prevSha: EVIL,
      linear: false,
      sinceLastLines: 1,
      ledger: [],
      previous: [
        {
          ...evilFinding,
          sha: "a",
          round: 1,
          status: "not_fixed",
          thread: null,
          verdict: "not_fixed",
          evidence: EVIL,
          reply: EVIL,
          overruled: EVIL,
          fixedAt: [],
          threadResolved: false,
        },
      ],
    },
  } as Partial<ReviewRun>);

  const pages = [
    ...(["needs", "open", "all"] as const).map((tab) =>
      renderListPage({
        chrome: chrome({ error: EVIL, lastPollError: EVIL, back: EVIL }),
        tab,
        prs: groupByPr(jobs),
        tickets: new Map([["acme/api#1", [EVIL]]]),
      }),
    ),
    ...jobs.map((j) =>
      renderReviewPage({
        chrome: chrome({ error: EVIL }),
        pr: toPrView([{ ...j, url: "javascript:alert(4)", review_url: "javascript:alert(5)" }]),
        runs: new Map([[j.id, evilRun]]),
        ticket,
        openRound: null,
        canApprove: true,
      }),
    ),
  ];

  it("never lets PR, review or ticket text out as markup", () => {
    for (const out of pages) {
      expect(out).not.toContain("<script>alert");
      expect(out).not.toContain("<img");
      expect(out).not.toContain("onerror=alert(2)>");
      expect(out.match(/<script/g)).toHaveLength(1); // only the page's own script
      expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });

  it("makes non-http links inert", () => {
    for (const out of pages) expect(out).not.toMatch(/href="javascript:/i);
  });
});
