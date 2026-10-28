/**
 * Article episodes (optional): a blog post rewritten as a two-host conversation by a Workers AI model,
 * then checked — every number spoken must appear in the source, otherwise the draft is rejected.
 * Config: tts.article = { models, temperature, maxTokens, minLines, maxLines, maxChars, maxTotal, series }.
 * Prompt texts: strings.podcast.article.{system, source, user, code, intro, outro, repair}.
 * With `check` (the Persian gate), a draft that fails is sent back to the same model once with its findings (repair).
 */
import { podcastStrings } from "./strings.js";
import { numbersIn, mergeTurns } from "./speech.js";
import { hostKeys, fill, seriesById } from "./config.js";
import { baseVars, templateLines } from "./episodes.js";
import { findingsText, PERSIAN_ERROR, persianGate } from "./persian.js";

export const DEFAULT_SCRIPT_MODELS = ["@cf/deepseek-ai/deepseek-v4-flash-0731", "@cf/openai/gpt-oss-120b"];

export function articleOptions(config) {
  const a = config?.tts?.article || {};
  const maxChars = a.maxChars ?? 900;
  return {
    models: a.models ?? DEFAULT_SCRIPT_MODELS, temperature: a.temperature ?? 0.4, maxTokens: a.maxTokens ?? 4000,
    minLines: a.minLines ?? 8, maxLines: a.maxLines ?? 12, maxChars,
    // the guard is a little looser than the prompt, as in the original
    guard: { minLines: a.guardMinLines ?? 6, maxLines: a.guardMaxLines ?? 14, maxTotal: a.maxTotal ?? Math.round(maxChars * 1.22), maxLine: a.maxLine ?? 600 },
    series: a.series ?? null,
  };
}

/**
 * Parse and check a model draft.
 * @param {string} raw model output (JSON somewhere inside)
 * @param {string} sourceText the text the draft must stay faithful to
 * @param {{speakers?: string[], minLines?: number, maxLines?: number, maxTotal?: number, maxLine?: number}} [o]
 * @returns {{lines: {speaker: string, text: string}[]} | {error: string}}
 */
export function checkDraft(raw, sourceText, o = {}) {
  const { speakers = null, minLines = 6, maxLines = 14, maxTotal = 1100, maxLine = 600 } = o;
  let obj;
  try { obj = JSON.parse(String(raw).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1")); } catch { return { error: "draft is not JSON" }; /* the error is returned to the caller, which reports it */ }
  const lines = Array.isArray(obj?.lines) ? obj.lines : null;
  if (!lines || lines.length < minLines || lines.length > maxLines) return { error: `draft has ${lines?.length ?? 0} lines` };
  if (lines.reduce((n, l) => n + String(l?.text || "").length, 0) > maxTotal) return { error: "draft is too long for a soundbite" };
  const allowed = new Set(numbersIn(sourceText));
  for (const [i, l] of lines.entries()) {
    if ((speakers && !speakers.includes(l?.speaker)) || typeof l?.text !== "string" || !l.text.trim() || l.text.length > maxLine) return { error: `line ${i + 1} is malformed` };
    const stray = numbersIn(l.text).filter((n) => !allowed.has(n));
    if (stray.length) return { error: `line ${i + 1} mentions ${stray.join(",")} which the source does not` };
  }
  return { lines: lines.map((l) => ({ speaker: l.speaker, text: l.text.trim() })) };
}

const stripCode = (md, code) => String(md ?? "").replace(/```[\s\S]*?```/g, `\n${code}\n`).replace(/^---[\s\S]*?---/, "").trim();

/** The series article episodes belong to: tts.article.series, else the first topic series with a podcast. */
export function articleSeries(config) {
  const id = articleOptions(config).series;
  return (id && seriesById(config, id)) || (config?.series || []).find((s) => s.kind === "topic" && s.podcast) || null;
}

/**
 * Ask Workers AI (env.AI or the binding named by storage.ai) for a conversation about the post;
 * tries each model until a draft passes checkDraft.
 * @param {{AI: {run: Function}}} env
 * @param {object} config
 * @param {{title: string, summary?: string, body_md?: string, slug?: string}} post
 * @returns {Promise<{model: string, lines: object[]} | {error: string}>}
 */
export async function articleScript(env, config, post, { ai = env?.AI, check = persianGate(config), feedback = null, repairs = 1 } = {}) {
  // the language gate defaults to the project's own (persianGate: the Persian gate for a Persian project, none otherwise):
  // a caller that passes no check never gets a Persian draft through unchecked; check: null turns it off explicitly
  if (!ai?.run) return { error: "no Workers AI binding" };
  const S = podcastStrings(config).article, o = articleOptions(config), series = articleSeries(config);
  const vars = { ...baseVars(config, series), title: post.title, summary: post.summary ?? "", minLines: o.minLines, maxLines: o.maxLines, maxChars: o.maxChars };
  const source = fill(S.source, { ...vars, body: stripCode(post.body_md ?? post.body, S.code) });
  const system = fill(S.system, vars);
  const errors = [];
  // findings from a previous run (the Persian gate) are fed back with the first request
  const first = fill(S.user, { source }) + (feedback && S.repair ? `\n\n${fill(S.repair, { findings: feedback })}` : "");
  for (const model of o.models) {
    try {
      const messages = [{ role: "system", content: system }, { role: "user", content: first }];
      for (let round = 0; round <= repairs; round++) {
        const out = await ai.run(model, { messages, max_tokens: o.maxTokens, temperature: o.temperature });
        const raw = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        const r = checkDraft(text, source, { speakers: hostKeys(config), ...o.guard });
        if (!r.lines) { errors.push(`${model}: ${r.error}`); break; }
        const lines = mergeTurns([...templateLines(config, S.intro, vars), ...r.lines, ...templateLines(config, S.outro, vars)]);
        // check: the Persian gate (persian.js); a draft with errors is sent back once with its findings, then the next model
        if (!check) return { model, lines };   // no language gate applies to this project
        const verdict = check(lines);
        if (verdict.ok) return { model, lines };
        const found = findingsText(verdict.findings);
        errors.push(`${model}: ${PERSIAN_ERROR} ${found.split("\n")[0]}`);
        if (!S.repair || round === repairs) break;
        messages.push({ role: "assistant", content: text }, { role: "user", content: fill(S.repair, { findings: found }) });
      }
    } catch (e) { errors.push(`${model}: ${String(e).slice(0, 200)}`); }
  }
  return { error: errors.join(" | ") };
}

/** Episode row for a post; lines are produced later by the workflow (articleScript). */
export function articleEpisode(config, post) {
  const s = articleSeries(config);
  return {
    slug: `post-${post.slug}`.slice(0, 90), kind: "article", series: s?.id ?? null, number: null,
    title: post.title, summary: post.summary ?? "", lines: null, source_type: "post", source_ref: post.slug,
  };
}
