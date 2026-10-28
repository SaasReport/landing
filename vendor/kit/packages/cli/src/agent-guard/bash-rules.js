/**
 * The Bash rules of the guard engine: DEFENCE IN DEPTH (docs/AGENT-GUARD.md). They read the text of a command and refuse what it plainly does. They
 * are an arms race nobody wins (an alias, a function, a decoded string, an interpreter's inline code, a script written and run), so nothing
 * relies on them alone: the controls that hold regardless are the broker (the agent holds no deploy, merge, admin or secret credential), the
 * base-branch audit in CI, the ruleset, and the daemon's authentication. Every refusal here names the allowed path.
 */
import { ALLOW, base, deny, isSecretFile, locate, matchAny, re, secretHit } from "./common.js";
import { CANON_FILE } from "./registry.js";
import { SHELLS, gitCall, isKitDiagrams, isKitGenerator, realCommand, simpleCommands, writeTargets } from "./shell.js";

const SCOPE_GIT = new Set(["add", "commit", "push", "rm", "mv", "checkout", "switch", "restore", "reset", "merge", "rebase", "cherry-pick", "apply", "am", "stash", "clean", "tag", "branch", "revert", "pull", "update-ref", "config"]);
const INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "perl", "ruby", "php", "deno", "bun", "lua", "osascript"]);
const KILLERS = new Set(["kill", "pkill", "killall", "skill", "fuser"]);
const OBFUSCATE = /\b(base64\s+(-d|--decode|-D)|xxd\s+-r|openssl\s+(enc|base64)\b[^|;]*-d)\b/;
const READ_ONLY_HEADS = new Set(["ls", "stat", "test", "[", "file", "basename", "dirname", "realpath", "readlink", "rm", "mkdir"]);
const PROTECTED_EXTRA = [".git/hooks/**", ".git/config", ".git/info/**", ".git/config.worktree", ".claude/guard.*"];
/** The guard-tamper paths: the registry's protected globs, git's own hook and config files, and kit.canon.json (its vendor block). */
const guardGlobs = (reg) => [...reg.protected.globs, ...PROTECTED_EXTRA, CANON_FILE];
/** A path token that is an enforcement path, or a leading part of one (".claude", ".claude/hooks", ".claude/hooks/"), case-insensitive. */
const reachesEnforcement = (tok, reg) => {
  const globs = [...reg.protected.globs, ...PROTECTED_EXTRA], t = tok.toLowerCase();
  if (matchAny(tok, globs, true)) return true;
  return t.length >= 4 && globs.some((g) => { const lit = g.split("*")[0].toLowerCase(); return lit.startsWith(t) && (lit.length === t.length || lit[t.length] === "/" || t.endsWith("/")); });
};
/** Path-like words of inline code ("./.claude/hooks/x", 'kit.canon.json'), without a leading ./ */
const pathTokens = (code) => [...code.matchAll(/[A-Za-z0-9_.~\/-]*[A-Za-z0-9_~-][A-Za-z0-9_.~\/-]*/g)].map((m) => m[0].replace(/^(\.\/)+/, "")).filter((x) => x.includes("/") || x.includes("."));
const WRANGLER_READ = [[], ["whoami"], ["types"], ["dev"], ["tail"], ["login"], ["deployments", "list"], ["deployments", "status"], ["versions", "list"], ["versions", "view"], ["d1", "list"], ["d1", "info"], ["kv", "namespace", "list"], ["kv", "key", "get"], ["kv", "key", "list"], ["r2", "bucket", "list"], ["r2", "object", "get"]];
const abbrev = (w, long, min) => w.startsWith("--") && w.length >= min && long.startsWith(w);

const PROD_MSG = "An agent never deploys or changes production: the author is not the deployer. Open a pull request; the reviewed CI environment deploys (the broker performs declared actions).";
const CRED_MSG = "An agent never mints, rotates, revokes or sets a token, secret or deploy credential. Scoped deploy credentials are issued by the governed custody path (a decision before issuance, a record per issuance, an expiry, a revocation), never ad hoc; ask the owner.";
const MERGE_MSG = "An agent never merges or approves a pull request. The one path is the governed `merge` action of the broker (a separate component) (green CI on the exact head, a recorded independent review, evidence): `kit agent-guard broker merge <pr>`.";

