/**
 * The guard engine (docs/AGENT-GUARD.md): ONE pure function, decide(payload, ctx), over a Claude Code (or Codex) hook payload and the
 * effective constitution registry. Deterministic: the verdict is a function of (payload, registry, the file it is about to change).
 * No clock, no network, no randomness. Zero npm dependencies (it runs from a vendored snapshot with nothing installed).
 *
 *   decide(payload, ctx) → { action: "allow" }
 *                        | { action: "deny", rule, reason }
 *                        | { action: "context", text }                (SessionStart, SubagentStart)
 *   ctx = { root, registry, readFile(abs) → string | null, branch() → string | null, hookRel }
 *
 * Every deny names an id in ENGINE_RULES; the registry's `enforce.hook` lists those ids and `kit check canon` (enforcement) proves the two
 * lists agree both ways, so a rule never claims a hook that does not exist and a hook never runs unregistered.
 */
import { resolve } from "node:path";
import { readHeader } from "../diagram-header.js";
import { ALLOW, base, deny, isSecretFile, locate, matchAny, pointerValue, re, secretHit } from "./common.js";
import { SCOPE_GIT, checkBash } from "./bash-rules.js";
import { gitCall, simpleCommands, writeTargets } from "./shell.js";
import { hooksIntact } from "./guard-hooks.js";
import { CANON_FILE } from "./registry.js";

export const ENGINE_RULES = [
  "diagram-image-handwritten", "diagram-headerless-source", "diagram-foreign-renderer",
  "generated-hand-edit",
  "secret-literal", "secret-file-read", "secret-env-print",
  "git-skip-hooks", "git-force-push", "git-protected-branch-push", "ruleset-tamper",
  "guard-tamper", "guard-bypass-flags",
  "subagent-scope",
  "agent-production-write", "agent-merge", "agent-approval-write", "unbounded-process", "agent-credential-mutation",
  "obfuscated-execution", "undeclared-tool", "agent-identity",
];

export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const GIT_WORD = "git";    // the subcommand's label in a decision, not a git call
const GH_MERGE = new Set(["mcp__github__merge_pull_request", "mcp__github__enable_pr_auto_merge", "mcp__github__pull_request_review_write"]);
const GH_WRITE = new Set(["mcp__github__create_or_update_file", "mcp__github__push_files", "mcp__github__delete_file"]);


/** The file writes of a tool call: [{ loc, before, after, remote, del }]. `after` is the content the file will have, or null when unknown. */
function fileWrites(payload, ctx) {
  const t = payload.tool_name, i = payload.tool_input || {};
  const out = [];
  const cur = (loc) => (loc?.abs ? ctx.readFile(loc.abs) : null);
  if (t === "Write") { const loc = locate(i.file_path, ctx, payload); out.push({ loc, before: cur(loc), after: i.content ?? "" }); }
  else if (t === "Edit" || t === "MultiEdit") {
    const loc = locate(i.file_path, ctx, payload); const before = cur(loc);
    const edits = t === "Edit" ? [{ old_string: i.old_string, new_string: i.new_string, replace_all: i.replace_all }] : (i.edits || []);
    let after = before ?? "";
    for (const e of edits) {
      const o = e.old_string ?? "", n = e.new_string ?? "";
      if (before === null && o === "") { after = n; continue; }
      after = e.replace_all ? after.split(o).join(n) : after.replace(o, () => n);
    }
    out.push({ loc, before, after });
  } else if (t === "NotebookEdit") { const loc = locate(i.notebook_path, ctx, payload); out.push({ loc, before: cur(loc), after: i.new_source ?? "" }); }
  else if (t === "mcp__github__create_or_update_file") out.push({ loc: locate(i.path, ctx, payload, true), before: null, after: i.content ?? "", remote: true, branch: i.branch });
  else if (t === "mcp__github__push_files") for (const f of i.files || []) out.push({ loc: locate(f.path, ctx, payload, true), before: null, after: f.content ?? "", remote: true, branch: i.branch });
  else if (t === "mcp__github__delete_file") out.push({ loc: locate(i.path, ctx, payload, true), before: null, after: null, remote: true, del: true, branch: i.branch });
  return out.filter((w) => w.loc);
}

