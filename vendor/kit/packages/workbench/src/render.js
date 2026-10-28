/**
 * The workbench page, server side. The first chunk (heading, intro, the badge key, the command line) carries everything a
 * crawler or a slow connection needs and no pane; each default pane is its own chunk with its title, its source badge and
 * a loading line, so a Worker can flush them one by one and a pane that fails later never blocks another; the last chunk
 * holds the dialogs, the reference (commands, sources) and the embedded definition. The static build joins the chunks.
 *
 *   workbenchChunks(def, strings) → { first, panes: [html], last }
 */
import { loadRuntime } from "./runtime.js";
import { ENVELOPE_SCHEMA } from "./define.js";

export const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let WB; const core = () => (WB ||= loadRuntime());
const nameOf = (s, code) => (typeof s.name === "string" ? s.name : s.name[code] || Object.values(s.name)[0]);
const kindOf = (s) => (s === "byo" ? { kind: "customer-dataset" } : s);

export const badge = (src, S) => { const b = core().badgeOf(src); return `<span class="wb-badge" data-badge="${b}" title="${esc(S.badgeText[b])}"><b dir="ltr">${core().BADGE_LATIN[b]}</b><span>${esc(S.badge[b])}</span></span>`; };

export function workbenchChunks(def, S) {
  const { toDigits } = core(), dg = (v) => toDigits(v, def.locale.digits);
  const paneOf = new Map(def.panes.map((p) => [p.id, p])), srcOf = new Map(def.sources.map((s) => [s.id, s]));
  const layout = def.layouts.find((l) => l.id === def.defaultLayout);
  const kinds = { synthetic: { kind: "sandbox-mock", origin: "generated" }, sandbox: { kind: "sandbox-mock", origin: "sandbox-api" }, computed: { kind: "sandbox-mock", origin: "computed" }, yours: { kind: "customer-dataset" }, feed: { kind: "public-feed" } };
  const key = `<div class="wb-key"><ul class="wb-key__pills" aria-label="${esc(S.keyTitle)}">${Object.keys(S.badge).map((k) => `<li>${badge(kinds[k], S)}</li>`).join("")}</ul><details class="wb-key__what"><summary>${esc(S.keyMeaning)}</summary><dl>${Object.keys(S.badge).map((k) => `<div><dt>${badge(kinds[k], S)}</dt><dd>${esc(S.badgeText[k])}</dd></div>`).join("")}</dl></details></div>`;
  const lsel = def.layouts.length > 1 ? `<select class="wb-select" data-wb-layouts aria-label="${esc(S.layout)}">${def.layouts.map((l) => `<option value="${esc(l.id)}"${l.id === def.defaultLayout ? " selected" : ""}>${esc(l.title)}</option>`).join("")}</select>` : "";
  const first = `<div class="wb-page" data-workbench-page>
<h1>${esc(def.title)}</h1>
${def.intro ? `<p class="wb-page__intro">${esc(def.intro)}</p>` : ""}
<div class="wb" data-workbench data-lang="${esc(def.locale.code)}">
<div class="wb__bar">
<form class="wb__cmd" data-wb-cmd role="search" autocomplete="off"><label for="wb-cmd">${esc(S.cmdLabel)}</label><input class="wb__input" id="wb-cmd" data-wb-input type="text" role="combobox" aria-expanded="false" aria-controls="wb-sug" aria-autocomplete="list" autocomplete="off" autocapitalize="off" spellcheck="false" dir="auto" placeholder="${esc(S.cmdPlaceholder)}"><button class="wb-btn" type="submit">${esc(S.cmdRun)}</button><ul class="wb__sug" id="wb-sug" data-wb-sug role="listbox" aria-label="${esc(S.cmdLabel)}" hidden></ul></form>
<div class="wb__tools">${lsel}<button class="wb-btn wb-btn--quiet" type="button" data-wb-split>${esc(S.split)}</button><button class="wb-btn wb-btn--quiet" type="button" data-wb-reset>${esc(S.reset)}</button><button class="wb-btn wb-btn--quiet" type="button" data-wb-help-btn>${esc(S.helpBtn)} <kbd>?</kbd></button>${def.byo.enabled ? `<button class="wb-btn" type="button" data-wb-byo-btn>${esc(S.byoBtn)}</button>` : ""}</div>
</div>
<p class="wb__msg" data-wb-cmderr role="alert" hidden></p>
<p class="wb__sr" data-wb-status role="status" aria-live="polite"></p>
${key}
<noscript><p class="wb-note">${esc(S.noscript)}</p></noscript>
<div class="wb__grid" data-wb-grid data-groups="${layout.groups.length}">
`;
  const panes = layout.groups.map((g, gi) => {
    const tabs = g.map((t, i) => { const p = paneOf.get(t.pane); return `<span class="wb-tabwrap" data-active="${i === 0}"><button type="button" role="tab" class="wb-tab" id="ssr-tab-${gi}-${i}" aria-controls="ssr-panel-${gi}-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(p.title)}</button></span>`; }).join("");
    const p = paneOf.get(g[0].pane), src = p.source === "byo" ? { kind: "customer-dataset" } : srcOf.get(p.source);
    return `<section class="wb-group" data-focus="${gi === 0}" aria-label="${esc(S.group)} ${dg(gi + 1)}"><div class="wb-tabs" role="tablist" aria-label="${esc(S.tabs)}">${tabs}</div>
<div class="wb-pane" role="tabpanel" id="ssr-panel-${gi}-0" aria-labelledby="ssr-tab-${gi}-0" data-pane="${esc(p.id)}" tabindex="-1"><header class="wb-pane__head"><h2 class="wb-pane__title">${esc(p.title)}</h2>${badge(src, S)}</header><div class="wb-pane__body" aria-busy="true"><p class="wb-load">${esc(S.panelLoading)}</p></div></div></section>
`;
  });
  const field = (name, label, o = {}) => `<label class="wb-field"><span>${label}</span><input class="wb-input" name="${name}" type="${o.type || "text"}"${o.req ? " required" : ""}${o.attrs || ""} autocomplete="off"></label>`;
  const b = S.byo, lim = b.limits.replace("{resp}", dg(def.byo.maxResponseBytes)).replace("{rows}", dg(def.byo.maxRows)).replace("{sec}", dg(Math.round(def.byo.timeoutMs / 1000)));
  const byoDlg = def.byo.enabled ? `<dialog class="wb-dlg" data-wb-byo aria-labelledby="wb-byo-t"><div class="wb-dlg__in"><h2 id="wb-byo-t">${esc(b.dialogTitle)}</h2><p class="wb-note-yours">${esc(b.intro)}</p>
<form data-byo-endpoint novalidate><fieldset><legend>${esc(b.endpointLegend)}</legend>
<label class="wb-field"><span>${esc(b.url)}<br><small>${esc(b.urlHelp)}</small></span><input class="wb-input" name="url" data-byo-url type="url" inputmode="url" dir="ltr" required autocomplete="off" placeholder="https://"></label>
${field("header", esc(b.header), { attrs: ' dir="ltr" placeholder="Authorization"' })}${field("key", esc(b.key), { type: "password", attrs: ' dir="ltr"' })}
<label class="wb-check"><input type="checkbox" name="keep"><span>${esc(b.keep)}</span></label>${field("pass", esc(b.passphrase), { type: "password" })}
<label class="wb-field"><span>${esc(b.schema)}</span><textarea class="wb-input wb-code" name="schema" rows="4" dir="ltr" spellcheck="false"></textarea></label>
<label class="wb-check"><input type="checkbox" name="save"><span>${esc(b.save)}</span></label>
<div class="wb-dlg__row"><button type="button" class="wb-btn wb-btn--quiet" data-byo-infer>${esc(b.infer)}</button><button type="submit" class="wb-btn">${esc(b.fetch)}</button></div></fieldset></form>
<form data-byo-file novalidate><fieldset><legend>${esc(b.fileLegend)}</legend>
<label class="wb-field"><span>${esc(b.file)}</span><input class="wb-input" name="file" type="file" accept=".csv,.json,text/csv,application/json"></label>
<label class="wb-field"><span>${esc(b.schema)}</span><textarea class="wb-input wb-code" name="schema" rows="3" dir="ltr" spellcheck="false"></textarea></label>
<label class="wb-check"><input type="checkbox" name="save"><span>${esc(b.saveDs)}</span></label>
<div class="wb-dlg__row"><button type="submit" class="wb-btn">${esc(b.upload)}</button></div></fieldset></form>
<p class="wb-note">${esc(lim)}</p><p class="wb-dlg__err" data-byo-err role="alert" tabindex="-1"></p>
<div class="wb-dlg__row"><button type="button" class="wb-btn wb-btn--quiet" data-byo-close>${esc(b.close)}</button></div></div></dialog>` : "";
  const helpDlg = `<dialog class="wb-dlg" data-wb-help aria-labelledby="wb-help-t"><div class="wb-dlg__in"><h2 id="wb-help-t">${esc(S.help.title)}</h2><div data-help-body></div><div class="wb-dlg__row"><button type="button" class="wb-btn wb-btn--quiet" data-help-close>${esc(S.byo.close)}</button></div></div></dialog>`;
  const refCmd = `<section class="wb-ref" aria-labelledby="wb-ref-c"><h2 id="wb-ref-c">${esc(S.commandsRef)}</h2><div class="wb-scroll" tabindex="0" role="region" aria-label="${esc(S.commandsRef)}"><table class="wb-table"><thead><tr><th scope="col">${esc(S.help.verb)}</th><th scope="col">${esc(S.help.aliases)}</th><th scope="col">${esc(S.help.what)}</th><th scope="col">${esc(S.help.example)}</th></tr></thead><tbody>${def.commands.map((c) => `<tr><td><code dir="ltr">${esc(c.verb)}</code></td><td>${esc(c.aliases.join("، "))}</td><td>${esc(c.summary)}</td><td>${c.example ? `<code dir="ltr">${esc(c.example)}</code>` : ""}</td></tr>`).join("")}</tbody></table></div></section>`;
  const refSrc = `<section class="wb-ref" aria-labelledby="wb-ref-s"><h2 id="wb-ref-s">${esc(S.sourcesRef)}</h2><ul class="wb-srcs">${def.sources.map((s) => `<li class="wb-src" data-enabled="${s.enabled}"><div class="wb-src__top">${s.homepage ? `<a href="${esc(s.homepage)}" rel="noopener"><strong>${esc(nameOf(s, def.locale.code))}</strong></a>` : `<strong>${esc(nameOf(s, def.locale.code))}</strong>`} ${badge(s, S)}</div><p class="wb-note">${esc(s.licence.line)} (${esc(S.redistribution[s.licence.redistribution])})${s.enabled ? "" : ` — ${esc(S.disabledShort)}: ${esc(s.disabledReason)}`}</p></li>`).join("")}</ul></section>`;
  const data = JSON.stringify({ def, strings: S, schemas: { envelope: ENVELOPE_SCHEMA } }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const last = `</div>
${helpDlg}
${byoDlg}
</div>
${refCmd}
${refSrc}
</div>
<script type="application/json" id="wb-data">${data}</script>
`;
  return { first, panes, last };
}

export const renderWorkbenchBody = (def, S) => { const c = workbenchChunks(def, S); return c.first + c.panes.join("") + c.last; };