/** `gh` without its global flags: { sub, args }. */
function ghCall(s) {
  if (base(s.words[0]) !== "gh") return null;
  let i = 1;
  while (i < s.words.length && s.words[i].startsWith("-")) i += ["-R", "--repo", "--hostname"].includes(s.words[i]) ? 2 : 1;
  return { sub: s.words[i] || "", args: s.words.slice(i + 1) };
}

/** HTTP method and whether the call writes, from curl, wget or gh api flags in any spelling. */
function httpWrite(ws) {
  let method = null, write = false;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    let m;
    if ((m = /^-X(.+)$/.exec(w))) method = m[1]; else if (w === "-X" || w === "--request" || w === "--method") method = ws[i + 1]; else if ((m = /^--(?:request|method)=(.+)$/.exec(w))) method = m[1];
    else if (/^(-d|--data(-[a-z]+)?|--json|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|-f|-F|--field|--raw-field|--input)(=.*)?$/.test(w) || /^-d./.test(w)) write = true;
  }
  const mm = String(method || "").toUpperCase();
  return { method: mm, write: write || (mm !== "" && !["GET", "HEAD", "OPTIONS"].includes(mm)) };
}

function githubEndpoint(path, write, bodyText, method) {
  if (!write) return null;
  if (/\/pulls\/\d+\/(merge|reviews)|\/merge\b/.test(path)) return deny("agent-merge", MERGE_MSG);
  if (/(\/rulesets|\/branches\/[^/]+\/protection|\/environments\/)/.test(path)) return deny("ruleset-tamper", "Rulesets, branch protection and environments are the owner's. An agent never changes them.");
  if (/\/(actions\/(secrets|variables)|dependabot\/secrets|codespaces\/secrets|orgs\/[^/]+\/(actions|dependabot)\/secrets)/.test(path)) return deny("agent-credential-mutation", CRED_MSG);
  if (/\/git\/refs\b|\/git\/(commits|trees)\b/.test(path) && (method === "DELETE" || /force"?\s*[:=]\s*true/.test(bodyText) || /\/git\/refs\/heads\/(main|master)/i.test(path))) return deny("git-force-push", "A forced, deleting or protected-branch ref update through the API is refused.");
  if (/\/(repos\/[^/]+\/[^/]+)$/.test(path) && method === "DELETE") return deny("ruleset-tamper", "Deleting a repository is not an agent action.");
  return null;
}

export function checkBash(cmd, payload, ctx) {
  const reg = ctx.registry;
  const sims = simpleCommands(cmd);
  const text = cmd;
  const generatorOnly = sims.length > 0 && sims.every((s) => isKitDiagrams(s) || isKitGenerator(s) || !s.words.length);
  const written = new Set(writeTargets(sims).map((t) => t.replace(/^\.\//, "")));
  const pkg = (() => { try { return JSON.parse(ctx.readFile(`${ctx.root}/package.json`) || "{}").scripts || {}; } catch { /* unparseable input counts as absent, never as a valid value */ return {}; } })();

  if (OBFUSCATE.test(text) && sims.some((s) => SHELLS.has(base(s.words[0] || "")) || ["eval", "source", "."].includes(s.words[0]))) return deny("obfuscated-execution", "A decoded string run as a command hides what it does. Run the command itself; the guard decides what it is.");
  const secretLit = secretHit(text, reg);
  if (secretLit) return deny("secret-literal", `The command contains a ${secretLit}. Never put a secret into a command; the platform supplies it from its environment.`);

  for (const s of sims) {
    const w = s.words, head = base(w[0] || "");
    const rc = realCommand(w);
    const joined = w.join(" ");
    if (head === "__shell_stdin__") return deny("obfuscated-execution", "A shell fed from a pipe or a download (`curl … | sh`) runs what the guard cannot read. Download, read, then run the script as a file.");
    if (head.startsWith("$") || /^\$\(|^`/.test(w[0] || "")) return deny("obfuscated-execution", "A command named by a variable hides what runs. Write the command out.");
    // scripts written and run in one command
    if (SHELLS.has(head) && w[1] && !w[1].startsWith("-") && written.has(w[1].replace(/^\.\//, ""))) return deny("obfuscated-execution", "A script written and run in the same command cannot be read before it runs. Write it, then run it in a separate step the guard can see.");
    // inline interpreters: what their code plainly reaches
    if (INTERPRETERS.has(head)) {
      const i = w.findIndex((x) => /^(-e|-c|-p|--eval|--print|-r|-E)$/.test(x));
      const code = i >= 0 ? w.slice(i + 1).join(" ") : "";
      if (code) {
        if (/(child_process|execSync|spawnSync|execFile|\bspawn\(|\bexec\(|os\.system|subprocess|popen|\bsystem\(|Deno\.(run|Command)|Bun\.spawn|backtick|`)/.test(code)) return deny("obfuscated-execution", "Inline code that starts commands hides them from the guard. Run the command itself.");
        if (/(process\.env|os\.environ|\bENV\[|getenv|environ)/.test(code)) return deny("secret-env-print", "Never print or enumerate the environment: it holds secrets.");
        // what the code reaches: main's enforcement pattern, and every path-like token that is an enforcement path or a prefix of one
        // (path.join('.claude/hooks', …), os.path.join, '.claude/hooks/' + …). Reading kit.canon.json is fine; tampering by other
        // routes is not chased here: the guard is tamper-evident and the server side (CI audit, merge gate) enforces
        if (/(\.claude\/|\.githooks|guard\.(addr|daemon|evidence)|\.git\/(hooks|config))/.test(code)) return deny("guard-tamper", "Inline code that reaches the enforcement files is refused. `kit agent-guard sync` is the only writer.");
        for (const tok of pathTokens(code)) if (reachesEnforcement(tok, reg)) return deny("guard-tamper", `Inline code that reaches ${tok} (enforcement) is refused. \`kit agent-guard sync\` is the only writer.`);
        if (/(\.env\b|\.dev\.vars|id_rsa|\.pem\b|\.npmrc)/i.test(code)) return deny("secret-file-read", "Inline code that reads a secret file is refused.");
        if (/api\.(cloudflare|github)\.com/.test(code)) return deny("agent-production-write", PROD_MSG);
      }
    }
    // guard bypass: the flags and variables that switch hooks off
    if (["claude", "codex"].includes(head)) for (const f of reg.protected.bypassFlags) if (w.some((x) => x === f || x.startsWith(`${f}=`) || abbrev(x, f, 7))) return deny("guard-bypass-flags", `\`${head} ${f}\` switches the project's hooks off or lifts the permission gate. Agents and loops start \`${head}\` with the repository's settings so the guard runs.`);
    const assigns = [...s.env, ...(["export", "declare", "typeset", "set", "setenv"].includes(head) ? w.slice(1).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) : [])];
    for (const e of assigns) {
      const name = e.split("=")[0];
      if (reg.protected.bypassEnv.includes(name)) return deny("guard-bypass-flags", `${name} switches Claude Code's hooks off; do not set it.`);
      if (reg.git.skipHookEnv.includes(name) || /^GIT_CONFIG/i.test(name)) return deny("git-skip-hooks", `${name} switches git hooks off or injects git configuration; fix the failing check instead.`);
    }
    // processes: nothing outlives its task
    { const wr = s.wrappers || [];
      const spawnsAgent = ["claude", "codex"].includes(head) && w.some((x) => x === "-p" || x === "--print" || x === "exec");
      const bounded = wr.includes("timeout") || w.some((x) => x === "--max-turns" || x.startsWith("--max-turns="));
      if (spawnsAgent && !bounded) return deny("unbounded-process", `\`${head} -p\` starts an agent that nothing bounds. Wrap it (\`timeout 1800 …\`) or pass --max-turns, so no orphan outlives its task.`);
      if ((wr.includes("nohup") || wr.includes("setsid") || head === "disown" || s.bg) && !wr.includes("timeout")) return deny("unbounded-process", "A detached or background process must run under `timeout N`, so it cannot become an orphan."); }
    // the guard itself
    if (KILLERS.has(head) && /(daemon\.mjs|agent-guard|guard\.(addr|daemon|evidence)|\.claude)/.test(s.raw)) return deny("guard-tamper", "Stopping the decision daemon is not an agent action: the hook holds every action while it is down, and `kit agent-guard daemon stop` is the owner's.");
    // git
    const g = gitCall(s);
    if (g) {
      const a = g.args, all = g.all;
      const hooksKey = (x) => /core\.hookspath/i.test(x);
      if (all.some((x) => x === "--no-verify" || abbrev(x, "--no-verify", 6)) || (g.sub === "commit" && a.some((x) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(x))) || g.config.some(hooksKey) || (g.sub === "config" && a.some(hooksKey))) return deny("git-skip-hooks", "Never skip git hooks (--no-verify in any spelling, commit -n, core.hooksPath). A failing hook is a failing check: fix its cause.");
      if (g.config.some((x) => /^(alias\.|include|core\.(fsmonitor|sshcommand|pager|editor)|credential\.|url\..*insteadof)/i.test(x)) || (g.sub === "config" && a.some((x) => /^(alias\.|include)/i.test(x)))) return deny("git-force-push", "A git alias or config include can hide a force-push or a skipped hook; configure git in the kit, not from an agent.");
      if (g.sub === "push") {
        const flags = a.filter((x) => x.startsWith("-"));
        const pos = a.filter((x) => !x.startsWith("-"));
        if (flags.some((f) => f === "--force" || abbrev(f, "--force", 5) || f.startsWith("--force-") || abbrev(f, "--mirror", 5) || abbrev(f, "--delete", 5) || (/^-[a-zA-Z]+$/.test(f) && /[fd]/.test(f.slice(1)) && !f.startsWith("--")))) return deny("git-force-push", "Never force-push, mirror-push or delete a remote ref. Push the branch normally; resolve divergence by merging.");
        if (flags.some((f) => abbrev(f, "--all", 4) || f === "--all")) return deny("git-protected-branch-push", "`git push --all` would push protected branches. Push the one branch you work on.");
        const refspecs = pos.slice(1);
        const prot = reg.git.protectedBranches.map((x) => x.toLowerCase());
        for (const r of refspecs) {
          if (r.startsWith("+")) return deny("git-force-push", `The refspec ${r} forces the update.`);
          if (r.startsWith(":")) return deny("git-force-push", `The refspec ${r} deletes a remote ref.`);
          const dst = (r.includes(":") ? r.split(":")[1] : r).replace(/^refs\//, "").replace(/^heads\//, "").toLowerCase();
          if (prot.includes(dst)) return deny("git-protected-branch-push", `Never push straight to ${dst}. Push your branch and open a pull request.`);
        }
        if (!refspecs.length) { const b = ctx.branch(); if (b && reg.git.protectedBranches.includes(b)) return deny("git-protected-branch-push", `The current branch is ${b}: never push straight to it. Work on a branch and open a pull request.`); }
      }
      if (["update-ref", "fast-import", "send-pack", "replace", "filter-branch", "filter-repo"].includes(g.sub)) {
        const prot = reg.git.protectedBranches.map((x) => x.toLowerCase());
        if (g.sub !== "update-ref" || a.includes("-d") || a.some((x) => prot.includes(x.replace(/^refs\/heads\//, "").toLowerCase()))) return deny("git-protected-branch-push", `git ${g.sub} writes refs behind the guard's back; a protected branch is changed only through a reviewed pull request.`);
      }
      if (g.sub === "branch" && a.some((x) => /^-[a-zA-Z]*[fdDmM]/.test(x)) && a.some((x) => reg.git.protectedBranches.includes(x))) return deny("git-protected-branch-push", "A protected branch is not moved, renamed or deleted by an agent.");
    }
    // gh
    const gh = ghCall(s);
    if (gh) {
      const a = gh.args;
      if (gh.sub === "pr" && (a[0] === "merge" || (a[0] === "review" && a.some((x) => x === "--approve" || /^-[a-z]*a/.test(x))))) return deny("agent-merge", MERGE_MSG);
      if ((gh.sub === "secret" || gh.sub === "variable") && ["set", "delete", "remove"].includes(a[0])) return deny("agent-credential-mutation", CRED_MSG);
      if (gh.sub === "repo" && ["delete", "edit", "archive", "rename", "transfer"].includes(a[0])) return deny("ruleset-tamper", "Repository administration is the owner's.");
      if (gh.sub === "ruleset") return deny("ruleset-tamper", "Rulesets are the owner's.");
      if (gh.sub === "api") {
        const h = httpWrite(a);
        const endpoint = a.find((x, i) => !x.startsWith("-") && x !== "api" && !/^(GET|POST|PUT|PATCH|DELETE)$/i.test(x) && !["-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "--input", "-q", "--jq", "-t", "--template"].includes(a[i - 1] || ""));
        const q = a.join(" ");
        if (endpoint === "graphql" || /graphql/.test(q)) {
          if (/mutation[^}]*\b(mergePullRequest|enablePullRequestAutoMerge|addPullRequestReview|submitPullRequestReview|approvePullRequest)/i.test(q)) return deny("agent-merge", MERGE_MSG);
          if (/mutation[^}]*\b(updateRef|deleteRef|createRef|updateBranchProtection|createBranchProtectionRule|deleteBranchProtectionRule|createRepositoryRuleset|deleteRepositoryRuleset|addSecret|deleteEnvironment)/i.test(q)) return deny("ruleset-tamper", "Refs, branch protection, rulesets and secrets are not changed by an agent, by REST or by GraphQL.");
        }
        const d = githubEndpoint(String(endpoint || ""), h.write || h.method !== "", q, h.method);
        if (d) return d;
      }
    }
    // http clients
    if (["curl", "wget", "http", "https", "xh", "fetch"].includes(head)) {
      const h = httpWrite(w);
      const url = w.find((x) => /^https?:\/\//.test(x)) || "";
      let u = null; try { u = new URL(url); } catch { /* an invalid value is reported as not matching, never accepted */ }
      if (u && h.write) {
        if (u.hostname === "api.cloudflare.com") return deny(/\/(user|accounts\/[^/]+)\/tokens/.test(u.pathname) ? "agent-credential-mutation" : "agent-production-write", /\/tokens/.test(u.pathname) ? CRED_MSG : PROD_MSG);
        if (u.hostname === "api.github.com") { const d = githubEndpoint(u.pathname, true, joined, h.method); if (d) return d; }
      }
      if (u && u.hostname === "api.cloudflare.com" && /\/(user|accounts\/[^/]+)\/tokens/.test(u.pathname)) return deny("agent-credential-mutation", CRED_MSG);
    }
    // wrangler (any runner) and the scripts that run it: default deny, a short allow-list of read-only verbs
    if (rc.head === "wrangler") {
      const verbs = rc.args.filter((x) => !x.startsWith("-"));
      const ok = WRANGLER_READ.some((p) => p.every((v, i) => verbs[i] === v) && (p.length || verbs.length === 0)) && !rc.args.some((x) => x === "--remote" || x.startsWith("--remote="));
      if (!ok || /\bsecret/.test(joined)) return deny(/\bsecret/.test(joined) ? "agent-credential-mutation" : "agent-production-write", /\bsecret/.test(joined) ? CRED_MSG : PROD_MSG);
    }
    if (["npm", "pnpm", "yarn", "bun", "make", "just"].includes(head)) {
      const name = head === "make" || head === "just" ? w.slice(1).find((x) => !x.startsWith("-")) : (w[1] === "run" || w[1] === "run-script" ? w[2] : (["pnpm", "yarn", "bun"].includes(head) ? w[1] : null));
      const dry = name && /^(?:npx\s+)?wrangler\s+(?:deploy|publish|versions upload)\b[^&;|`$]*--dry-run\b[^&;|`$]*$/.test(pkg[name] || "");
      if (name && !dry && (/^(deploy|publish|release|ship|migrate:remote|db:migrate:remote)/i.test(name) || /\b(wrangler (deploy|publish|pages|versions deploy|secret|d1 (execute|migrations))|kit purge)\b/.test(pkg[name] || ""))) return deny("agent-production-write", PROD_MSG);
    }
    // diagrams: other renderers
    if (!isKitDiagrams(s)) {
      const lw = [rc.head, ...rc.args].join(" ").toLowerCase();
      for (const r of reg.diagrams.foreignRenderers) if (lw.includes(r.toLowerCase()) || joined.toLowerCase().includes(r.toLowerCase())) return deny("diagram-foreign-renderer", `\`${r}\` is not how this project draws diagrams. Render with \`kit diagrams render\` (bundled Mermaid, local Chromium, the project's theme, the header, the index).`);
      if (/\bmermaid\b/i.test(joined) && /(screenshot|puppeteer|playwright|chromium|\.png)/i.test(joined)) return deny("diagram-foreign-renderer", "A hand-rolled Mermaid render is not allowed; use `kit diagrams render`.");
    }
    // secrets: any argument or input that is a secret file, whatever the command; environment dumps
    const args = w.slice(1);
    if (!READ_ONLY_HEADS.has(head)) for (const a of [...args, ...(s.inputs || [])]) if (!a.startsWith("-") && isSecretFile(base(a), reg)) return deny("secret-file-read", `${a} holds secrets; never read it into the conversation. Name the variable the code needs, or ask the owner.`);
    if (/\/proc\/(self|\d+|\$\$)\/environ/.test(joined) || (s.inputs || []).some((x) => /\/proc\/[^/]+\/environ/.test(x))) return deny("secret-env-print", "The process environment holds secrets.");
    const sn = re(reg.secrets.envNames, "i");
    if (head === "printenv" && (args.length === 0 || args.some((x) => sn?.test(x)))) return deny("secret-env-print", "Never print the environment or a variable that holds a secret.");
    if ((head === "env" && w.length === 1) || (["export", "declare", "typeset"].includes(head) && (args.length === 0 || args.some((x) => x === "-p" || x === "-x" || x === "-f"))) || (head === "set" && args.length === 0) || head === "compgen" || (head === "env" && !args.some((x) => !x.startsWith("-") && !/=/.test(x)))) return deny("secret-env-print", "Never dump the environment: it holds secrets.");
    if (["echo", "printf", "print", "cat", "rev", "base64", "tee"].includes(head) || s.herestring) for (const x of [...args, s.herestring || ""]) for (const m of x.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) if (sn?.test(m[1])) return deny("secret-env-print", `Printing $${m[1]} would put a secret into the conversation.`);
    // approvals
    for (const c of reg.protected.approvalCommands || []) if (joined.includes(c)) return deny("agent-approval-write", `\`${c}\` records a human approval; an agent never runs it.`);
    // credentials
    if ((head === "gh" && gh && (gh.sub === "secret" || gh.sub === "variable") && !["list", "get"].includes(gh.args[0]))) return deny("agent-credential-mutation", CRED_MSG);
  }
  // writes by command: protected paths, generated files, diagram images (real paths, case-insensitive)
  if (!generatorOnly) {
    for (const t of writeTargets(sims)) {
      const loc = locate(t, ctx, payload); if (!loc || !loc.inside) continue; const rel = loc.rel;
      if (matchAny(rel, guardGlobs(reg).filter((g) => g !== CANON_FILE), true)) return deny("guard-tamper", `${rel} carries the enforcement; a shell write to it is refused. \`kit agent-guard sync\` is the only writer.`);
      if (matchAny(rel, reg.protected.approvalGlobs || [], true)) return deny("agent-approval-write", `${rel} is a ledger of human approvals; an agent never writes one.`);
      if (matchAny(rel, reg.generated.globs, true)) return deny("generated-hand-edit", `${rel} is generated; run its generator, never write it from the shell.`);
      if (matchAny(rel, [CANON_FILE], true)) return deny("guard-tamper", `${rel} holds the "vendor" block that places the vendored kit snapshot; a shell write cannot be checked for it. Edit the file with the editor tool (other keys only).`);
      if (matchAny(rel, reg.diagrams.imageGlobs, true)) return deny("diagram-image-handwritten", `${rel}: only \`kit diagrams render\` writes diagram images.`);
    }
  }
  return null;
}

export { SCOPE_GIT, ALLOW };
