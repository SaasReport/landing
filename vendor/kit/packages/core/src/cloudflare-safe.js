/**
 * Markup that survives Cloudflare's page rewriting (docs/SITE.md, "Behind Cloudflare"). A zone with Rocket Loader or Email
 * Address Obfuscation switched on rewrites the HTML it serves; the kit's pages must work with both on, so the markup says
 * what to leave alone, in Cloudflare's own documented words:
 *
 *   Rocket Loader   `data-cfasync="false"` on a script tag, as an attribute BEFORE `src` (Cloudflare's requirement: written
 *                   after src it is read too late), keeps the script out of Rocket Loader's deferred queue. Every executable
 *                   script gets it (external, inline and module); a JSON data block (ld+json, importmap, …) is never run,
 *                   so Rocket Loader has nothing to rewrite there and it is left as it is.
 *   Email obfuscation  `<!--email_off-->` … `<!--/email_off-->` around markup keeps Cloudflare from replacing the email
 *                   addresses inside it with `[email protected]` and an inline decoder. The kit wraps every `mailto:` link and
 *                   every form that posts to a `mailto:` action (a site that wants Cloudflare to obfuscate them sets
 *                   `cloudflare.emailOff: false`). An address written as plain text outside a link is left to Cloudflare.
 *
 * Pure string functions: no Node APIs, so the Worker's shell and the static build use the same ones.
 */

/** The attribute that keeps a script out of Rocket Loader. */
export const CFASYNC = 'data-cfasync="false"';
export const EMAIL_OFF = "<!--email_off-->";
export const EMAIL_ON = "<!--/email_off-->";

// an attribute value may hold ">" inside quotes
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const SCRIPT_START = new RegExp(`<script\\b(${ATTRS})>`, "gi");
// a data block: never executed, so never touched by Rocket Loader
const DATA_TYPE = /\btype\s*=\s*(?:"|')?\s*(?:application\/(?:[\w.+-]*\+)?json|application\/json|importmap|speculationrules|text\/template|text\/x-template)\b/i;
const CFASYNC_ATTR = /\sdata-cfasync(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;

/** The attributes of one script start tag, with `data-cfasync="false"` first (and no other data-cfasync). */
function withCfasync(attrs) {
  if (DATA_TYPE.test(attrs)) return attrs;
  return ` ${CFASYNC}${attrs.replace(CFASYNC_ATTR, "")}`;
}

/** The markup that is code or comment, which neither pass may rewrite: [{ code: true, text }, …] alternating with markup. */
function segments(html) {
  const out = [];
  const re = /<!--email_off-->[\s\S]*?<!--\/email_off-->|<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi;
  let last = 0;
  for (const m of html.matchAll(re)) {
    if (m.index > last) out.push({ code: false, text: html.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ code: false, text: html.slice(last) });
  return out;
}

/** Every executable `<script>` start tag of an HTML string carries `data-cfasync="false"` before `src`. Idempotent. */
export function cfasyncScripts(html) {
  return String(html).replace(SCRIPT_START, (tag, attrs) => `<script${withCfasync(attrs)}>`);
}

const MAILTO_A = `<a\\b${ATTRS}\\bhref\\s*=\\s*(?:"\\s*mailto:[^"]*"|'\\s*mailto:[^']*'|mailto:[^\\s>]*)${ATTRS}>[\\s\\S]*?</a\\s*>`;
const MAILTO_FORM = `<form\\b${ATTRS}\\baction\\s*=\\s*(?:"\\s*mailto:[^"]*"|'\\s*mailto:[^']*'|mailto:[^\\s>]*)${ATTRS}>[\\s\\S]*?</form\\s*>`;
// a form first: the links inside it are then part of its one wrapped region
const MAILTO = new RegExp(`${MAILTO_FORM}|${MAILTO_A}`, "gi");

/** Every mailto link (and every form with a mailto action) outside code, comments and an existing email_off region is wrapped in email_off. Idempotent. */
export function emailOff(html) {
  return segments(String(html)).map((p) => (p.code ? p.text : p.text.replace(MAILTO, (m) => `${EMAIL_OFF}${m}${EMAIL_ON}`))).join("");
}

/**
 * The page as Cloudflare may serve it: scripts out of Rocket Loader, mailto markup out of email obfuscation.
 * `{ emailOff: false }` leaves the e-mail markup to Cloudflare (a site that wants its addresses obfuscated).
 */
export function cloudflareSafe(html, { emailOff: wrapEmail = true } = {}) {
  const out = cfasyncScripts(html);
  return wrapEmail === false ? out : emailOff(out);
}

/** One script tag, written as the kit writes them: `data-cfasync="false"` first, then src. `{ src, module?, defer? }` (external) or `{ module?, body }` (inline). */
export function scriptTag({ src, module = false, defer = true, body = "" } = {}) {
  const a = [CFASYNC, module ? 'type="module"' : null, src ? `src="${String(src).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : null, src && defer && !module ? "defer" : null].filter(Boolean);
  return `<script ${a.join(" ")}>${body}</script>`;
}
