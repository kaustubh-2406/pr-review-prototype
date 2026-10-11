/**
 * PROTOTYPE, throwaway, for issue #8. Not for main.
 *
 * Question: what should the PR list page and the full-page review look like?
 * Six list layouts on `/` (?v=A..F) and five review layouts on `/pr/<owner>/<repo>/<n>` (?rv=A..E),
 * plus toggles for the issue's open questions: pickers= (where the model/effort/style/wait pickers live),
 * filter= (how finished PRs leave the list) and fields= (what a PR row shows).
 *
 * Fake data in memory. Buttons are real <form method="post"> posts to a stub that redirects back.
 * Rendered on the server with the escaping `html` helper the issue proposes.
 *
 * Run: npm run prototype  →  http://localhost:4778
 */
import { createServer, type IncomingMessage } from "node:http";

// ---------------------------------------------------------------- html helper (escapes by default)

type Raw = { readonly __raw: string };
const raw = (s: string): Raw => ({ __raw: s });
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
function show(v: unknown): string {
  if (v == null || v === false) return "";
  if (Array.isArray(v)) return v.map(show).join("");
  if (typeof v === "object" && "__raw" in v) return (v as Raw).__raw;
  return esc(v);
}
function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += show(v) + (strings[i + 1] ?? "");
  });
  return raw(out);
}
/** Backtick spans become <code>; every piece is still escaped. */
const rich = (text: string) => html`${text.split("`").map((p, i) => (i % 2 ? html`<code>${p}</code>` : p))}`;

