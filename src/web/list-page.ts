import type { Job } from "../state.ts";
import { type Html, html } from "./html.ts";
import { ago, type Chrome, countdown, money, page } from "./layout.ts";
import {
  byUrgency,
  describeJob,
  GROUP_LABELS,
  GROUPS,
  inTab,
  OPEN_DAYS,
  type PrView,
  prPath,
  TAB_LABELS,
  TABS,
  type Tab,
} from "./prs.ts";

export interface ListPageInput {
  chrome: Chrome;
  tab: Tab;
  prs: PrView[];
  /** Ticket ids per "repo#pr", for the Needs you rows. Missing when tickets are off. */
  tickets: Map<string, string[]>;
}

const roundHref = (pr: PrView, n?: number) => (n ? `${prPath(pr)}?round=${n}` : prPath(pr));
const shortRef = (pr: PrView) => `${pr.repo.split("/")[1] ?? pr.repo}#${pr.pr}`;

function roundText(job: Job, paused: boolean): string {
  const { label } = describeJob(job, { paused });
  if (job.findings == null) return label;
  const n = job.findings;
  return `${label} · ${n} ${job.round > 1 ? "open" : n === 1 ? "finding" : "findings"}`;
}

/** The second line under a state: the live timer for a held review, otherwise its note. */
function stateLine(job: Job, chrome: Chrome): Html | string {
  if (job.status === "held") {
    const { note } = describeJob(job, { paused: chrome.postingPaused });
    return html`${job.hold_until ? countdown(job.hold_until, chrome.now) : html`<span class="sub">Waits for you, no timer</span>`}${note ? html`<span class="sub">${note}</span>` : ""}`;
  }
  const { note } = describeJob(job, { paused: chrome.postingPaused });
  return note ? html`<span class="sub" title="${note}">${note}</span>` : "";
}

function chip(job: Job, paused: boolean): Html {
  const { label, tone } = describeJob(job, { paused });
  return html`<span class="chip ${tone}">${label}</span>`;
}

function pills(pr: PrView, paused: boolean): Html {
  return html`${pr.skipped ? html`<span class="skip" title="${pr.skipped} older ${pr.skipped === 1 ? "commit" : "commits"} skipped">+${pr.skipped}</span>` : ""}${pr.rounds.map(
    (job, i) =>
      html`<a class="pill ${describeJob(job, { paused }).tone}" href="${roundHref(pr, i + 1)}" title="${roundText(job, paused)}">R${i + 1}</a>`,
  )}`;
}

/** Needs you: one expandable row per PR, timer up front, full details. */
function needsRows(prs: PrView[], input: ListPageInput): Html {
  const { chrome } = input;
  const paused = chrome.postingPaused;
  const row = (pr: PrView) => {
    const tickets = input.tickets.get(`${pr.repo}#${pr.pr}`) ?? [];
    const meta = [
      `${pr.repo}#${pr.pr}`,
      pr.author ? `by ${pr.author}` : null,
      ...tickets,
      pr.costUsd ? `${money(pr.costUsd)} total` : null,
    ].filter(Boolean);
    return html`<details class="row"><summary>
<span>${chip(pr.latest, paused)}${stateLine(pr.latest, chrome)}</span>
<span class="row-main"><a class="row-title" href="${roundHref(pr)}">${pr.title}</a><span class="muted small">${meta.join(" · ")}</span></span>
<span class="num">${pr.rounds.length} ${pr.rounds.length === 1 ? "round" : "rounds"}</span>
<span class="num">${ago(pr.updatedAt, chrome.now)}</span>
<span class="caret" aria-hidden="true">▸</span></summary>
<ul class="rounds">${pr.skipped ? html`<li class="skipped">${pr.skipped} older ${pr.skipped === 1 ? "commit" : "commits"} skipped</li>` : ""}${pr.rounds.map(
      (
        job,
        i,
      ) => html`<li><a href="${roundHref(pr, i + 1)}"><b>R${i + 1}</b> · ${roundText(job, paused)}</a>
<span class="muted small"> · <span class="ref">${job.head_sha.slice(0, 7)}</span> · ${ago(job.updated_at, chrome.now)}${job.cost_usd ? ` · ${money(job.cost_usd)}` : ""}</span></li>`,
    )}</ul></details>`;
  };
  if (!prs.length) return html`<div class="card empty">Nothing waits on you.</div>`;
  return html`<div class="card">${[...prs].sort(byUrgency).map(row)}</div>`;
}

/** Open: a board, one column per who the PR waits on. */
function board(prs: PrView[], chrome: Chrome): Html {
  const paused = chrome.postingPaused;
  const card = (pr: PrView) => html`<article class="bcard${pr.group === "needs" ? " hot" : ""}">
<a class="bcard-title" href="${roundHref(pr)}">${pr.title}</a>
<div>${chip(pr.latest, paused)}${stateLine(pr.latest, chrome)}</div>
<div>${pills(pr, paused)}<span class="muted small"> ${ago(pr.updatedAt, chrome.now)}</span></div></article>`;
  return html`<div class="board">${GROUPS.map((g) => {
    const items = prs.filter((p) => p.group === g);
    return html`<section class="col"><h2 class="group">${GROUP_LABELS[g]} <span class="count">${items.length}</span></h2>${items.length ? items.map(card) : html`<p class="muted small">Nothing here.</p>`}</section>`;
  })}</div>`;
}

/** All: one dense line per PR, rounds as pills. */
function lines(prs: PrView[], chrome: Chrome): Html {
  const paused = chrome.postingPaused;
  if (!prs.length)
    return html`<div class="card empty">No PRs yet. When someone requests your review, it shows up here within a minute.</div>`;
  return html`<div class="card">${prs.map((pr) => {
    const look = describeJob(pr.latest, { paused });
    return html`<div class="line">
<span class="ldot ${look.tone}" title="${look.label}"></span>
<a class="ref" href="${roundHref(pr)}">${shortRef(pr)}</a>
<a class="line-title" href="${roundHref(pr)}" title="${pr.title}">${pr.title}</a>
<span>${pills(pr, paused)}</span>
<span class="line-state" title="${look.note ?? look.label}">${look.label}${look.note ? html` <span class="muted small">${look.note}</span>` : ""}</span>
<span class="num">${ago(pr.updatedAt, chrome.now)}</span></div>`;
  })}</div>`;
}

export function renderListPage(input: ListPageInput): string {
  const { chrome, tab } = input;
  const inEach = Object.fromEntries(
    TABS.map((t) => [t, input.prs.filter((p) => inTab(p, t, chrome.now))]),
  ) as Record<Tab, PrView[]>;
  const shown = inEach[tab];
  const tabs = html`<nav class="tabs">${TABS.map(
    (t) =>
      html`<a class="tab${t === tab ? " on" : ""}" href="${t === "needs" ? "/" : `/?tab=${t}`}"${t === tab ? html` aria-current="page"` : ""}>${TAB_LABELS[t]} <span class="count">${inEach[t].length}</span></a>`,
  )}<span class="tabnote">Done PRs leave Open after ${OPEN_DAYS} days; All keeps them.</span></nav>`;
  const body =
    tab === "needs"
      ? needsRows(shown, input)
      : tab === "open"
        ? board(shown, chrome)
        : lines(shown, chrome);
  const waiting = inEach.needs.length;
  return page(
    chrome,
    waiting ? `(${waiting}) Proxy Reviewer` : "Proxy Reviewer",
    html`${tabs}${body}`,
  );
}