/** Mermaid fences in a text without a valid kit:diagram header (id string). `.mmd` files are one block. */
export function headerlessMermaid(text, ext) {
  if (text == null) return 0;
  const bad = (body) => { const h = readHeader(body); return !(h.header && typeof h.header.id === "string" && h.header.id); };
  if (ext === ".mmd") return text.trim() && bad(text) ? 1 : 0;
  let n = 0;
  for (const m of text.matchAll(/^[ \t]*(```|~~~)[ \t]*mermaid[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm)) if (bad(m[2])) n++;
  return n;
}

const COMMENT = /^(\/\/|\/\*|\*|<!--|;|#)/;
/** Does the head of a file declare itself generated (a marker in a comment line, or a JSON key)? */
export function selfDeclaresGenerated(text, g, file = "") {
  if (!text) return null;
  const md = /\.(md|mdx|markdown)$/.test(file);
  for (const raw of text.split(/\r?\n/).slice(0, g.markerLines || 8)) {
    const line = raw.trim();
    for (const m of g.markers || []) {
      if (new RegExp(`"${m.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(line)) return m;
      if (line.includes(m) && (md ? line.startsWith("<!--") : COMMENT.test(line))) return m;
    }
  }
  return null;
}


/** Rules that look at ONE file write. */
function checkWrite(w, payload, ctx) {
  const reg = ctx.registry, { loc } = w, { rel } = loc;
  // audit (CI, git hooks): the invariants of the RESULT. Who or what produced it (a generator, the owner) is decided by the freshness checks and review.
  const audit = ctx.audit === true;
  const ext = (/\.[A-Za-z0-9]+$/.exec(rel) || [""])[0].toLowerCase();
  const inRepo = loc.inside;
  if (inRepo) {
    // guard-tamper: the enforcement itself
    const lc = rel.toLowerCase();      // the globs match case-insensitively, so every branch below compares the same way
    const isSettings = lc === ".claude/settings.json" || lc === ".claude/settings.local.json";
    if (matchAny(rel, [...reg.protected.globs, ".git/hooks/**", ".git/config", ".claude/guard.*"], true) && (!audit || isSettings)) {
      if (w.del || w.after == null) return deny("guard-tamper", `${rel} carries the enforcement and is not deleted by an agent. The owner changes enforcement in the kit; \`kit agent-guard sync\` writes it.`);
      if (isSettings) {
        let j; try { j = JSON.parse(w.after); } catch { return deny("guard-tamper", `${rel} would not be valid JSON after this edit; the hooks in it would stop loading.`); }
        if (j && j.disableAllHooks === true) return deny("guard-tamper", `${rel}: disableAllHooks switches every hook off; that is the owner's decision, not an agent's.`);
        if (j && j.allowManagedHooksOnly === true) return deny("guard-tamper", `${rel}: allowManagedHooksOnly would stop the project's hooks.`);
        if (lc === ".claude/settings.json" && ctx.hookRel && !hooksIntact(j, ctx.hookRel)) return deny("guard-tamper", `${rel} must keep the guard hooks exactly as \`kit agent-guard sync\` writes them (SessionStart, SubagentStart, PreToolUse, ConfigChange). Edit other keys, never these; run \`kit agent-guard sync\` to restore.`);
      } else if (lc.startsWith(".claude/hooks/") || lc.startsWith(".github/rulesets/")) {
        return deny("guard-tamper", `${rel} is generated or owner-reviewed enforcement: change it in the kit, then run \`kit agent-guard sync\`.`);
      }
    }
    // kit.canon.json carries enforcement: its "vendor" block places the snapshot the guard protects, and its "project" decides whether the
    // repository is the kit (whose guard runs from the root). The guarded pointers are the registry's guard paths kit.canon.json#/<pointer>
    // (one source): an agent never changes them (live); a commit that does is the owner's change and goes through the signed approval of that
    // guard path (audit), never a hard deny here. A new canon file is the bootstrap.
    if (!audit && matchAny(rel, [CANON_FILE], true) && w.before != null) {
      const pointers = (reg.guardPaths || []).filter((g) => g.toLowerCase().startsWith(`${CANON_FILE}#`)).map((g) => g.slice(g.indexOf("#") + 1));
      for (const ptr of pointers) {
        const was = pointerValue(w.before, ptr), now = w.del || w.after == null ? null : pointerValue(w.after, ptr);
        if (now !== was) return deny("guard-tamper", `${rel}: ${w.del || w.after == null ? "deleting it drops" : now === "unparseable" ? "this edit leaves no readable" : "this edit changes"} ${ptr}, which decides which guard runs and what it protects. Edit the other keys only; the owner changes it with a signed approval of the guard path ${CANON_FILE}#${ptr}.`);
      }
    }
    // generated files
    const g = reg.generated;
    const why = audit ? null : matchAny(rel, g.globs, true) ? `matches the generated glob` : (selfDeclaresGenerated(w.before, g, rel) ? `declares itself generated ("${selfDeclaresGenerated(w.before, g, rel)}")` : null);
    if (why && !w.del) return deny("generated-hand-edit", `${rel} ${why}. Never hand-edit a generated file: change its source and run its generator (kit diagrams render, kit vendor sync, kit claude sync, kit widgets build, kit sdk generate).`);
    if (why && w.del) return deny("generated-hand-edit", `${rel} ${why}; do not delete it by hand, run its generator.`);
    // diagrams
    if (!audit && matchAny(rel, reg.diagrams.imageGlobs, true) && !w.del) return deny("diagram-image-handwritten", `${rel} is an image under docs/. A diagram image is only ever written by \`kit diagrams render\` from a Mermaid source with a %% kit:diagram header; write the .mmd source and render it.`);
    // the vendored kit snapshot is the kit's content, not this repository's diagrams: the kit's own guard judged it there, `kit vendor sync`
    // writes it and `kit vendor check` (kit check canon) proves it byte for byte against the manifest; a hand-edit is generated-hand-edit above
    // the snapshot is kit.canon.json vendor.path (registry.generated.snapshot, the same source as its generated roots), and only while this
    // guard runs from it
    const snap = reg.generated.snapshot, inSnapshot = Boolean(snap) && rel.startsWith(`${snap}/`) && String(ctx.hookRel || "").startsWith(`${snap}/`);
    if (reg.diagrams.sourceExtensions.includes(ext) && w.after != null && !matchAny(rel, reg.diagrams.fixtureGlobs || [], true) && !inSnapshot) {
      const added = headerlessMermaid(w.after, ext) - headerlessMermaid(w.before, ext);
      if (added > 0) return deny("diagram-headerless-source", `${rel}: a Mermaid diagram without a valid \`%% kit:diagram {…}\` header (id, title, project, kind, lineage, depicts). Start from \`kit diagrams migrate\` or copy a sibling's header, then \`kit diagrams render\`.`);
    }
  }
  if (!audit && matchAny(rel, reg.protected.approvalGlobs || [], true) && !w.del) return deny("agent-approval-write", `${rel} is a ledger of human approvals. An agent never writes an approval row; the owner records approvals.`);
  // secrets, anywhere (a local file or a GitHub write)
  const hit = secretHit(w.after, reg);
  if (hit && hit !== secretHit(w.before, reg)) return deny("secret-literal", `${rel}: the content contains a ${hit}. Never write a secret into a file; read it from the environment of the platform that needs it.`);
  return null;
}

/** The subagent's declared scope: a write outside it, or by an agent type that declares none, is refused. */
function checkScope(payload, ctx, writes, cmd) {
  const reg = ctx.registry, type = payload.agent_type || "";
  const scope = reg.scopes.agents[type];
  const where = `${type || "unknown agent"} (${payload.agent_id})`;
  const none = (what) => deny("subagent-scope", `${where} has no write scope declared, so it may not write (${what}). Declare \`scopes.agents.${type || "<type>"}.write\` in constitution.rules.json (reviewed by the owner), or hand the change to an agent that has one.`);
  const out = (rel) => deny("subagent-scope", `${where} may not write ${rel}: outside its declared scope [${scope.write.join(", ") || "read-only"}].`);
  for (const w of writes) {
    if (!scope) return none(w.loc.rel);
    if (!w.loc.inside) { const sp = payload.scratchpad_dir; if (sp && w.loc.abs && resolve(w.loc.abs).startsWith(resolve(sp))) continue; return out(w.loc.rel); }
    if (!matchAny(w.loc.rel, scope.write)) return out(w.loc.rel);
  }
  if (cmd != null) {
    const sims = simpleCommands(cmd);
    const targets = writeTargets(sims).map((t) => locate(t, ctx, payload)).filter(Boolean);
    for (const loc of targets) {
      if (!scope) return none(loc.rel);
      if (!loc.inside) { const sp = payload.scratchpad_dir; if (sp && loc.abs && resolve(loc.abs).startsWith(resolve(sp))) continue; if (loc.abs?.startsWith("/tmp/") || loc.abs === "/dev/null") continue; return out(loc.rel); }
      if (!matchAny(loc.rel, scope.write)) return out(loc.rel);
    }
    const all = scope?.write.includes("**");
    for (const s of sims) { const g = gitCall(s); if (g && SCOPE_GIT.has(g.sub) && !all) return scope ? deny("subagent-scope", `${where} is not declared to change the repository (git ${g.sub}); its scope is [${scope.write.join(", ") || "read-only"}].`) : none(`${GIT_WORD} ${g.sub}`); }
  }
  return null;
}

/** The text injected at SessionStart and SubagentStart: the registry's rules, nothing else. */
export function contextText(reg, payload = {}) {
  const lines = ["This repository's constitution (one registry, constitution.rules.json; every rule is also checked by hooks, `kit check canon` and CI, so a violation is blocked, not just discouraged):"];
  for (const r of reg.rules) lines.push(`- ${r.title}: ${r.text}`);
  lines.push("If a hook refuses an action, do not look for a way around it: the refusal names the allowed path.");
  if (payload.hook_event_name === "SubagentStart") {
    const sc = reg.scopes.agents[payload.agent_type || ""];
    lines.push(sc ? `You are a ${payload.agent_type} subagent. You may write only: ${sc.write.length ? sc.write.join(", ") : "nothing (read-only)"}.` : `You are a ${payload.agent_type || "subagent"} with no declared write scope: you may not write.`);
  }
  return lines.join("\n");
}

export function decide(payload, ctx) {
  const ev = payload.hook_event_name || "";
  if (ev === "SessionStart" || ev === "SubagentStart") return { action: "context", text: contextText(ctx.registry, payload) };
  if (ev === "ConfigChange") {
    const cur = ctx.readFile(resolve(ctx.root, ".claude/settings.json"));
    let j = null; try { j = cur ? JSON.parse(cur) : null; } catch { /* unparseable input counts as absent, never as a valid value */ j = null; }
    if (!j || j.disableAllHooks === true || (ctx.hookRel && !hooksIntact(j, ctx.hookRel))) return deny("guard-tamper", "The project's guard hooks are no longer intact in .claude/settings.json; run `kit agent-guard sync`.");
    return ALLOW;
  }
  if (ev !== "PreToolUse") return ALLOW;   // UserPromptSubmit, SubagentStop, Stop: allowed here; the advisors speak after the rules
  const t = payload.tool_name || "", i = payload.tool_input || {};
  const sub = Boolean(payload.agent_id);
  const cls = toolClass(t, ctx.registry);
  if (!cls) return deny("undeclared-tool", `The tool ${t || "(unnamed)"} is not in a declared tool class, so the guard cannot decide what it does and holds it. Declare it in the registry (tools.classes, or tools.mcp.allowServers for an MCP server), reviewed by the owner.`);
  if (cls === "agent") {                                  // an agent spawn passes the same decision: only an agent type with a declared scope may be started
    if (t === "Agent" || t === "Task") {
      const type = i.subagent_type || "general-purpose";
      if (!ctx.registry.scopes.agents[type]) return deny("subagent-scope", `Starting a ${type} subagent: no write scope is declared for it, so it may not run. Declare scopes.agents.${type}.write ([] for read-only) in constitution.rules.json, reviewed by the owner.`);
    }
    return ALLOW;
  }
  if (t === "Read") { const loc = locate(i.file_path, ctx, payload); if (loc && isSecretFile(base(loc.rel), ctx.registry)) return deny("secret-file-read", `${loc.rel} holds secrets; never read it into the conversation.`); return ALLOW; }
  if (cls === "read") { const p = i.file_path || i.path || i.pattern; const loc = typeof p === "string" && !/[*?]/.test(p) ? locate(p, ctx, payload) : null; if (loc && isSecretFile(base(loc.rel), ctx.registry)) return deny("secret-file-read", `${loc.rel} holds secrets; never read it into the conversation.`); return ALLOW; }
  if (cls === "network") { const hit = secretHit(JSON.stringify(i), ctx.registry); if (hit) return deny("secret-literal", `The request carries a ${hit}.`); return ALLOW; }
  if (GH_MERGE.has(t)) { if (t !== "mcp__github__pull_request_review_write" || ["APPROVE", "approve"].includes(i.event) || i.method === "submit_pending" && ["APPROVE", "approve"].includes(i.event)) return deny("agent-merge", "An agent never merges, auto-merges or approves a pull request. The one path is the broker's `merge` action (green CI on the exact head, a recorded independent review, evidence): `kit agent-guard broker merge <pr>`."); return ALLOW; }
  if (WRITE_TOOLS.has(t) || GH_WRITE.has(t)) {
    const writes = fileWrites(payload, ctx);
    for (const w of writes) { const d = checkWrite(w, payload, ctx); if (d) return d; if (w.remote && w.branch && ctx.registry.git.protectedBranches.includes(w.branch)) return deny("git-protected-branch-push", `Never write straight to ${w.branch} (${w.loc.rel}). Use a branch and a pull request.`); }
    if (sub) { const d = checkScope(payload, ctx, writes, null); if (d) return d; }
    return ALLOW;
  }
  if (cls === "exec") {
    const cmd = i.command || i.script || i.code || i.input || "";
    if (typeof cmd === "string" && cmd) {
      const d = checkBash(cmd, payload, ctx); if (d) return d;
      if (sub) { const s = checkScope(payload, ctx, [], cmd); if (s) return s; }
    }
    return ALLOW;
  }
  if (cls === "mcp") { const hit = secretHit(JSON.stringify(i), ctx.registry); if (hit) return deny("secret-literal", `The call carries a ${hit}.`); return ALLOW; }
  return ALLOW;
}

/** The class of a tool: the registry's declared classes, or "mcp" for an allowed MCP server; null (undeclared) holds the call. */
export function toolClass(name, reg) {
  if (name.startsWith("mcp__")) return reg.tools.mcp.allowServers.includes(name.split("__")[1]) ? "mcp" : null;
  for (const [cls, names] of Object.entries(reg.tools.classes)) if (names.includes(name)) return cls;
  return null;
}

/** A git boundary (pre-commit, pre-push) through the same rules: { hook_event_name: "GitCommit", branch, files: [{ path, before, after }] } or "GitPush", refs: [{ remote, delete }]. */
export function decideGit(p, ctx) {
  const reg = ctx.registry;
  if (p.hook_event_name === "GitCommit") {
    if (p.branch && reg.git.protectedBranches.includes(p.branch)) return deny("git-protected-branch-push", `A commit on ${p.branch}: work on a branch and open a pull request.`);
    for (const f of p.files || []) {
      const loc = locate(f.path, ctx, p, true);
      const d = checkWrite({ loc, before: f.before ?? null, after: f.after ?? null, del: f.after == null }, p, { ...ctx, audit: true });
      if (d) return d;
    }
    return ALLOW;
  }
  for (const r of p.refs || []) {
    const dst = String(r.remote || "").replace(/^refs\/heads\//, "");
    if (reg.git.protectedBranches.includes(dst)) return deny("git-protected-branch-push", `Never push straight to ${dst}. Push your branch and open a pull request.`);
    if (r.delete) return deny("git-force-push", `Deleting the remote ref ${dst} is refused.`);
  }
  return ALLOW;
}

/** The network boundary (a gateway, a proxy, Codex's hosted tools): { hook_event_name: "Egress", method, url, body }. The same rules, over what the call would do. */
export function decideEgress(p, ctx) {
  const reg = ctx.registry;
  let u; try { u = new URL(p.url); } catch { return deny("agent-production-write", "An egress call with no readable URL is held."); }
  const m = String(p.method || "GET").toUpperCase(), write = !["GET", "HEAD", "OPTIONS"].includes(m);
  const path = u.pathname;
  if (u.hostname === "api.cloudflare.com" && /\/(user|accounts\/[^/]+)\/tokens/.test(path)) return deny("agent-credential-mutation", "Minting, rotating or revoking an API token is not an agent action; credentials come from the governed custody path.");
  if (u.hostname === "api.cloudflare.com" && write) return deny("agent-production-write", "A write to the Cloudflare API is a production change; an agent does not make it.");
  if (u.hostname === "api.github.com" && write) {
    if (/\/pulls\/\d+\/(merge|reviews)/.test(path)) return deny("agent-merge", "An agent never merges or approves a pull request.");
    if (/(\/rulesets|\/branches\/[^/]+\/protection|\/environments\/)/.test(path)) return deny("ruleset-tamper", "Rulesets, environments and Actions secrets are the owner's.");
    if (/\/(actions\/(secrets|variables)|dependabot\/secrets|codespaces\/secrets)/.test(path)) return deny("agent-credential-mutation", "Setting or deleting a repository secret or variable is a credential change; credentials come from the governed custody path.");
    if (/\/git\/refs\//.test(path) && (m === "DELETE" || /force"?\s*[:=]\s*true/.test(String(p.body || "")))) return deny("git-force-push", "A forced or deleting ref update through the API is refused.");
  }
  const hit = secretHit(String(p.body || "") + u.search, reg);
  if (hit) return deny("secret-literal", `The request carries a ${hit}.`);
  return ALLOW;
}
