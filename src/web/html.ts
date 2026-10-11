/**
 * Server-side HTML. Every value put into an `html` template is escaped unless it is itself
 * `html` (or `raw`), because PR titles and findings come from other people's PRs.
 */
export interface Html {
  readonly __html: string;
}

/** Trusted markup, passed through as is. Only for strings this code wrote itself. */
export const raw = (s: string): Html => ({ __html: s });

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** Values: Html as is, arrays joined, null/undefined/false as nothing, anything else escaped. */
function render(value: unknown): string {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) return value.map(render).join("");
  if (typeof value === "object" && "__html" in value) return (value as Html).__html;
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? "");
  });
  return raw(out);
}

/** Text with `backtick` spans shown as <code>; every piece is still escaped. */
export const richText = (text: string) =>
  html`${text.split("`").map((piece, i) => (i % 2 ? html`<code>${piece}</code>` : piece))}`;

export const toHtmlString = (h: Html) => h.__html;
