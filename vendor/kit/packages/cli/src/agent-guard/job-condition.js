// Whether a GitHub Actions job condition provably runs the job on the events that must run the agent-guard bench: a push (the merge
// to main) and a pull request that is not a draft. A pattern cannot decide this: `(draft guard) && false` matches the ci-run-budget
// guard and never runs (Codex on kit #135). The condition is evaluated instead, for each of those events, over the expression subset
// a workflow writes for this: `github.event_name`, `github.event.pull_request.draft`, string, boolean and null literals, `==`, `!=`,
// `!`, `&&`, `||` and parentheses, optionally inside `${{ }}`. Any other term (a `vars`, `env`, `inputs` value, a function call) is
// unknown, so the condition is not proven to run: refused, never assumed.

const EVENTS = {
  push: { name: "push", ctx: { "github.event_name": "push", "github.event.pull_request.draft": null } },
  pull_request: { name: "a pull request that is not a draft", ctx: { "github.event_name": "pull_request", "github.event.pull_request.draft": false } },
};

function tokens(src) {
  const out = []; let i = 0;
  const re = /\s*(?:(\$\{\{)|(\}\})|(==|!=|&&|\|\||[!()])|'((?:[^']|'')*)'|(true|false|null)\b|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*))/y;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i; const m = re.exec(src);
    if (!m) throw new Error(`unknown text at ${JSON.stringify(src.slice(i, i + 20))}`);
    i = re.lastIndex;
    if (m[1] || m[2]) continue;                                   // the ${{ }} wrapper carries no meaning here
    if (m[3]) out.push({ op: m[3] });
    else if (m[4] !== undefined) out.push({ lit: m[4].replace(/''/g, "'") });
    else if (m[5]) out.push({ lit: m[5] === "null" ? null : m[5] === "true" });
    else out.push({ ref: m[6] });
  }
  return out;
}

// GitHub's loose comparison: strings compare case-insensitively; differing types compare as numbers (null and false are 0, true is 1).
function eq(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  const num = (v) => (v === null ? 0 : typeof v === "boolean" ? Number(v) : typeof v === "string" ? (v.trim() === "" ? 0 : Number(v)) : NaN);
  return num(a) === num(b);
}
const truthyValue = (v) => !(v === null || v === false || v === 0 || v === "" || Number.isNaN(v));

function evaluate(toks, ctx) {
  let k = 0;
  const peek = () => toks[k]; const take = () => toks[k++];
  const primary = () => {
    const t = take();
    if (!t) throw new Error("the condition ends early");
    if (t.op === "(") { const v = or(); if (take()?.op !== ")") throw new Error("an unclosed parenthesis"); return v; }
    if (t.op === "!") return !truthyValue(primary());
    if ("lit" in t) return t.lit;
    if (t.ref) { if (!Object.hasOwn(ctx, t.ref)) throw new Error(`\`${t.ref}\` is not a term the guard can evaluate`); return ctx[t.ref]; }
    throw new Error(`unexpected \`${t.op}\``);
  };
  const cmp = () => { let v = primary(); while (peek()?.op === "==" || peek()?.op === "!=") { const o = take().op; const r = primary(); v = o === "==" ? eq(v, r) : !eq(v, r); } return v; };
  const and = () => { let v = cmp(); while (peek()?.op === "&&") { take(); const r = cmp(); v = truthyValue(v) ? r : v; } return v; };
  const or = () => { let v = and(); while (peek()?.op === "||") { take(); const r = and(); v = truthyValue(v) ? v : r; } return v; };
  const v = or();
  if (k !== toks.length) throw new Error(`unexpected \`${toks[k].op ?? toks[k].ref ?? JSON.stringify(toks[k].lit)}\``);
  return truthyValue(v);
}

/**
 * null when the job provably runs on each of `events` that the workflow fires on (a push, a non-draft pull request); otherwise why
 * not. An absent condition runs. Terms outside the subset (`github.actor`, `vars`, functions) are refused even where ci-run-budget
 * accepts them after its draft guard: the budget only needs drafts skipped, the bench needs proof that the job runs.
 */
export function jobConditionProblem(cond, events = ["push", "pull_request"]) {
  if (cond === undefined || cond === true) return null;
  if (cond === false) return "it is false";
  let toks;
  try { toks = tokens(String(cond)); } catch (e) { return `it cannot be read (${e.message})`; }
  for (const { name, ctx } of events.filter((e) => EVENTS[e]).map((e) => EVENTS[e])) {
    let runs;
    try { runs = evaluate(toks, ctx); } catch (e) { return `it cannot be proven to run (${e.message})`; }
    if (!runs) return `it is false on ${name}`;
  }
  return null;
}

/** The condition's value in one event context ({ "github.event_name", "github.event.pull_request.draft" }); throws on what it cannot evaluate. */
export function conditionRuns(cond, ctx) {
  if (cond === undefined || cond === true) return true;
  if (cond === false) return false;
  return evaluate(tokens(String(cond)), ctx);
}