// ---------------------------------------------------------------- fake data

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000);
const ahead = (min: number) => new Date(NOW + min * 60_000);
const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function rel(d: Date): string {
  const min = Math.round((NOW - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}
const dayOf = (d: Date) => {
  const days = Math.floor((new Date(NOW).setHours(24, 0, 0, 0) - d.getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
};

type Sev = "bug" | "risk" | "question" | "nit";
interface Finding {
  id: string;
  severity: Sev;
  path: string;
  line: number;
  title: string;
  problem: string;
  impact: string;
  fix: string;
  why: string;
  suggestion?: string;
  dropped?: boolean;
}
type Verdict = "fixed" | "explained" | "no_longer_applies" | "partly_fixed" | "not_fixed";
interface Prev {
  id: string;
  severity: Sev;
  path: string;
  line: number;
  title: string;
  verdict: Verdict;
  reply: string;
}
type RState = "held" | "changes" | "approved" | "commented" | "reviewing" | "queued" | "failed" | "discarded";
interface Round {
  n: number;
  sha: string;
  state: RState;
  at: Date;
  holdUntil?: Date | null;
  summary: string;
  findings: Finding[];
  previous?: Prev[];
  costUsd: number;
  minutes: number;
  error?: string;
}
interface PR {
  repo: string;
  number: number;
  title: string;
  author: string;
  ticket?: string;
  closed?: "merged" | "closed";
  skipped: number;
  rounds: Round[];
}

const mini = (id: string, severity: Sev, path: string, line: number, title: string): Finding => ({
  id,
  severity,
  path,
  line,
  title,
  problem: `${title}. The new code path at line ${line} does not handle it.`,
  impact: "Users hit it on the first retry after a timeout.",
  fix: "Handle the case where it happens and add a test for it.",
  why: "Read the call sites; none of them guard against it.",
});
const fixedFrom = (fs: Finding[]): Prev[] =>
  fs.map((f) => ({ id: f.id, severity: f.severity, path: f.path, line: f.line, title: f.title, verdict: "fixed", reply: "Fixed in this push." }));

const R1_2048: Finding[] = [
  {
    id: "F1",
    severity: "bug",
    path: "src/sync/worker.ts",
    line: 88,
    title: "Retries never stop when the budget hits zero",
    problem: "`takeRetry()` returns `false` at zero, but `runSync` ignores the result and calls `schedule()` anyway.",
    impact: "A tenant whose upstream is down retries every 250 ms forever, the exact load the budget was meant to stop.",
    fix: "Return early when `takeRetry()` is false and mark the job `gave_up`.",
    suggestion: "if (!budget.takeRetry(tenant)) {\n  return markGaveUp(job);\n}",
    why: "Traced `runSync` → `schedule` with a budget of 0. The test in `budget.test.ts` only checks the counter, not that scheduling stops.",
  },
  {
    id: "F2",
    severity: "risk",
    path: "src/sync/budget.ts",
    line: 21,
    title: "One budget is shared by every tenant",
    problem: "`RetryBudget` is a module-level singleton keyed by nothing.",
    impact: "One noisy tenant spends the budget and every other tenant's retries are refused.",
    fix: "Key the budget by tenant id, e.g. a `Map<string, Bucket>`.",
    why: "`new RetryBudget()` appears once, at module scope; `takeRetry` takes no tenant argument.",
  },
  {
    id: "F3",
    severity: "question",
    path: "src/sync/worker.ts",
    line: 102,
    title: "Why a fixed 250 ms of jitter?",
    problem: "Jitter is fixed at 250 ms while the base delay grows to 30 s.",
    impact: "At 30 s, 250 ms barely spreads retries, so tenants that failed together retry together.",
    fix: "Use jitter proportional to the delay (full jitter), unless 250 ms is deliberate.",
    why: "Ticket AXY-412 mentions a thundering herd after the March outage.",
  },
  {
    id: "F4",
    severity: "nit",
    path: "src/sync/budget.ts",
    line: 9,
    title: "`amt` reads as an amount, but it counts tokens",
    problem: "The field is named `amt`.",
    impact: "Readers assume money or bytes.",
    fix: "Rename to `tokens`.",
    why: "Every use is a token count.",
  },
];
const R2_2048: Finding[] = [
  {
    id: "F5",
    severity: "bug",
    path: "src/sync/budget.ts",
    line: 44,
    title: "Refill and spend race under concurrent syncs",
    problem: "`refill()` reads `tokens`, awaits the clock, then writes `tokens + n`. A `takeRetry()` in between is lost.",
    impact: "Under load the budget refills past its cap, so the limit silently stops limiting.",
    fix: "Read and write in one synchronous step, or compute tokens from timestamps instead of a stored count.",
    suggestion: "const elapsed = now - this.lastRefill;\nthis.tokens = Math.min(this.cap, this.tokens + elapsed * this.rate);\nthis.lastRefill = now;",
    why: "`await this.clock.now()` sits between the read on line 42 and the write on line 44.",
  },
  {
    id: "F6",
    severity: "risk",
    path: "src/sync/worker.ts",
    line: 131,
    title: "Log line writes the upstream token to disk",
    problem: "`log.warn({ req }, ...)` logs the whole request, including the `Authorization` header.",
    impact: "Upstream tokens land in log files that ship to the shared log store.",
    fix: "Log `req.method` and `req.url` only, or add `req.headers.authorization` to pino's redact list.",
    why: "pino serializes the object as given; there is no redact config in `log.ts`.",
  },
  { ...mini("F7", "nit", "src/sync/worker.ts", 140, "Two blank lines in a row"), dropped: true },
];

const PRS: PR[] = [
  {
    repo: "Axy-Science/Axy-K-Git",
    number: 2048,
    title: "Add a retry budget to the sync worker",
    author: "dev-ravi",
    ticket: "AXY-412",
    skipped: 1,
    rounds: [
      {
        n: 1,
        sha: "a41c9e2",
        state: "changes",
        at: ago(26 * 60),
        summary: "Good direction, but the budget does not stop retries yet, and one budget is shared by every tenant.",
        findings: R1_2048,
        costUsd: 1.12,
        minutes: 6.4,
      },
      {
        n: 2,
        sha: "e07b5d1",
        state: "held",
        at: ago(14),
        holdUntil: ahead(23),
        summary:
          "The infinite-retry bug is fixed and the jitter question is answered. The budget is still shared across tenants, and the refill change brought two new problems: a race that can push the budget past its cap, and a log line that writes the upstream token to disk.",
        findings: R2_2048,
        previous: [
          { id: "F1", severity: "bug", path: "src/sync/worker.ts", line: 88, title: R1_2048[0]?.title ?? "", verdict: "fixed", reply: "Fixed: `runSync` returns when the budget is spent." },
          { id: "F2", severity: "risk", path: "src/sync/budget.ts", line: 21, title: R1_2048[1]?.title ?? "", verdict: "not_fixed", reply: "Still one budget for everyone. The author says tenants are few today; that is a reason, not a fix." },
          { id: "F3", severity: "question", path: "src/sync/worker.ts", line: 102, title: R1_2048[2]?.title ?? "", verdict: "explained", reply: "250 ms matches the upstream's rate-limit window. Fair." },
          { id: "F4", severity: "nit", path: "src/sync/budget.ts", line: 9, title: R1_2048[3]?.title ?? "", verdict: "not_fixed", reply: "Not renamed." },
        ],
        costUsd: 0.84,
        minutes: 4.9,
      },
    ],
  },
  {
    repo: "Axy-Science/axy-web",
    number: 2061,
    title: "Prorate plan changes mid-cycle",
    author: "nisha-k",
    ticket: "AXY-430",
    skipped: 0,
    rounds: [
      {
        n: 1,
        sha: "9bd03f7",
        state: "held",
        at: ago(48),
        holdUntil: null,
        summary: "Proration works for upgrades in the common case, but the day count is wrong for billing periods that cross a month, and money is computed in floating point.",
        findings: [
          {
            id: "F1",
            severity: "bug",
            path: "src/billing/prorate.ts",
            line: 37,
            title: "Days are counted in the calendar month, not the billing period",
            problem: "`daysInMonth(now)` is used as the denominator, but periods run from the 14th to the 13th.",
            impact: "A customer upgrading on the 2nd of a 28-day February is charged for 26/28 of a 31-day period.",
            fix: "Use `period.end - period.start` in days.",
            why: "Ticket AXY-430 says periods follow the signup date.",
          },
          {
            id: "F2",
            severity: "risk",
            path: "src/billing/prorate.ts",
            line: 52,
            title: "Money is computed in floating point",
            problem: "`price * ratio` is a float and is rounded only at display time.",
            impact: "Invoices can be off by a cent, and totals won't match Stripe's line items.",
            fix: "Work in integer cents and round once, with the same rule Stripe uses.",
            why: "Stripe amounts are integers; this value is sent as `amount: Math.round(x * 100)` later.",
          },
          mini("F3", "question", "src/billing/prorate.ts", 12, "Should a downgrade refund or credit?"),
        ],
        costUsd: 0.67,
        minutes: 3.8,
      },
    ],
  },
  {
    repo: "Axy-Science/Axy-K-Git",
    number: 2066,
    title: "Bump octokit to 5.1",
    author: "renovate[bot]",
    skipped: 0,
    rounds: [
      {
        n: 1,
        sha: "51ac0de",
        state: "failed",
        at: ago(31),
        summary: "",
        findings: [],
        costUsd: 0,
        minutes: 0,
        error: "git fetch failed: couldn't find remote ref refs/pull/2066/head",
      },
    ],
  },
  {
    repo: "Axy-Science/axy-web",
    number: 2070,
    title: "Onboarding checklist: remember dismissed steps",
    author: "tomasz-w",
    skipped: 0,
    rounds: [{ n: 1, sha: "c3e8a10", state: "reviewing", at: ago(4), summary: "", findings: [], costUsd: 0, minutes: 0 }],
  },
  {
    repo: "Axy-Science/Axy-K-Git",
    number: 2072,
    title: "Drop Node 22 from the CI matrix",
    author: "dev-ravi",
    skipped: 0,
    rounds: [{ n: 1, sha: "7f2b9c4", state: "queued", at: ago(1), summary: "", findings: [], costUsd: 0, minutes: 0 }],
  },
  {
    repo: "Axy-Science/axy-web",
    number: 2055,
    title: "Team invites: resend and expire",
    author: "li-mei",
    ticket: "AXY-401",
    skipped: 0,
    rounds: [
      {
        n: 1,
        sha: "2d6e4b8",
        state: "changes",
        at: ago(130),
        summary: "Resend works. Expired invites can still be accepted, and the resend button has no rate limit.",
        findings: [
          mini("F1", "bug", "src/invites/accept.ts", 22, "Expired invites can still be accepted"),
          mini("F2", "risk", "src/invites/resend.ts", 15, "Resend has no rate limit"),
          mini("F3", "nit", "src/invites/email.tsx", 8, "Subject line says 'Invitaton'"),
        ],
        costUsd: 0.51,
        minutes: 3.1,
      },
    ],
  },
  {
    repo: "Axy-Science/axy-web",
    number: 2077,
    title: `Escape <script>alert("x")</script> & 'quotes' in titles`,
    author: "mallory-test",
    skipped: 0,
    rounds: [
      {
        n: 1,
        sha: "0e1f2a3",
        state: "commented",
        at: ago(300),
        summary: `This PR exists to test escaping: <b>bold?</b> & "quotes" & <script>alert(1)</script> must show as text.`,
        findings: [
          {
            ...mini("F1", "question", "src/<img src=x onerror=alert(1)>.ts", 3, `Is <img src=x onerror=alert(1)> rendered raw anywhere?`),
            problem: `A title like <script>alert("x")</script> & 'quotes' should come out as text, with \`<code>\` kept.`,
          },
        ],
        costUsd: 0.22,
        minutes: 1.4,
      },
    ],
  },
  {
    repo: "Axy-Science/Axy-K-Git",
    number: 2023,
    title: "Fix the flaky upload test",
    author: "li-mei",
    skipped: 2,
    rounds: [
      {
        n: 1,
        sha: "f00d1e5",
        state: "changes",
        at: ago(3 * 1440),
        summary: "The sleep is gone, but the test now depends on the order of two async writes.",
        findings: [mini("F1", "bug", "test/upload.test.ts", 41, "Test depends on the order of two writes"), mini("F2", "nit", "test/upload.test.ts", 3, "Unused import")],
        costUsd: 0.48,
        minutes: 2.9,
      },
      {
        n: 2,
        sha: "b16b00b",
        state: "changes",
        at: ago(2 * 1440),
        summary: "Order is fixed; the temp directory is no longer cleaned up.",
        findings: [mini("F3", "risk", "test/upload.test.ts", 12, "Temp directory is never removed")],
        previous: fixedFrom([mini("F1", "bug", "test/upload.test.ts", 41, "Test depends on the order of two writes")]),
        costUsd: 0.39,
        minutes: 2.2,
      },
      {
        n: 3,
        sha: "c0ffee1",
        state: "approved",
        at: ago(20 * 60),
        summary: "Everything from earlier rounds is fixed. Approved.",
        findings: [],
        previous: fixedFrom([mini("F3", "risk", "test/upload.test.ts", 12, "Temp directory is never removed")]),
        costUsd: 0.31,
        minutes: 1.8,
      },
    ],
  },
  {
    repo: "Axy-Science/Axy-K-Git",
    number: 2030,
    title: "Cache GitHub App installation tokens",
    author: "tomasz-w",
    closed: "merged",
    skipped: 0,
    rounds: [
      {
        n: 1,
        sha: "1a2b3c4",
        state: "changes",
        at: ago(5 * 1440),
        summary: "Tokens are cached past their expiry.",
        findings: [mini("F1", "bug", "src/github/app.ts", 30, "Cached tokens outlive their expiry")],
        costUsd: 0.55,
        minutes: 3.3,
      },
      {
        n: 2,
        sha: "5d6e7f8",
        state: "approved",
        at: ago(4 * 1440),
        summary: "Expiry is respected now. Approved.",
        findings: [],
        previous: fixedFrom([mini("F1", "bug", "src/github/app.ts", 30, "Cached tokens outlive their expiry")]),
        costUsd: 0.29,
        minutes: 1.6,
      },
    ],
  },
  {
    repo: "Axy-Science/axy-web",
    number: 2012,
    title: "Experiment: dark mode toggle",
    author: "nisha-k",
    closed: "closed",
    skipped: 0,
    rounds: [
      {
        n: 1,
        sha: "9e8d7c6",
        state: "discarded",
        at: ago(9 * 1440),
        summary: "Experiment branch; you discarded the review.",
        findings: [mini("F1", "nit", "src/theme.ts", 4, "Hard-coded colors")],
        costUsd: 0.18,
        minutes: 1.1,
      },
    ],
  },
];

// ---------------------------------------------------------------- shared helpers

interface Ctx {
  params: URLSearchParams;
  path: string;
}
function link(ctx: Ctx, path: string, set: Record<string, string | number | null> = {}): string {
  const p = new URLSearchParams(ctx.params);
  p.delete("flash");
  for (const [k, v] of Object.entries(set)) {
    if (v == null) p.delete(k);
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}
function pick<T extends string>(ctx: Ctx, key: string, allowed: readonly T[], def: T): T {
  const v = ctx.params.get(key) as T | null;
  return v && allowed.includes(v) ? v : def;
}

/** The picked layout is the default when no ?v= is given. */
const isPicked = (ctx: Ctx) => (ctx.params.get("v") ?? "P") === "P";
const latest = (pr: PR) => pr.rounds[pr.rounds.length - 1] as Round;
const updated = (pr: PR) => latest(pr).at;
const totalCost = (pr: PR) => pr.rounds.reduce((s, r) => s + r.costUsd, 0);
const ref = (pr: PR) => `${pr.repo.split("/")[1]}#${pr.number}`;
const prPath = (pr: PR) => `/pr/${pr.repo}/${pr.number}`;
const roundHref = (ctx: Ctx, pr: PR, n?: number) => link(ctx, prPath(pr), { round: n ?? null, sel: null, f: null });

const STATE: Record<RState, [string, string]> = {
  held: ["Needs your OK", "pending"],
  changes: ["Requested changes", "change"],
  approved: ["Approved", "ok"],
  commented: ["Commented", "comment"],
  reviewing: ["Reviewing…", "work"],
  queued: ["Queued", "quiet"],
  failed: ["Failed", "change"],
  discarded: ["Discarded", "quiet"],
};
const SEV: Record<Sev, [string, string]> = { bug: ["🔴 bug", "change"], risk: ["🟡 risk", "work"], question: ["❓ question", "comment"], nit: ["🔵 nit", "quiet"] };
const VERDICT: Record<Verdict, [string, string]> = {
  fixed: ["fixed", "ok"],
  explained: ["explained", "comment"],
  no_longer_applies: ["no longer applies", "quiet"],
  partly_fixed: ["partly fixed", "work"],
  not_fixed: ["not fixed", "change"],
};
const chip = (r: Round) => html`<span class="chip ${STATE[r.state][1]}">${STATE[r.state][0]}</span>`;
const sevChip = (s: Sev) => html`<span class="chip ${SEV[s][1]}">${SEV[s][0]}</span>`;
function verdictChip(p: Prev) {
  let [label, cls] = VERDICT[p.verdict];
  // Nits and questions never block: left alone they are only optional.
  if ((p.severity === "nit" || p.severity === "question") && (p.verdict === "not_fixed" || p.verdict === "partly_fixed")) {
    label += " · optional";
    cls = "quiet";
  }
  return html`<span class="chip ${cls}">${label}</span>`;
}

type Group = "needs" | "progress" | "author" | "done";
function group(pr: PR): Group {
  const s = latest(pr).state;
  if (s === "held" || s === "failed") return "needs";
  if (s === "reviewing" || s === "queued") return "progress";
  if ((s === "changes" || s === "commented") && !pr.closed) return "author";
  return "done";
}
const GROUP_LABEL: Record<Group, string> = { needs: "Needs you", progress: "Claude is on it", author: "Waiting on the author", done: "Done" };

const kept = (r: Round) => r.findings.filter((f) => !f.dropped).length;
const stillOpen = (r: Round) => (r.previous ?? []).filter((p) => p.verdict === "not_fixed" || p.verdict === "partly_fixed").length;
function roundText(r: Round): string {
  const [label] = STATE[r.state];
  if (r.state === "reviewing" || r.state === "queued") return label;
  if (r.state === "failed") return `${label}: ${r.error ?? ""}`;
  const k = kept(r);
  const dropped = r.findings.length - k;
  let s = `${label} · ${k} ${r.n > 1 ? "new" : k === 1 ? "finding" : "findings"}`;
  if (r.previous) s += ` · ${stillOpen(r)} still open`;
  if (dropped) s += ` · ${dropped} dropped`;
  return s;
}
function countdown(r: Round) {
  if (r.state !== "held") return "";
  if (!r.holdUntil) return html`<span class="muted">No timer: waits for you</span>`;
  return html`<span class="countdown" data-until="${r.holdUntil.toISOString()}">Posts as it is at ${clock(r.holdUntil)}</span>`;
}
function subLine(r: Round) {
  if (r.state === "held") return countdown(r);
  if (r.state === "failed") return html`<span class="muted">${r.error}</span>`;
  if (r.state === "reviewing") return html`<span class="muted">started ${rel(r.at)}</span>`;
  return "";
}
function metaBits(pr: PR, ctx: Ctx): string[] {
  const fields = pick(ctx, "fields", ["min", "std", "full"] as const, "std");
  if (fields === "min") return [];
  const bits = [`${pr.repo}#${pr.number}`];
  if (fields === "full") {
    bits.push(`by ${pr.author}`);
    if (pr.ticket) bits.push(pr.ticket);
    bits.push(`$${totalCost(pr).toFixed(2)} total`);
    if (pr.closed) bits.push(pr.closed);
  }
  return bits;
}
const showNums = (ctx: Ctx) => pick(ctx, "fields", ["min", "std", "full"] as const, "std") !== "min";
const skippedLine = (pr: PR) =>
  pr.skipped ? html`<li class="skipped">${pr.skipped} older ${pr.skipped === 1 ? "commit" : "commits"} skipped</li>` : "";
function roundsList(pr: PR, ctx: Ctx) {
  return html`${skippedLine(pr)}${pr.rounds.map(
    (r) => html`<li><a href="${roundHref(ctx, pr, r.n)}"><b>R${r.n}</b> · ${roundText(r)}</a>
      <span class="muted"> · <span class="ref">${r.sha}</span> · ${rel(r.at)}${r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ""}</span></li>`,
  )}`;
}

/** A button is a form post to the stub, which redirects back. */
function act(ctx: Ctx, label: string, action: string, cls = "", note = "") {
  return html`<form method="post" action="/stub" class="inline"><input type="hidden" name="token" value="per-start-token">
<input type="hidden" name="action" value="${action}"><input type="hidden" name="back" value="${link(ctx, ctx.path)}">
<button class="${cls}" title="${note}">${label}</button></form>`;
}

// ---------------------------------------------------------------- header and pickers (open question 3)

const PICKERS = ["header", "list", "popover", "settings"] as const;
function pickerSelects(ctx: Ctx) {
  const sel = (name: string, label: string, options: string[], value: string, note: string) =>
    html`<label title="${note}">${label} <select name="${name}" data-autosubmit>${options.map(
      (o) => html`<option ${o === value ? raw("selected") : ""}>${o}</option>`,
    )}</select></label>`;
  return html`<form method="post" action="/stub" class="picks"><input type="hidden" name="action" value="settings">
<input type="hidden" name="back" value="${link(ctx, ctx.path)}">
${sel("model", "Model", ["Opus 5.5", "Sonnet 5.5"], "Opus 5.5", "Model for the next review.")}
${sel("effort", "Effort", ["Low", "Medium", "High"], "High", "Effort for the next review.")}
${sel("style", "Style", ["Readable", "Classic"], "Readable", "How findings are written.")}
${sel("hold", "Wait for OK", ["Off", "15 min", "30 min", "1 h", "2 h"], "30 min", "How long Request changes waits for your OK.")}</form>`;
}
function header(ctx: Ctx, page: "list" | "review" | "settings") {
  const where = pick(ctx, "pickers", PICKERS, isPicked(ctx) ? "popover" : "header");
  let picks: Raw | string = "";
  if (where === "header" || (where === "list" && page === "list")) picks = pickerSelects(ctx);
  if (where === "popover")
    picks = html`<details class="pop"><summary>Next review: <b>Opus 5.5 · High · Readable · wait 30 min</b></summary><div class="pop-body">${pickerSelects(ctx)}</div></details>`;
  if (where === "settings") picks = html`<a class="btnlink" href="${link(ctx, "/settings")}">⚙ Settings</a>`;
  return html`<header class="top">
  <a class="brand" href="${link(ctx, "/", { round: null, f: null })}">Proxy Reviewer</a>
  <span class="facts"><span class="dot"></span>Running as parth469 · last poll ${clock(ago(0.4))} · posting on · session 41%</span>
  ${picks}
  ${act(ctx, "Pause posting", "pause")}
</header>`;
}

// ---------------------------------------------------------------- list page: filter (open question 2)

const FILTERS = ["tabs", "fold", "none"] as const;
function filtered(ctx: Ctx): { shown: PR[]; older: PR[]; tabs: Raw | string } {
  const all = [...PRS].sort((a, b) => updated(b).getTime() - updated(a).getTime());
  const filter = isPicked(ctx) ? "tabs" : pick(ctx, "filter", FILTERS, "tabs");
  const isOld = (pr: PR) => !!pr.closed || (group(pr) === "done" && NOW - updated(pr).getTime() > 7 * 86_400_000);
  if (filter === "none") return { shown: all, older: [], tabs: "" };
  if (filter === "fold") return { shown: all.filter((p) => !isOld(p)), older: all.filter(isOld), tabs: "" };
  const show = pick(ctx, "show", ["needs", "open", "all"] as const, isPicked(ctx) ? "needs" : "open");
  const sets = { needs: all.filter((p) => group(p) === "needs"), open: all.filter((p) => !p.closed), all };
  const tab = (key: keyof typeof sets, label: string) =>
    html`<a class="tab ${show === key ? "on" : ""}" href="${link(ctx, "/", { show: key, sel: null })}">${label} <span class="count">${sets[key].length}</span></a>`;
  return {
    shown: sets[show],
    older: [],
    tabs: html`<nav class="tabs">${tab("needs", "Needs you")}${tab("open", "Open")}${tab("all", "All")}<span class="muted tabnote">Merged and closed PRs leave “Open”; “All” keeps 30 days.</span></nav>`,
  };
}

// ---------------------------------------------------------------- list variants

/** A: the issue's proposal. Needs-your-OK group on top, one row per PR, expand to see rounds. */
function listA(prs: PR[], ctx: Ctx) {
  const row = (pr: PR) => html`<details class="a-row ${group(pr) === "needs" ? "hot" : ""}"><summary>
  <span class="a-state">${chip(latest(pr))}<span class="sub">${subLine(latest(pr))}</span></span>
  <span class="a-main"><a class="a-title" href="${roundHref(ctx, pr)}">${pr.title}</a><span class="muted small">${metaBits(pr, ctx).join(" · ")}</span></span>
  ${showNums(ctx) ? html`<span class="num">${pr.rounds.length} ${pr.rounds.length === 1 ? "round" : "rounds"}</span><span class="num">${rel(updated(pr))}</span>` : ""}
  <span class="caret" aria-hidden="true">▸</span></summary>
  <ul class="rounds">${roundsList(pr, ctx)}</ul></details>`;
  const needs = prs.filter((p) => group(p) === "needs");
  const rest = prs.filter((p) => group(p) !== "needs");
  return html`${needs.length ? html`<h2 class="group">Needs your OK <span class="count">${needs.length}</span></h2><div class="card">${needs.map(row)}</div>` : ""}
  ${rest.length ? html`<h2 class="group">Everything else</h2><div class="card">${rest.map(row)}</div>` : ""}`;
}

/** B: inbox cards. What waits on you is a big card with the summary and buttons; the rest is compact. */
function stepper(pr: PR, ctx: Ctx) {
  return html`<ol class="steps">${pr.skipped ? html`<li class="skip" title="${pr.skipped} older commits skipped">+${pr.skipped}</li>` : ""}${pr.rounds.map(
    (r) => html`<li><a class="chip ${STATE[r.state][1]}" href="${roundHref(ctx, pr, r.n)}" title="${roundText(r)}">R${r.n} · ${STATE[r.state][0]}</a></li>`,
  )}</ol>`;
}
function listB(prs: PR[], ctx: Ctx) {
  const needs = prs.filter((p) => group(p) === "needs");
  const rest = prs.filter((p) => group(p) !== "needs");
  const big = (pr: PR) => {
    const r = latest(pr);
    return html`<article class="b-card hot">
    <div class="b-top">${chip(r)} <span class="sub">${subLine(r)}</span></div>
    <h3><a href="${roundHref(ctx, pr)}">${pr.title}</a></h3>
    <div class="muted small">${metaBits(pr, ctx).join(" · ")}</div>
    ${r.summary ? html`<p class="b-sum">${rich(r.summary)}</p>` : ""}
    ${r.findings.length ? html`<p class="small">${r.findings.map((f) => html`${sevChip(f.severity)} `)}${roundText(r)}</p>` : ""}
    ${stepper(pr, ctx)}
    <div class="row-actions">
      <a class="btnlink primary" href="${roundHref(ctx, pr)}">Read the review →</a>
      ${r.state === "held" ? html`${act(ctx, `Post ${kept(r)} as is`, "post")}${r.holdUntil ? act(ctx, "I'll handle it", "handle") : ""}${act(ctx, "Discard", "discard", "danger")}` : act(ctx, "Retry", "retry")}
    </div></article>`;
  };
  const small = (pr: PR) => html`<article class="b-card">
    <div class="b-line"><a class="b-title" href="${roundHref(ctx, pr)}">${pr.title}</a>${chip(latest(pr))}</div>
    <div class="b-line"><span class="muted small">${[...metaBits(pr, ctx), rel(updated(pr))].join(" · ")}</span>${stepper(pr, ctx)}</div></article>`;
  return html`${needs.length ? html`<h2 class="group">Waiting on you</h2><div class="b-big">${needs.map(big)}</div>` : ""}
  ${rest.length ? html`<h2 class="group">Everything else</h2><div class="b-list">${rest.map(small)}</div>` : ""}`;
}

/** C: board. Columns by who the PR waits on. */
function listC(prs: PR[], ctx: Ctx) {
  const card = (pr: PR) => html`<article class="c-card ${group(pr) === "needs" ? "hot" : ""}">
    <a class="c-title" href="${roundHref(ctx, pr)}">${pr.title}</a>
    <div class="muted small">${metaBits(pr, ctx).join(" · ")}</div>
    <div>${chip(latest(pr))}</div><div class="sub">${subLine(latest(pr))}</div>
    <div class="pills">${pr.skipped ? html`<span class="skip">+${pr.skipped}</span>` : ""}${pr.rounds.map(
      (r) => html`<a class="pill ${STATE[r.state][1]}" href="${roundHref(ctx, pr, r.n)}" title="${roundText(r)}">R${r.n}</a>`,
    )}${showNums(ctx) ? html`<span class="muted small">· ${rel(updated(pr))}</span>` : ""}</div></article>`;
  const cols: Group[] = ["needs", "progress", "author", "done"];
  return html`<div class="board">${cols.map((g) => {
    const items = prs.filter((p) => group(p) === g);
    return html`<section class="col"><h2 class="group">${GROUP_LABEL[g]} <span class="count">${items.length}</span></h2>${items.length ? items.map(card) : html`<p class="muted small">Nothing here.</p>`}</section>`;
  })}</div>`;
}

/** D: split view. List left, picked PR's rounds and latest review preview right. */
function listD(prs: PR[], ctx: Ctx) {
  const selKey = ctx.params.get("sel");
  const needsFirst = [...prs.filter((p) => group(p) === "needs"), ...prs.filter((p) => group(p) !== "needs")];
  const sel = needsFirst.find((p) => `${p.repo}#${p.number}` === selKey) ?? needsFirst[0];
  const item = (pr: PR) => html`<a class="d-item ${pr === sel ? "on" : ""} ${group(pr) === "needs" ? "hot" : ""}" href="${link(ctx, "/", { sel: `${pr.repo}#${pr.number}` })}">
    <span class="d-l1">${chip(latest(pr))}${showNums(ctx) ? html`<span class="muted small">${rel(updated(pr))}</span>` : ""}</span>
    <span class="d-title">${pr.title}</span><span class="muted small">${[...metaBits(pr, ctx), `R${pr.rounds.length}`].join(" · ")}</span></a>`;
  let right: Raw | string = html`<p class="muted">Nothing to show.</p>`;
  if (sel) {
    const r = latest(sel);
    right = html`<h2 class="d-h">${sel.title}</h2>
    <p class="muted small">${sel.repo}#${sel.number} · by ${sel.author}${sel.ticket ? ` · ${sel.ticket}` : ""} · $${totalCost(sel).toFixed(2)} across ${sel.rounds.length} ${sel.rounds.length === 1 ? "round" : "rounds"}</p>
    <ul class="rounds">${roundsList(sel, ctx)}</ul>
    <h3 class="sect">Latest · R${r.n} ${chip(r)} <span class="sub">${subLine(r)}</span></h3>
    ${r.summary ? html`<p>${rich(r.summary)}</p>` : ""}
    <ul class="d-findings">${r.findings.map((f) => html`<li class="${f.dropped ? "dropped" : ""}">${sevChip(f.severity)} <span class="ref">${f.path}:${f.line}</span> ${f.title}</li>`)}</ul>
    <div class="row-actions"><a class="btnlink primary" href="${roundHref(ctx, sel)}">Open the full review →</a>
    ${r.state === "held" ? html`${act(ctx, `Post ${kept(r)}`, "post")}${r.holdUntil ? act(ctx, "I'll handle it", "handle") : ""}${act(ctx, "Discard", "discard", "danger")}` : ""}</div>`;
  }
  return html`<div class="split"><nav class="card d-list">${needsFirst.map(item)}</nav><section class="card d-detail">${right}</section></div>`;
}

/** E: activity feed. A pinned strip of what waits on you, then every round as an event, by day. */
function listE(prs: PR[], ctx: Ctx) {
  const needs = prs.filter((p) => group(p) === "needs");
  const events = prs.flatMap((pr) => pr.rounds.map((r) => ({ pr, r }))).sort((a, b) => b.r.at.getTime() - a.r.at.getTime());
  const days = new Map<string, typeof events>();
  for (const e of events) days.set(dayOf(e.r.at), [...(days.get(dayOf(e.r.at)) ?? []), e]);
  return html`${needs.length ? html`<div class="e-pin"><b>Waiting on you</b>${needs.map(
    (pr) => html`<a class="e-pinitem" href="${roundHref(ctx, pr)}">${chip(latest(pr))} ${ref(pr)} <span class="sub">${subLine(latest(pr))}</span></a>`,
  )}</div>` : ""}
  ${[...days].map(
    ([day, es]) => html`<h2 class="group">${day}</h2><ol class="card e-feed">${es.map(
      ({ pr, r }) => html`<li class="${r.state === "held" || r.state === "failed" ? "hot" : ""}"><span class="num">${clock(r.at)}</span>
      <span>${chip(r)}</span>
      <span><a href="${roundHref(ctx, pr, r.n)}"><b>R${r.n}</b> of ${pr.title}</a><span class="muted small"> · ${[...metaBits(pr, ctx)].join(" · ")}</span><br>
      <span class="muted small">${roundText(r)}${r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ""}${r.n === 1 && pr.skipped ? ` · ${pr.skipped} older commits skipped` : ""}</span></span></li>`,
    )}</ol>`,
  )}`;
}

/** F: dense lines. One line per PR, rounds as inline pills, no expanding. */
function listF(prs: PR[], ctx: Ctx) {
  const ordered = [...prs.filter((p) => group(p) === "needs"), ...prs.filter((p) => group(p) !== "needs")];
  return html`<div class="card f-list">${ordered.map(
    (pr) => html`<div class="f-line ${group(pr) === "needs" ? "hot" : ""}">
    <span class="f-dot ${STATE[latest(pr).state][1]}" title="${STATE[latest(pr).state][0]}"></span>
    <a class="f-ref ref" href="${roundHref(ctx, pr)}">${ref(pr)}</a>
    <a class="f-title" href="${roundHref(ctx, pr)}" title="${pr.title}">${pr.title}</a>
    <span class="f-pills">${pr.skipped ? html`<span class="skip" title="${pr.skipped} older commits skipped">··${pr.skipped}</span>` : ""}${pr.rounds.map(
      (r) => html`<a class="pill ${STATE[r.state][1]}" href="${roundHref(ctx, pr, r.n)}" title="${roundText(r)}">R${r.n}</a>`,
    )}</span>
    <span class="f-state">${STATE[latest(pr).state][0]} <span class="sub">${subLine(latest(pr))}</span></span>
    ${showNums(ctx) ? html`<span class="num">${rel(updated(pr))}</span>` : ""}
    ${metaBits(pr, ctx).length > 1 ? html`<span class="num">${pr.author} · $${totalCost(pr).toFixed(2)}</span>` : ""}
  </div>`,
  )}</div>`;
}

/** P: the picks. Each tab has its own layout and row fields: Needs you → A (full, big timer), Open → C (min), All → F (min). */
function listP(prs: PR[], ctx: Ctx) {
  const show = pick(ctx, "show", ["needs", "open", "all"] as const, "needs");
  const params = new URLSearchParams(ctx.params);
  params.set("fields", show === "needs" ? "full" : "min");
  const c: Ctx = { params, path: ctx.path };
  if (show === "needs") return html`<div class="picked-needs">${listA(prs, c)}</div>`;
  return show === "open" ? listC(prs, c) : listF(prs, c);
}

const LIST_VARIANTS = {
  P: ["Your picks", "Needs you → A with full rows and a big timer · Open → C board · All → F lines · popover pickers.", listP],
  A: ["Grouped rows (the issue's proposal)", "Needs your OK on top, one row per PR, click to expand its rounds.", listA],
  B: ["Inbox cards", "What waits on you is a big card with summary and buttons; the rest compact, rounds as a stepper.", listB],
  C: ["Board", "Columns by who the PR waits on: you, Claude, the author, nobody.", listC],
  D: ["Split view", "List on the left; the picked PR's rounds and latest review preview on the right.", listD],
  E: ["Activity feed", "Pinned strip of what waits on you, then every round as an event by day. Breaks one-row-per-PR.", listE],
  F: ["Dense lines", "One line per PR, rounds as clickable pills inline. Nothing to expand.", listF],
} as const;
type ListKey = keyof typeof LIST_VARIANTS;

function listPage(ctx: Ctx): Raw {
  const v = pick(ctx, "v", Object.keys(LIST_VARIANTS) as ListKey[], "P");
  const [, , render] = LIST_VARIANTS[v];
  const { shown, older, tabs } = filtered(ctx);
  return html`${header(ctx, "list")}<main class="wrap">${tabs}${shown.length ? render(shown, ctx) : html`<p class="muted empty">Nothing waits on you.</p>`}
  ${older.length ? html`<details class="older"><summary>${older.length} finished or closed ${older.length === 1 ? "PR" : "PRs"} older than 7 days</summary>${render(older, ctx)}</details>` : ""}</main>`;
}

// ---------------------------------------------------------------- review page shared parts

/** brief: only what's wrong and what happens if not fixed (the fix and the reasoning are for the author). */
function findingCard(f: Finding, ctx: Ctx, held: boolean, brief = false) {
  return html`<article class="finding ${f.dropped ? "dropped" : ""}" id="${f.id}">
  <div class="fhead"><span class="fid">${f.id}</span>${sevChip(f.severity)}<span class="ref">${f.path}:${f.line}</span>${f.dropped ? html`<span class="chip quiet">dropped</span>` : ""}
  <span class="spacer"></span>${held ? act(ctx, f.dropped ? "Keep" : "Drop", `${f.dropped ? "keep" : "drop"} ${f.id}`, "small", f.dropped ? "Post this finding after all." : "Don't post this finding.") : ""}</div>
  <h3 class="ftitle">${rich(f.title)}</h3>
  <p><b>What's wrong:</b> ${rich(f.problem)}</p>
  <p><b>What happens if not fixed:</b> ${rich(f.impact)}</p>
  ${brief ? "" : html`<p><b>Fix:</b> ${rich(f.fix)}</p>
  ${f.suggestion ? html`<pre class="sugg">${f.suggestion}</pre>` : ""}
  <details><summary>Why I think so</summary><p class="muted">${rich(f.why)}</p></details>`}</article>`;
}
function prevTable(r: Round) {
  if (!r.previous) return "";
  return html`<h3 class="sect">Earlier findings · checked again in R${r.n}</h3><div class="scroll"><table class="prev">
  <thead><tr><th></th><th>Finding</th><th>Verdict</th><th>Reply</th></tr></thead>
  <tbody>${r.previous.map(
    (p) => html`<tr><td class="fid">${p.id}</td><td>${sevChip(p.severity)} ${rich(p.title)}<br><span class="ref muted">${p.path}:${p.line}</span></td><td>${verdictChip(p)}</td><td>${rich(p.reply)}</td></tr>`,
  )}</tbody></table></div>`;
}
function reviewHead(pr: PR, r: Round, ctx: Ctx) {
  return html`<a class="back" href="${link(ctx, "/", { round: null, f: null })}">← All PRs</a>
  <h1 class="rtitle">${pr.title}</h1>
  <p class="muted small">${pr.repo}#${pr.number} · by ${pr.author}${pr.ticket ? html` · ticket <a href="#">${pr.ticket} ↗</a>` : ""} · commit <span class="ref">${r.sha}</span>${r.costUsd ? ` · ${r.minutes} min · $${r.costUsd.toFixed(2)}` : ""} · <a href="#">PR on GitHub ↗</a></p>`;
}
function roundTabs(pr: PR, r: Round, ctx: Ctx) {
  return html`<nav class="tabs rtabs">${pr.rounds.map(
    (x) => html`<a class="tab ${x === r ? "on" : ""}" href="${link(ctx, prPath(pr), { round: x.n, f: null })}">R${x.n} <span class="chip ${STATE[x.state][1]}">${STATE[x.state][0]}</span></a>`,
  )}${pr.skipped ? html`<span class="muted small tabnote">${pr.skipped} older ${pr.skipped === 1 ? "commit" : "commits"} skipped</span>` : ""}</nav>`;
}
function actions(pr: PR, r: Round, ctx: Ctx) {
  if (r !== latest(pr)) return html`<span class="muted">R${r.n} of ${pr.rounds.length}: read only.</span> <a href="${link(ctx, prPath(pr), { round: null })}">Go to the latest round →</a>`;
  const k = kept(r);
  const dropped = r.findings.length - k;
  switch (r.state) {
    case "held":
      return html`${act(ctx, `Post ${k} ${k === 1 ? "finding" : "findings"}`, "post", "primary", "Post now, without the findings you dropped.")}
      ${r.holdUntil ? act(ctx, "I'll handle it", "handle", "", "Stop the timer. It waits until you press Post or Discard.") : ""}
      ${act(ctx, "Discard", "discard", "danger", "Post nothing for this commit.")}${act(ctx, "Re-review", "rereview")}
      <span class="spacer"></span><span class="small">${dropped ? `${dropped} dropped · ` : ""}${countdown(r)}</span>`;
    case "failed":
      return html`${act(ctx, "Retry", "retry", "primary")}<span class="muted small">${r.error}</span>`;
    case "reviewing":
      return html`${act(ctx, "Stop", "stop", "danger")}<span class="muted small">Claude is reviewing, started ${rel(r.at)}.</span>`;
    case "queued":
      return html`<span class="muted small">Queued. Starts within a minute.</span>`;
    case "changes":
    case "commented":
      return html`${act(ctx, "Approve", "approve", "primary", "Approve on GitHub as you.")}${act(ctx, "Re-review", "rereview")}`;
    default:
      return act(ctx, "Re-review", "rereview");
  }
}
function heldNote(r: Round) {
  return r.state === "held"
    ? html`<p class="note">This would request changes. Drop the findings you disagree with, then press Post. Untouched findings post as written.</p>`
    : "";
}
function emptyBody(r: Round) {
  if (r.state === "reviewing" || r.state === "queued") return html`<p class="muted">No review yet. This page reloads when it is ready.</p>`;
  if (r.state === "failed") return html`<p class="note">Error: ${r.error}</p>`;
  return "";
}
const sorted = (fs: Finding[]) => [...fs].sort((a, b) => ["bug", "risk", "question", "nit"].indexOf(a.severity) - ["bug", "risk", "question", "nit"].indexOf(b.severity));
const isHeldLatest = (pr: PR, r: Round) => r.state === "held" && r === latest(pr);

// ---------------------------------------------------------------- review variants

/** A: the issue's proposal. One readable column, tabs, sticky action bar on top. */
function reviewA(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  return html`<main class="doc">${reviewHead(pr, r, ctx)}${roundTabs(pr, r, ctx)}
  <div class="actionbar top">${actions(pr, r, ctx)}</div>
  ${emptyBody(r)}${r.summary ? html`<p class="lead">${rich(r.summary)}</p>` : ""}${heldNote(r)}
  ${prevTable(r)}
  ${r.findings.length ? html`<h3 class="sect">${r.previous ? "New since the last review" : "Findings"}</h3>${sorted(r.findings).map((f) => findingCard(f, ctx, held))}` : ""}</main>`;
}

/** B: outline of findings on the left, content on the right, action bar pinned to the bottom. */
function reviewB(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  return html`<div class="b-review"><aside class="outline">
    <a class="back" href="${link(ctx, "/", { round: null })}">← All PRs</a>
    <h4>Rounds</h4>${pr.skipped ? html`<p class="muted small">${pr.skipped} older commits skipped</p>` : ""}
    <ul>${pr.rounds.map((x) => html`<li><a class="${x === r ? "on" : ""}" href="${link(ctx, prPath(pr), { round: x.n })}">R${x.n} · ${STATE[x.state][0]}</a></li>`)}</ul>
    ${r.previous ? html`<h4>Earlier</h4><ul>${r.previous.map((p) => html`<li><a href="#prev">${p.id} ${verdictChip(p)}</a></li>`)}</ul>` : ""}
    ${r.findings.length ? html`<h4>${r.previous ? "New" : "Findings"}</h4><ul>${sorted(r.findings).map(
      (f) => html`<li><a class="${f.dropped ? "struck" : ""}" href="#${f.id}"><span class="sevdot ${SEV[f.severity][1]}"></span>${f.id} ${f.title}</a></li>`,
    )}</ul>` : ""}
  </aside><main>
    <h1 class="rtitle">${pr.title}</h1>
    <p class="muted small">${pr.repo}#${pr.number} · by ${pr.author} · R${r.n} ${chip(r)} · commit <span class="ref">${r.sha}</span>${r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ""}</p>
    ${emptyBody(r)}${r.summary ? html`<p class="lead">${rich(r.summary)}</p>` : ""}${heldNote(r)}
    <div id="prev">${prevTable(r)}</div>
    ${sorted(r.findings).map((f) => findingCard(f, ctx, held))}
  </main></div><div class="actionbar bottom">${actions(pr, r, ctx)}</div>`;
}

/** C: grouped by file, like a code review. Earlier verdicts sit in the file they belong to. */
function reviewC(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  const files = new Map<string, { prev: Prev[]; now: Finding[] }>();
  const slot = (p: string) => files.get(p) ?? (files.set(p, { prev: [], now: [] }), files.get(p)!);
  for (const p of r.previous ?? []) slot(p.path).prev.push(p);
  for (const f of sorted(r.findings)) slot(f.path).now.push(f);
  return html`<main class="doc wide">${reviewHead(pr, r, ctx)}${roundTabs(pr, r, ctx)}
  <div class="actionbar top">${actions(pr, r, ctx)}</div>
  ${emptyBody(r)}${r.summary ? html`<p class="lead">${rich(r.summary)}</p>` : ""}${heldNote(r)}
  ${[...files].map(
    ([path, { prev, now }]) => html`<section class="file"><h3 class="filehead ref">${path} <span class="muted small">${now.length} new${prev.length ? ` · ${prev.length} earlier` : ""}</span></h3>
    ${prev.map((p) => html`<div class="c-prev"><span class="gutter">L${p.line}</span><span>${p.id} ${sevChip(p.severity)} ${p.title} → ${verdictChip(p)}<br><span class="muted small">${rich(p.reply)}</span></span></div>`)}
    ${now.map((f) => html`<div class="c-now"><span class="gutter">L${f.line}</span>${findingCard(f, ctx, held)}</div>`)}</section>`,
  )}</main>`;
}

/** D: all rounds on one page as a timeline, newest open; an action panel stays on the right. */
function reviewD(pr: PR, r: Round, ctx: Ctx) {
  const L = latest(pr);
  const held = isHeldLatest(pr, L);
  // Where each finding ended up, for the lineage line.
  const fate = new Map<string, string>();
  for (const x of pr.rounds) for (const p of x.previous ?? []) fate.set(p.id, `R${x.n} ${VERDICT[p.verdict][0]}`);
  const k = kept(L);
  return html`<div class="d-review"><main>${reviewHead(pr, L, ctx)}
  ${[...pr.rounds].reverse().map(
    (x) => html`<details class="t-round" ${x === L || x === r && ctx.params.has("round") ? raw("open") : ""} id="R${x.n}"><summary><span class="t-dot ${STATE[x.state][1]}"></span><b>R${x.n}</b> ${chip(x)} <span class="muted small">${roundText(x)} · <span class="ref">${x.sha}</span> · ${rel(x.at)}</span></summary>
    <div class="t-body">${emptyBody(x)}${x.summary ? html`<p class="lead">${rich(x.summary)}</p>` : ""}${x === L ? heldNote(x) : ""}${prevTable(x)}
    ${sorted(x.findings).map((f) => html`${fate.has(f.id) ? html`<p class="lineage small">R${x.n} raised → ${fate.get(f.id)}</p>` : ""}${findingCard(f, ctx, x === L && held, true)}`)}</div></details>`,
  )}
  ${pr.skipped ? html`<p class="muted small t-skip">${pr.skipped} older ${pr.skipped === 1 ? "commit" : "commits"} skipped</p>` : ""}</main>
  <aside class="panel"><div class="panel-in">
    <h4>R${L.n} ${chip(L)}</h4>
    ${L.state === "held" ? html`<p class="big">${k} to post${L.findings.length - k ? html` <span class="muted small">· ${L.findings.length - k} dropped</span>` : ""}</p><p>${countdown(L)}</p>` : ""}
    <div class="stack">${actions(pr, L, ctx)}</div>
    <h4>Jump to</h4><ul>${[...pr.rounds].reverse().map((x) => html`<li><a href="#R${x.n}">R${x.n} · ${STATE[x.state][0]}</a></li>`)}</ul>
  </div></aside></div>`;
}

/** E: triage. One finding per screen; J/K move, D drops or keeps, then Post. */
function reviewE(pr: PR, r: Round, ctx: Ctx) {
  if (!isHeldLatest(pr, r))
    return html`<div class="banner-proto">Triage only applies to a review waiting for your OK. Showing layout A here.</div>${reviewA(pr, r, ctx)}`;
  const fs = sorted(r.findings);
  const i = Math.min(Math.max(Number(ctx.params.get("f") ?? 0) || 0, 0), fs.length);
  const at = (n: number) => link(ctx, prPath(pr), { f: n });
  const done = i >= fs.length;
  const f = fs[i];
  return html`<main class="doc">${reviewHead(pr, r, ctx)}${roundTabs(pr, r, ctx)}
  <details class="e-sum"><summary>Summary and earlier findings</summary><p class="lead">${rich(r.summary)}</p>${prevTable(r)}</details>
  <nav class="dots">${fs.map((x, n) => html`<a class="tdot ${n === i ? "on" : ""} ${x.dropped ? "dropped" : ""} ${SEV[x.severity][1]}" href="${at(n)}" title="${x.id} ${x.title}">${x.id}</a>`)}<a class="tdot ${done ? "on" : ""}" href="${at(fs.length)}">Post</a></nav>
  ${done || !f
    ? html`<section class="triage done"><h2>Ready: ${kept(r)} to post, ${r.findings.length - kept(r)} dropped</h2>
      <ul>${fs.map((x) => html`<li class="${x.dropped ? "struck" : ""}">${sevChip(x.severity)} ${x.title}</li>`)}</ul>
      <div class="actionbar">${actions(pr, r, ctx)}</div></section>`
    : html`<section class="triage"><p class="muted small">${i + 1} of ${fs.length}</p>${findingCard(f, ctx, false)}
      <div class="triage-keys">
        <a class="btnlink" data-key="k" href="${at(Math.max(i - 1, 0))}">← Previous <kbd>K</kbd></a>
        <span data-key="d">${act(ctx, f.dropped ? "Keep" : "Drop", `${f.dropped ? "keep" : "drop"} ${f.id}`, f.dropped ? "primary" : "danger")}<kbd>D</kbd></span>
        <a class="btnlink primary" data-key="j" href="${at(i + 1)}">Next <kbd>J</kbd> →</a>
      </div><p class="small">${countdown(r)}</p></section>`}</main>`;
}

// ---------------------------------------------------------------- simple review variants (F–I)

function simpleHead(pr: PR, r: Round, ctx: Ctx) {
  return html`<a class="back" href="${link(ctx, "/", { round: null, f: null })}">← All PRs</a>
  <h1 class="rtitle">${pr.title}</h1>
  <p class="muted small">${ref(pr)} · ${pr.author} · <a href="#">open on GitHub ↗</a>${pr.rounds.length > 1
    ? html` · Round ${pr.rounds.map((x, i) => html`${i ? " " : ""}${x === r ? html`<b>${x.n}</b>` : html`<a href="${link(ctx, prPath(pr), { round: x.n })}">${x.n}</a>`}`)}`
    : ""}</p>`;
}
/** The state in one plain sentence. */
function statusSentence(pr: PR, r: Round) {
  const k = kept(r);
  const n = (x: number) => `${x} ${x === 1 ? "finding" : "findings"}`;
  if (r !== latest(pr)) return html`<p class="s-status">This is round ${r.n}, an older round. It is read only.</p>`;
  switch (r.state) {
    case "held":
      return html`<p class="s-status">Claude wants to <b>request changes</b> with ${n(k)}.<br>${r.holdUntil
        ? html`<span class="s-timer">⏱ <span class="countdown" data-until="${r.holdUntil.toISOString()}">Posts as it is at ${clock(r.holdUntil)}</span></span> unless you act.`
        : "It waits for you. No timer."}</p>`;
    case "changes":
      return html`<p class="s-status">Posted ${rel(r.at)}: <b>requested changes</b> with ${n(k)}. Waiting on the author.</p>`;
    case "commented":
      return html`<p class="s-status">Posted ${rel(r.at)}: <b>a comment</b> with ${n(k)}.</p>`;
    case "approved":
      return html`<p class="s-status">Posted ${rel(r.at)}: <b>approved</b>.</p>`;
    case "reviewing":
      return html`<p class="s-status">Claude is reviewing. Started ${rel(r.at)}.</p>`;
    case "queued":
      return html`<p class="s-status">Waiting in line. Starts within a minute.</p>`;
    case "failed":
      return html`<p class="s-status">The review <b>failed</b>: ${r.error}</p>`;
    default:
      return html`<p class="s-status">You discarded this review. Nothing was posted.</p>`;
  }
}
/** Earlier findings folded into one line; open it to see each. */
function earlierLine(r: Round) {
  if (!r.previous?.length) return "";
  const done = r.previous.filter((p) => p.verdict === "fixed" || p.verdict === "explained" || p.verdict === "no_longer_applies");
  const optional = (p: Prev) => p.severity === "nit" || p.severity === "question";
  const open = r.previous.filter((p) => !done.includes(p) && !optional(p));
  const skippable = r.previous.filter((p) => !done.includes(p) && optional(p));
  return html`<details class="s-earlier"><summary>From the last round: <b>${done.length} sorted</b>${open.length ? html`, <b class="s-open">${open.length} still open</b>` : ""}${skippable.length ? `, ${skippable.length} optional` : ""}</summary>
  <ul>${r.previous.map((p) => html`<li>${done.includes(p) ? "✓" : "✗"} ${rich(p.title)} <span class="muted small">· ${VERDICT[p.verdict][0]}${(p.severity === "nit" || p.severity === "question") && !done.includes(p) ? " (optional)" : ""}</span></li>`)}</ul></details>`;
}
const sevDot = (s: Sev) => html`<span class="sevdot ${SEV[s][1]}" title="${s}"></span>`;
function moreDetails(f: Finding) {
  return html`<div class="s-more"><p><b>What's wrong:</b> ${rich(f.problem)}</p><p><b>If not fixed:</b> ${rich(f.impact)}</p><p><b>Fix:</b> ${rich(f.fix)}</p>
  ${f.suggestion ? html`<pre class="sugg">${f.suggestion}</pre>` : ""}<p class="muted small"><b>Why Claude thinks so:</b> ${rich(f.why)}</p></div>`;
}
const simpleButtons = (pr: PR, r: Round, ctx: Ctx) => html`<div class="s-buttons">${actions(pr, r, ctx)}</div>`;

/** F: short list. One line per finding; click a line to read it. */
function reviewF(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  return html`<main class="doc narrow">${simpleHead(pr, r, ctx)}${statusSentence(pr, r)}${simpleButtons(pr, r, ctx)}
  ${r.summary ? html`<p>${rich(r.summary)}</p>` : ""}${earlierLine(r)}
  ${r.findings.length ? html`<h3 class="s-h">${r.previous ? "New findings" : "Findings"}</h3><div class="s-list">${sorted(r.findings).map(
    (f) => html`<details class="s-item ${f.dropped ? "dropped" : ""}"><summary>${sevDot(f.severity)}<span class="s-title">${rich(f.title)}</span>
      <span class="muted small ref">${f.path.split("/").pop()}:${f.line}</span>${held ? act(ctx, f.dropped ? "Keep" : "Drop", `${f.dropped ? "keep" : "drop"} ${f.id}`, "small") : ""}</summary>${moreDetails(f)}</details>`,
  )}</div>` : ""}</main>`;
}

/** G: checklist. Untick what you don't want posted, then press one button. */
function reviewG(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  if (!held) return html`<div class="banner-proto">The checklist only applies to a review waiting for your OK. Showing layout F here.</div>${reviewF(pr, r, ctx)}`;
  return html`<main class="doc narrow">${simpleHead(pr, r, ctx)}${statusSentence(pr, r)}
  ${r.summary ? html`<p>${rich(r.summary)}</p>` : ""}${earlierLine(r)}
  <form method="post" action="/stub" class="s-check"><input type="hidden" name="back" value="${link(ctx, ctx.path)}">
    <h3 class="s-h">Post these to the author</h3>
    ${sorted(r.findings).map(
      (f) => html`<div class="s-row"><label><input type="checkbox" name="keep" value="${f.id}" ${f.dropped ? "" : raw("checked")}>
      ${sevDot(f.severity)}<span><b>${rich(f.title)}</b><br><span class="muted small">Fix: ${rich(f.fix)}</span></span></label>
      <details><summary>More</summary>${moreDetails(f)}</details></div>`,
    )}
    <div class="s-buttons"><button class="primary" name="action" value="post ticked">Post the ticked ones</button>
    ${r.holdUntil ? html`<button name="action" value="handle">I'll handle it</button>` : ""}
    <button class="danger" name="action" value="discard">Post nothing</button></div>
  </form></main>`;
}

/** H: preview. Shows the review the way the author will see it on GitHub. */
function reviewH(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  const shown = sorted(r.findings).filter((f) => !f.dropped);
  const hidden = r.findings.length - shown.length;
  const verb = r.state === "approved" ? "approved these changes" : r.state === "commented" ? "commented" : "requested changes";
  return html`<main class="doc narrow">${simpleHead(pr, r, ctx)}${statusSentence(pr, r)}${simpleButtons(pr, r, ctx)}
  ${r.summary ? html`<h3 class="s-h">${held ? "What the author will see" : "What was posted"}</h3>
  <div class="gh"><div class="gh-head"><span class="avatar">P</span><b>parth469</b> ${verb}</div>
    <div class="gh-body"><p>${rich(r.summary)}</p>${r.previous ? html`<p class="muted small">${r.previous.length} earlier findings checked again.</p>` : ""}</div>
    ${shown.map(
      (f) => html`<div class="gh-inline"><div class="gh-file ref">${f.path} · line ${f.line}</div>
      <div class="gh-comment">${sevDot(f.severity)} <b>${rich(f.title)}</b><p>${rich(f.problem)}</p><p><b>Fix:</b> ${rich(f.fix)}</p>
      ${held ? html`<div class="gh-act">${act(ctx, "Don't post this", `drop ${f.id}`, "small")}</div>` : ""}</div></div>`,
    )}
  </div>` : emptyBody(r)}
  ${hidden ? html`<p class="muted small">${hidden} dropped ${hidden === 1 ? "finding is" : "findings are"} not shown. ${held ? act(ctx, "Show and post them again", "keep all", "small") : ""}</p>` : ""}
  ${earlierLine(r)}</main>`;
}

/** I: plain words. A numbered list, one short sentence per finding, nothing to open. */
function reviewI(pr: PR, r: Round, ctx: Ctx) {
  const held = isHeldLatest(pr, r);
  return html`<main class="doc narrow">${simpleHead(pr, r, ctx)}${statusSentence(pr, r)}${simpleButtons(pr, r, ctx)}
  ${r.summary ? html`<p>${rich(r.summary)}</p>` : emptyBody(r)}${earlierLine(r)}
  ${r.findings.length ? html`<ol class="s-plain">${sorted(r.findings).map(
    (f) => html`<li class="${f.dropped ? "dropped" : ""}"><span>${sevDot(f.severity)}<b>${rich(f.title)}.</b> ${rich(f.fix)}
    <span class="muted small ref">${f.path.split("/").pop()}:${f.line}</span></span>${held ? act(ctx, f.dropped ? "Keep" : "Drop", `${f.dropped ? "keep" : "drop"} ${f.id}`, "small") : ""}</li>`,
  )}</ol>` : ""}</main>`;
}

const REVIEW_VARIANTS = {
  A: ["Document (the issue's proposal)", "Round tabs, sticky action bar on top, everything in one readable column.", reviewA],
  B: ["Outline + content", "Sticky outline of rounds and findings on the left; action bar pinned to the bottom.", reviewB],
  C: ["By file", "Findings and earlier verdicts grouped under the file they're in, like a code review.", reviewC],
  D: ["Timeline + side panel (your pick)", "All rounds, newest open; each finding shows only what's wrong and what happens if not fixed.", reviewD],
  E: ["Triage, one at a time", "One finding per screen, J/K to move, D to drop or keep, then Post. Only for Needs your OK.", reviewE],
  F: ["Simple · short list", "Status in one sentence. One line per finding; click a line to read it.", reviewF],
  G: ["Simple · checklist", "Untick what you don't want posted, then press one button. Only for Needs your OK.", reviewG],
  H: ["Simple · author's view", "Shows the review the way the author will see it on GitHub.", reviewH],
  I: ["Simple · plain words", "Numbered list, one short sentence per finding. Nothing to open.", reviewI],
} as const;
type ReviewKey = keyof typeof REVIEW_VARIANTS;

function reviewPage(ctx: Ctx, pr: PR): Raw {
  const v = pick(ctx, "rv", Object.keys(REVIEW_VARIANTS) as ReviewKey[], "D");
  const n = Number(ctx.params.get("round"));
  const r = pr.rounds.find((x) => x.n === n) ?? latest(pr);
  return html`${header(ctx, "review")}${REVIEW_VARIANTS[v][2](pr, r, ctx)}`;
}

function settingsPage(ctx: Ctx): Raw {
  return html`${header(ctx, "settings")}<main class="doc"><a class="back" href="${link(ctx, "/")}">← All PRs</a><h1 class="rtitle">Settings</h1>
  <p class="muted">Used by the next review. A review already running keeps what it started with.</p>
  <div class="card settings">${pickerSelects(ctx)}</div></main>`;
}

// ---------------------------------------------------------------- prototype switcher bar

function switcher(ctx: Ctx, page: "list" | "review" | "settings"): Raw {
  if (page === "settings") return raw("");
  const isList = page === "list";
  const key = isList ? "v" : "rv";
  const variants: Record<string, readonly [string, string, unknown]> = isList ? LIST_VARIANTS : REVIEW_VARIANTS;
  const keys = Object.keys(variants);
  const cur = pick(ctx, key, keys, isList ? (keys[0] ?? "A") : "D");
  const idx = keys.indexOf(cur);
  const prev = keys[(idx - 1 + keys.length) % keys.length] ?? "A";
  const next = keys[(idx + 1) % keys.length] ?? "A";
  const [name, desc] = variants[cur] ?? ["", ""];
  const sel = (param: string, label: string, opts: readonly string[], def: string) =>
    html`<label>${label} <select data-param="${param}">${opts.map((o) => html`<option ${o === (ctx.params.get(param) ?? def) ? raw("selected") : ""}>${o}</option>`)}</select></label>`;
  return html`<div class="proto" role="region" aria-label="Prototype switcher">
  <div class="proto-desc">${desc}</div>
  <div class="proto-row">
    <a class="proto-arrow" data-proto="prev" href="${link(ctx, ctx.path, { [key]: prev })}" aria-label="Previous variant">◀</a>
    <span class="proto-label"><b>${isList ? "List" : "Review"} ${cur}</b> · ${name}</span>
    <a class="proto-arrow" data-proto="next" href="${link(ctx, ctx.path, { [key]: next })}" aria-label="Next variant">▶</a>
    <span class="proto-sep"></span>
    ${sel("pickers", "Pickers", PICKERS, isPicked(ctx) ? "popover" : "header")}
    ${isList && cur !== "P" ? html`${sel("filter", "Finished PRs", FILTERS, "tabs")}${sel("fields", "Row shows", ["min", "std", "full"], "std")}` : ""}
  </div></div>`;
}

// ---------------------------------------------------------------- page shell

const CSS = `
:root { color-scheme: light;
  --bg:#f4f6f8; --panel:#fff; --sunken:#eef1f4; --ink:#18202a; --muted:#5d6977; --line:#dce1e7; --accent:#2a5ea6; --accent-ink:#fff;
  --change:#b3261e; --change-bg:#fbe6e4; --comment:#36597f; --comment-bg:#e3ecf6; --pending:#6a3fa0; --pending-bg:#efe7f8;
  --work:#8a5a00; --work-bg:#fbf0d9; --ok:#2e7d4f; --ok-bg:#e2f2e8; --quiet:#5d6977; --quiet-bg:#eceff2;
  --sans: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; --mono: ui-monospace,"Cascadia Mono",Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark;
  --bg:#0e1217; --panel:#151b22; --sunken:#1b222b; --ink:#e2e8ee; --muted:#93a0ae; --line:#27303a; --accent:#7aa6e6; --accent-ink:#0e1217;
  --change:#f08a80; --change-bg:#3a1c1a; --comment:#9cc0e8; --comment-bg:#1b2a3b; --pending:#c5a6ee; --pending-bg:#2a2140;
  --work:#e8bf6a; --work-bg:#332812; --ok:#7fd1a0; --ok-bg:#16301f; --quiet:#93a0ae; --quiet-bg:#1f262e; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 var(--sans); padding:0 16px 140px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
button, .btnlink { font:inherit; cursor:pointer; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:6px; padding:4px 10px; display:inline-block; }
button:hover, .btnlink:hover { border-color:var(--accent); text-decoration:none; }
button.primary, .btnlink.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
button.danger { color:var(--change); border-color:var(--change); }
button.small { font-size:12px; padding:2px 8px; }
select { font:inherit; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:6px; padding:3px 6px; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
form.inline { display:inline; }
.muted { color:var(--muted); } .small { font-size:12.5px; } .ref, .num { font-family:var(--mono); font-size:12.5px; } .num { color:var(--muted); white-space:nowrap; }
.spacer { flex:1; }
code { font-family:var(--mono); font-size:12.5px; background:var(--sunken); border-radius:4px; padding:1px 4px; }
.chip { display:inline-block; font-size:12px; font-weight:600; padding:1px 8px; border-radius:999px; white-space:nowrap; }
.chip.change,.pill.change { color:var(--change); background:var(--change-bg); } .chip.comment,.pill.comment { color:var(--comment); background:var(--comment-bg); }
.chip.pending,.pill.pending { color:var(--pending); background:var(--pending-bg); } .chip.work,.pill.work { color:var(--work); background:var(--work-bg); }
.chip.ok,.pill.ok { color:var(--ok); background:var(--ok-bg); } .chip.quiet,.pill.quiet { color:var(--quiet); background:var(--quiet-bg); }
.pill { display:inline-block; font:600 11.5px var(--mono); padding:1px 6px; border-radius:4px; margin-right:3px; }
.skip { font:11.5px var(--mono); color:var(--muted); margin-right:4px; }
.sub { display:block; font-size:12px; color:var(--muted); }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.wrap { max-width:1280px; margin:0 auto; }
header.top { max-width:1280px; margin:0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px; padding:16px 0 12px; border-bottom:1px solid var(--line); margin-bottom:14px; }
.brand { font-weight:700; font-size:17px; color:var(--ink); }
.facts { color:var(--muted); font-size:13px; flex:1; min-width:240px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--ok); margin-right:6px; }
.picks { display:flex; flex-wrap:wrap; gap:8px; font-size:13px; color:var(--muted); align-items:center; }
.pop { position:relative; font-size:13px; } .pop summary { cursor:pointer; list-style:none; border:1px solid var(--line); border-radius:6px; padding:4px 10px; background:var(--panel); }
.pop-body { position:absolute; right:0; top:110%; z-index:5; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; width:min(320px, 90vw); box-shadow:0 8px 24px #0002; }
.pop-body .picks { flex-direction:column; align-items:stretch; } .pop-body label { display:flex; justify-content:space-between; }
.settings { padding:16px; } .settings .picks { flex-direction:column; align-items:flex-start; gap:12px; }
h2.group { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:18px 0 8px; }
.count { font-size:12px; color:var(--muted); background:var(--quiet-bg); border-radius:999px; padding:0 7px; margin-left:4px; }
.tabs { display:flex; flex-wrap:wrap; gap:4px; align-items:center; border-bottom:1px solid var(--line); margin-bottom:6px; }
.tab { padding:6px 12px; border-bottom:2px solid transparent; color:var(--muted); } .tab.on { color:var(--ink); border-color:var(--accent); font-weight:600; }
.tabnote { margin-left:auto; font-size:12px; }
.older { margin-top:22px; } .older > summary { cursor:pointer; color:var(--muted); }
.hot { box-shadow: inset 3px 0 0 var(--pending); }
ul.rounds { list-style:none; margin:0; padding:6px 12px 10px 40px; } ul.rounds li { padding:3px 0; } li.skipped { color:var(--muted); font-style:italic; font-size:12.5px; }
.empty { padding:24px; }

/* A */
.a-row { border-bottom:1px solid var(--line); } .a-row:last-child { border-bottom:0; }
.a-row summary { display:grid; grid-template-columns:200px minmax(0,1fr) auto auto 16px; gap:14px; align-items:center; padding:10px 12px; cursor:pointer; list-style:none; }
.a-row summary::-webkit-details-marker { display:none; } .a-row summary:hover { background:var(--sunken); }
.a-row[open] .caret { transform:rotate(90deg); } .caret { color:var(--muted); transition:transform .15s; }
.a-main { display:flex; flex-direction:column; min-width:0; } .a-title { color:var(--ink); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:720px){ .a-row summary { grid-template-columns:1fr 16px; } .a-row summary .num { display:none; } .a-state { grid-column:1; } }

/* P: the timer is the loudest thing on a Needs-you row */
.picked-needs .a-row summary { grid-template-columns:230px minmax(0,1fr) auto auto 16px; }
.picked-needs .countdown, .panel .countdown { display:inline-block; margin-top:6px; padding:3px 10px; border-radius:6px; font:700 13.5px var(--mono);
  color:var(--pending); background:var(--pending-bg); border:1px solid var(--pending); }
.picked-needs .countdown.urgent, .panel .countdown.urgent { color:var(--change); background:var(--change-bg); border-color:var(--change); }
/* B */
.b-big { display:grid; grid-template-columns:repeat(auto-fill, minmax(380px,1fr)); gap:14px; }
@media (max-width:480px){ .b-big { grid-template-columns:1fr; } }
.b-card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; }
.b-card.hot { border-color:var(--pending); box-shadow:none; } .b-card h3 { margin:8px 0 2px; font-size:16px; }
.b-top { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; } .b-top .sub { display:inline; }
.b-sum { margin:10px 0; }
.b-list { display:flex; flex-direction:column; gap:8px; }
.b-line { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
.b-title { color:var(--ink); font-weight:600; }
ol.steps { list-style:none; display:flex; flex-wrap:wrap; gap:4px; padding:0; margin:8px 0; } ol.steps li + li::before { content:"→"; color:var(--muted); margin-right:4px; }
ol.steps .skip { align-self:center; } ol.steps a.chip:hover { text-decoration:none; filter:brightness(.95); }
.row-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; align-items:center; }

/* C */
.board { display:grid; grid-template-columns:repeat(4, minmax(240px,1fr)); gap:12px; overflow-x:auto; }
.col { background:var(--sunken); border-radius:10px; padding:4px 10px 10px; min-width:240px; } .col h2.group { margin:10px 0; }
.c-card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:8px; display:flex; flex-direction:column; gap:4px; }
.c-card.hot { border-color:var(--pending); box-shadow:none; } .c-title { color:var(--ink); font-weight:600; } .pills { margin-top:4px; }

/* D */
.split { display:grid; grid-template-columns:minmax(260px,360px) minmax(0,1fr); gap:14px; align-items:start; }
@media (max-width:800px){ .split { grid-template-columns:1fr; } }
.d-list { display:flex; flex-direction:column; }
.d-item { display:flex; flex-direction:column; gap:2px; padding:10px 12px; border-bottom:1px solid var(--line); color:var(--ink); }
.d-item:hover { background:var(--sunken); text-decoration:none; } .d-item.on { background:var(--sunken); box-shadow:inset 3px 0 0 var(--accent); }
.d-l1 { display:flex; justify-content:space-between; } .d-title { font-weight:600; }
.d-detail { padding:16px 20px; position:sticky; top:12px; } .d-h { margin:0 0 4px; font-size:18px; } .d-detail ul.rounds { padding-left:0; }
.d-findings { list-style:none; padding:0; } .d-findings li { padding:3px 0; } .d-findings li.dropped { opacity:.5; text-decoration:line-through; }
h3.sect { font-size:13px; color:var(--muted); font-weight:600; margin:18px 0 8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; } h3.sect .sub { display:inline; }

/* E */
.e-pin { position:sticky; top:0; z-index:3; display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:10px 12px; background:var(--pending-bg); border-radius:10px; }
.e-pinitem { background:var(--panel); border-radius:8px; padding:4px 10px; color:var(--ink); } .e-pinitem .sub { display:inline; }
ol.e-feed { list-style:none; margin:0; padding:0; } .e-feed li { display:grid; grid-template-columns:52px 150px minmax(0,1fr); gap:10px; padding:10px 12px; border-bottom:1px solid var(--line); }
@media (max-width:640px){ .e-feed li { grid-template-columns:44px 1fr; } .e-feed li > span:nth-child(2) { grid-column:2; } }

/* F */
.f-line { display:grid; grid-template-columns:10px 130px minmax(0,1fr) auto 220px auto auto; gap:12px; align-items:center; padding:6px 12px; border-bottom:1px solid var(--line); font-size:13px; }
.f-line:last-child { border-bottom:0; } .f-line:hover { background:var(--sunken); }
.f-dot { width:9px; height:9px; border-radius:50%; } .f-dot.pending { background:var(--pending); } .f-dot.change { background:var(--change); } .f-dot.ok { background:var(--ok); }
.f-dot.work { background:var(--work); } .f-dot.comment { background:var(--comment); } .f-dot.quiet { background:var(--quiet); }
.f-title { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .f-state .sub { display:inline; margin-left:4px; }
@media (max-width:900px){ .f-line { grid-template-columns:10px minmax(0,1fr) auto; } .f-ref,.f-state,.f-line .num { display:none; } }

/* review shared */
.doc { max-width:860px; margin:0 auto; } .doc.wide { max-width:1040px; }
.back { display:inline-block; margin:4px 0 8px; font-size:13px; }
.rtitle { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }
.rtabs { margin-top:12px; } .rtabs .tab { display:flex; gap:6px; align-items:center; }
.actionbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px 12px; margin:12px 0; }
.actionbar.top { position:sticky; top:0; z-index:4; box-shadow:0 4px 12px #0001; }
.actionbar.bottom { position:sticky; bottom:72px; z-index:4; max-width:1280px; margin:12px auto; box-shadow:0 -4px 16px #0002; }
.lead { font-size:15.5px; margin:14px 0; }
.note { background:var(--pending-bg); color:var(--pending); padding:8px 12px; border-radius:8px; }
.finding { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin:10px 0; }
.finding.dropped > :not(.fhead) { opacity:.45; }
.fhead { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.fid { font:12px var(--mono); color:var(--muted); }
.ftitle { font-size:15px; margin:8px 0 4px; } .finding p { margin:6px 0; overflow-wrap:anywhere; }
.finding summary { cursor:pointer; color:var(--muted); font-size:13px; }
.sugg { background:var(--sunken); border-radius:6px; padding:10px; font:12.5px var(--mono); overflow-x:auto; }
.scroll { overflow-x:auto; }
table.prev { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; min-width:560px; }
table.prev th { text-align:left; font-size:12px; color:var(--muted); background:var(--sunken); padding:6px 10px; }
table.prev td { padding:8px 10px; border-top:1px solid var(--line); vertical-align:top; }

/* review B */
.b-review { display:grid; grid-template-columns:260px minmax(0,1fr); gap:24px; max-width:1280px; margin:0 auto; }
@media (max-width:800px){ .b-review { grid-template-columns:1fr; } .outline { position:static !important; max-height:none !important; } }
.outline { position:sticky; top:12px; align-self:start; max-height:calc(100vh - 110px); overflow:auto; font-size:13px; }
.outline h4 { margin:14px 0 4px; font-size:12px; text-transform:uppercase; color:var(--muted); letter-spacing:.05em; }
.outline ul { list-style:none; padding:0; margin:0; } .outline li a { display:block; padding:3px 6px; border-radius:5px; color:var(--ink); }
.outline li a.on { background:var(--sunken); font-weight:600; } .struck { text-decoration:line-through; opacity:.6; }
.sevdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.sevdot.change { background:var(--change); } .sevdot.work { background:var(--work); } .sevdot.comment { background:var(--comment); } .sevdot.quiet { background:var(--quiet); }

/* review C */
.file { margin:18px 0; } .filehead { background:var(--sunken); padding:6px 12px; border-radius:8px 8px 0 0; margin:0; border:1px solid var(--line); }
.c-prev, .c-now { display:grid; grid-template-columns:56px minmax(0,1fr); border:1px solid var(--line); border-top:0; background:var(--panel); }
.c-prev { padding:8px 0; opacity:.85; } .c-now .finding { border:0; margin:0; border-radius:0; }
.gutter { font:12px var(--mono); color:var(--muted); text-align:right; padding:12px 10px 0 0; border-right:1px solid var(--line); }
.c-prev .gutter { padding-top:0; } .c-prev > span:last-child { padding:0 12px; }

/* review D */
.d-review { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:24px; max-width:1180px; margin:0 auto; }
@media (max-width:900px){ .d-review { grid-template-columns:1fr; } .panel { order:-1; } }
.t-round { border-left:2px solid var(--line); margin-left:6px; padding:0 0 12px 18px; position:relative; }
.t-round > summary { cursor:pointer; list-style:none; padding:8px 0; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.t-dot { position:absolute; left:-7px; top:14px; width:12px; height:12px; border-radius:50%; border:2px solid var(--bg); }
.t-dot.pending { background:var(--pending); } .t-dot.change { background:var(--change); } .t-dot.ok { background:var(--ok); } .t-dot.work { background:var(--work); } .t-dot.quiet,.t-dot.comment { background:var(--quiet); }
.t-skip { margin-left:26px; } .lineage { color:var(--muted); margin:14px 0 -6px; font-family:var(--mono); }
.panel { position:relative; } .panel-in { position:sticky; top:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
.panel h4 { margin:0 0 8px; display:flex; gap:8px; align-items:center; } .panel h4 + * { margin-top:0; }
.panel .stack { display:flex; flex-direction:column; gap:6px; } .panel .stack form button { width:100%; } .panel .stack .spacer, .panel .stack > span.small { display:none; }
.panel ul { padding-left:18px; } .big { font-size:22px; font-weight:700; margin:4px 0; }

/* review E */
.e-sum { margin:12px 0; } .e-sum > summary { cursor:pointer; color:var(--muted); }
.dots { display:flex; flex-wrap:wrap; gap:6px; margin:14px 0; }
.tdot { font:600 12px var(--mono); padding:4px 10px; border-radius:999px; border:1px solid var(--line); color:var(--ink); background:var(--panel); }
.tdot.on { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent); } .tdot.dropped { text-decoration:line-through; opacity:.55; }
.triage .finding { font-size:15.5px; padding:20px 24px; } .triage .ftitle { font-size:19px; }
.triage-keys { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
kbd { font:11px var(--mono); border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 5px; margin:0 3px; }
.triage.done ul { list-style:none; padding:0; } .triage.done li { padding:4px 0; }
.banner-proto { max-width:860px; margin:0 auto 8px; background:var(--work-bg); color:var(--work); padding:8px 12px; border-radius:8px; }

/* simple review layouts */
.doc.narrow { max-width:720px; }
.s-status { font-size:17px; line-height:1.6; margin:14px 0 10px; }
.s-timer { display:inline-block; font:700 15px var(--mono); color:var(--pending); background:var(--pending-bg); border-radius:6px; padding:1px 8px; }
.s-timer .countdown.urgent { color:var(--change); }
.s-buttons { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:10px 0 18px; } .s-buttons .spacer, .s-buttons > span.small { display:none; }
.s-h { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:22px 0 8px; }
.s-earlier { margin:12px 0; color:var(--muted); } .s-earlier summary { cursor:pointer; } .s-earlier b { color:var(--ink); } .s-earlier b.s-open { color:var(--change); }
.s-earlier ul { list-style:none; padding-left:14px; color:var(--ink); } .s-earlier li { padding:2px 0; }
.s-list { border-top:1px solid var(--line); }
.s-item { border-bottom:1px solid var(--line); } .s-item > summary { display:flex; gap:10px; align-items:center; padding:10px 4px; cursor:pointer; list-style:none; }
.s-item > summary::-webkit-details-marker { display:none; } .s-item > summary:hover { background:var(--sunken); }
.s-title { flex:1; } .s-item.dropped .s-title, .s-plain li.dropped > span { text-decoration:line-through; opacity:.5; }
.s-more { padding:0 4px 12px 22px; } .s-more p { margin:6px 0; }
.s-check .s-row { border-bottom:1px solid var(--line); padding:10px 0; } .s-check label { display:flex; gap:10px; align-items:flex-start; cursor:pointer; }
.s-check input[type=checkbox] { width:18px; height:18px; margin-top:2px; } .s-check .sevdot { margin-top:6px; }
.s-check details { margin-left:46px; } .s-check details summary { cursor:pointer; color:var(--muted); font-size:13px; }
.gh { border:1px solid var(--line); border-radius:8px; background:var(--panel); overflow:hidden; }
.gh-head { background:var(--sunken); padding:8px 12px; border-bottom:1px solid var(--line); display:flex; gap:8px; align-items:center; }
.avatar { width:22px; height:22px; border-radius:50%; background:var(--accent); color:var(--accent-ink); display:inline-grid; place-items:center; font-size:12px; font-weight:700; }
.gh-body { padding:4px 14px; } .gh-inline { margin:10px 14px; border:1px solid var(--line); border-radius:6px; }
.gh-file { background:var(--sunken); padding:4px 10px; border-bottom:1px solid var(--line); } .gh-comment { padding:8px 12px; } .gh-comment p { margin:4px 0; }
.gh-act { text-align:right; }
.s-plain { padding-left:22px; } .s-plain li { padding:8px 0; border-bottom:1px solid var(--line); }
.s-plain li > span { margin-right:8px; } .s-plain li form { float:right; }

/* prototype bar: deliberately not part of the design */
.proto { position:fixed; left:50%; bottom:12px; transform:translateX(-50%); z-index:50; background:#111; color:#fff; border-radius:14px;
  padding:8px 14px; box-shadow:0 10px 30px #0006; font-size:13px; width:max-content; max-width:calc(100vw - 24px); }
.proto a { color:#fff; } .proto select { background:#222; color:#fff; border-color:#444; font-size:12px; }
.proto-desc { color:#bbb; font-size:12px; margin-bottom:4px; text-align:center; }
.proto-row { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; justify-content:center; }
.proto-arrow { background:#333; border-radius:8px; padding:2px 10px; } .proto-sep { width:1px; height:18px; background:#444; }
.toast { position:fixed; right:16px; top:16px; background:var(--ink); color:var(--bg); padding:8px 14px; border-radius:8px; z-index:60; }
`;

const JS = `
document.querySelectorAll("[data-autosubmit]").forEach(s => s.addEventListener("change", () => s.form.submit()));
document.querySelectorAll(".proto select[data-param]").forEach(s => s.addEventListener("change", () => {
  const u = new URL(location.href); u.searchParams.set(s.dataset.param, s.value); u.searchParams.delete("flash"); location.href = u;
}));
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
document.addEventListener("keydown", e => {
  if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
  const go = sel => { const el = document.querySelector(sel); if (el) { e.preventDefault(); el.tagName === "A" ? el.click() : el.querySelector("button")?.click(); } };
  if (e.key === "ArrowLeft") go('[data-proto="prev"]');
  if (e.key === "ArrowRight") go('[data-proto="next"]');
  if (e.key === "j") go('[data-key="j"]');
  if (e.key === "k") go('[data-key="k"]');
  if (e.key === "d") go('[data-key="d"]');
});
function tick() {
  document.querySelectorAll(".countdown").forEach(el => {
    const until = new Date(el.dataset.until), left = Math.max(0, until - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    el.classList.toggle("urgent", left < 5 * 60000);
    el.textContent = (el.closest(".picked-needs, .panel") ? "⏱ " + m + ":" + String(s).padStart(2, "0") + " · posts at " : "Posts as it is in " + m + ":" + String(s).padStart(2, "0") + " · at ") + until.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  });
}
tick(); setInterval(tick, 1000);
const t = document.querySelector(".toast"); if (t) setTimeout(() => t.remove(), 3500);
`;

function shell(title: string, body: Raw, ctx: Ctx, page: "list" | "review" | "settings"): string {
  const flash = ctx.params.get("flash");
  return `<!doctype html>${show(html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="icon" href="data:,"><style>${raw(CSS)}</style></head>
<body>${body}${switcher(ctx, page)}${flash ? html`<div class="toast" role="status">${flash} (stub: nothing happened)</div>` : ""}<script>${raw(JS)}</script></body></html>`)}`;
}

// ---------------------------------------------------------------- server

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return new URLSearchParams(text);
}

const port = Number(process.env.PORT ?? 4778);
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const ctx: Ctx = { params: url.searchParams, path: url.pathname };
  const sendHtml = (status: number, body: string) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };
  if (req.method === "POST" && url.pathname === "/stub") {
    const form = await readForm(req);
    const back = form.get("back") ?? "/";
    const safe = back.startsWith("/") && !back.startsWith("//") ? back : "/";
    const to = new URL(safe, "http://localhost");
    to.searchParams.set("flash", `${form.get("action") ?? "?"}`);
    res.writeHead(303, { Location: to.pathname + to.search });
    res.end();
    return;
  }
  if (url.pathname === "/") return sendHtml(200, shell("Proxy Reviewer", listPage(ctx), ctx, "list"));
  if (url.pathname === "/settings") return sendHtml(200, shell("Settings · Proxy Reviewer", settingsPage(ctx), ctx, "settings"));
  const m = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)$/.exec(url.pathname);
  const pr = m && PRS.find((p) => p.repo === `${m[1]}/${m[2]}` && p.number === Number(m[3]));
  if (pr) return sendHtml(200, shell(`${ref(pr)} · Proxy Reviewer`, reviewPage(ctx, pr), ctx, "review"));
  sendHtml(404, shell("Not found", html`<main class="doc"><p>Not found. <a href="/">All PRs</a></p></main>`, ctx, "settings"));
}).listen(port, "127.0.0.1", () => {
  console.log(`Status page prototype (issue #8): http://localhost:${port}`);
});
