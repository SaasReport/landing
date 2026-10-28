/**
 * A small, quote-aware reading of a shell command line for the guard engine (docs/AGENT-GUARD.md). Zero dependencies: the hook runs from a
 * vendored snapshot with nothing installed.
 *
 *   simpleCommands(cmd) → [{ words, env, redirects, inputs, wrappers, bg, raw }]   every simple command, including those inside $( ), backticks,
 *      `bash -c '…'`, `eval`, heredocs and here-strings fed to a shell, `echo … | sh`, and behind env / sudo / timeout / nohup / npx / pnpm dlx / bunx
 *
 * HONEST LIMIT, and the reason this is only defence in depth: this is a reading of text, not a shell. An alias, a function, a variable that holds a
 * command, a script written and run, an interpreter's inline code, a decoded string, a symlink: text can always hide what it will do. The controls
 * that hold regardless are elsewhere (the agent holds no credentials; the broker acts; the base-branch audit runs in CI).
 */
const SEP = new Set([";", "&", "|", "\n"]);
const WRAPPERS = new Set(["sudo", "command", "time", "nohup", "exec", "env", "nice", "ionice", "stdbuf", "setsid", "doas", "chronic", "unbuffer"]);
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time"]);
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"]);
const base = (w) => (w || "").split("/").pop();
const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === "(") depth++; else if (s[i] === ")") { depth--; if (!depth) return i; } }
  return s.length - 1;
}

/** Split one logical line into segments (text, separator after it) and collect substitutions. */
function scan(cmd) {
  const segments = [], subs = [];
  let cur = "", q = null, i = 0;
  const push = (sep) => { if (cur.trim()) segments.push({ text: cur, sep }); cur = ""; };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\\" && q !== "'") { cur += c + (cmd[i + 1] ?? ""); i += 2; continue; }
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === "$" && cmd[i + 1] === "(") { const end = matchParen(cmd, i + 1); subs.push(cmd.slice(i + 2, end)); }
      else if (q === '"' && c === "`") { const end = cmd.indexOf("`", i + 1); if (end > 0) subs.push(cmd.slice(i + 1, end)); }
      cur += c; i++; continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; i++; continue; }
    if (c === "$" && cmd[i + 1] === "(") { const end = matchParen(cmd, i + 1); subs.push(cmd.slice(i + 2, end)); cur += cmd.slice(i, end + 1); i = end + 1; continue; }
    if (c === "<" && cmd[i + 1] === "(" || c === ">" && cmd[i + 1] === "(") { const end = matchParen(cmd, i + 1); subs.push(cmd.slice(i + 2, end)); cur += cmd.slice(i, end + 1); i = end + 1; continue; }   // process substitution
    if (c === "`") { const end = cmd.indexOf("`", i + 1); if (end > 0) { subs.push(cmd.slice(i + 1, end)); cur += cmd.slice(i, end + 1); i = end + 1; continue; } }
    if (c === "(" || c === ")" || c === "{" || c === "}") { push(c === ")" ? ";" : ";"); i++; continue; }
    if (SEP.has(c)) {
      if (c === ">" ) { cur += c; i++; continue; }
      if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">" || cmd[i - 1] === "<")) { cur += c; i++; continue; }
      if ((c === "&" || c === "|") && cmd[i + 1] === c) { push(c + c); i += 2; continue; }       // && and ||
      if (c === "|" && cmd[i + 1] === "&") { push("|"); i += 2; continue; }
      push(c); i++; continue;
    }
    cur += c; i++;
  }
  push(";");
  return { segments, subs };
}

/** Words of one segment with quotes removed (`"wrang""ler"` and `W\\rangler` both read as wrangler). */
export function words(seg) {
  const out = [];
  let cur = "", q = null, has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "\\" && q !== "'") { cur += seg[++i] ?? ""; has = true; continue; }
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** The command a package runner really starts: npx wrangler@3, pnpm dlx wrangler, bunx wrangler, yarn wrangler, npm exec -- wrangler, node_modules/.bin/wrangler, node …/wrangler.js. */
export function realCommand(ws) {
  let w = ws.slice();
  const bin = (x) => base(x).replace(/@[^/@]+$/, "").replace(/\.(m?js|cjs)$/, "");
  for (let guard = 0; guard < 4 && w.length; guard++) {
    const h = base(w[0]);
    if (["npx", "bunx", "pnpx"].includes(h)) { let i = 1; while (i < w.length && (w[i].startsWith("-") || false)) { if (["-p", "--package", "-c"].includes(w[i])) i += 2; else i++; } w = w.slice(i); continue; }
    if (["pnpm", "yarn", "bun"].includes(h)) { let i = 1; if (["dlx", "exec", "x", "run"].includes(w[i])) i++; while (i < w.length && w[i].startsWith("-")) i++; if (i === 1 && h === "yarn" || i > 1 || ["pnpm", "bun"].includes(h)) { w = w.slice(i); continue; } }
    if (h === "npm" && ["exec", "x"].includes(w[1])) { let i = 2; while (i < w.length && w[i].startsWith("-")) i++; w = w.slice(i); continue; }
    if (h === "node" && w[1] && /(^|\/)(node_modules\/[^/]+\/|\.bin\/)/.test(w[1])) { w = [w[1].split("/").filter((p, k, a) => k === a.length - 3 && a[k - 1] === "node_modules" ? true : false)[0] || base(w[1]).replace(/\.(m?js|cjs)$/, ""), ...w.slice(2)]; continue; }
    break;
  }
  if (!w.length) return { head: "", args: [] };
  return { head: bin(w[0]), args: w.slice(1) };
}

/** One segment → { words, env, redirects, inputs, wrappers, herestring }. */
function simple(seg, sep) {
  const all = words(seg);
  const env = [], redirects = [], inputs = [], rest = [];
  let herestring = null, seenCmd = false;
  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    if (w === "<<<" ) { herestring = all[i + 1] ?? ""; i++; continue; }
    if (/^\d*<<-?$/.test(w)) { i++; continue; }
    if (/^\d*<<-?\S/.test(w)) continue;
    const inp = /^\d*<(?!<)(.*)$/.exec(w);
    if (inp) { const t = inp[1] || all[++i] || ""; if (t) inputs.push(t); continue; }
    const m = /^(?:\d*|&)(>>?|>\|)(.*)$/.exec(w);
    if (m) {
      const target = m[2] || all[++i] || "";
      if (target && !/^&?\d*-?$/.test(target) && target !== "/dev/null" && !target.startsWith("&")) redirects.push(target);
      continue;
    }
    if (!seenCmd && isAssign(w)) { env.push(w); continue; }
    seenCmd = true;
    rest.push(w);
  }
  let ws = rest;
  const wrappers = [];
  while (ws.length && KEYWORDS.has(ws[0])) ws = ws.slice(1);
  for (let guard = 0; guard < 8 && ws.length; guard++) {
    const head = base(ws[0]);
    if (head === "timeout") { wrappers.push("timeout"); ws = ws.slice(1); while (ws.length && /^-/.test(ws[0])) ws = ws.slice(ws[0] === "-k" || ws[0] === "-s" ? 2 : 1); ws = ws.length ? ws.slice(1) : ws; continue; }
    if (WRAPPERS.has(head)) {
      wrappers.push(head);
      ws = ws.slice(1);
      while (ws.length && (/^-/.test(ws[0]) || isAssign(ws[0]))) { if (isAssign(ws[0])) env.push(ws[0]); ws = ws.slice(1); }
      continue;
    }
    break;
  }
  if (!ws.length && rest.length && base(rest[0]) === "env") ws = ["env"];   // a bare `env` dumps the environment: keep it visible
  return { words: ws, env, redirects, inputs, wrappers, bg: sep === "&", herestring, raw: seg.trim() };
}

/** Heredoc bodies: [{ line (logical line text without the body), docs: [body] }]. */
function logicalLines(cmd) {
  const lines = cmd.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const docs = [];
    const re = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
    let m, tags = [];
    while ((m = re.exec(line)) && !/<<</.test(line.slice(m.index, m.index + 3))) tags.push(m[3]);
    for (const tag of tags) { const body = []; i++; while (i < lines.length && lines[i].trim() !== tag) body.push(lines[i++]); docs.push(body.join("\n")); }
    out.push({ line, docs });
  }
  return out;
}

/** Every simple command in the text, recursing into substitutions, shells, eval, heredocs and pipes into a shell. */
export function simpleCommands(cmd, depth = 0) {
  if (depth > 5 || !cmd) return [];
  const out = [];
  for (const { line, docs } of logicalLines(cmd)) {
    const { segments, subs } = scan(line);
    let prev = null, prevSep = ";";
    for (const seg of segments) {
      const s = simple(seg.text, seg.sep);
      if (s.words.length || s.redirects.length || s.env.length || s.inputs.length) out.push(s);
      const head = base(s.words[0] || "");
      const shellFile = SHELLS.has(head) && !s.words.some((w) => /^-[a-z]*c$/.test(w)) && s.words.slice(1).every((w) => w.startsWith("-"));   // a shell reading its script from stdin
      if (SHELLS.has(head)) {
        const i = s.words.findIndex((w) => /^-[a-z]*c$/.test(w));
        if (i >= 0) { let k = i + 1; while (s.words[k] === "--") k++; if (s.words[k]) out.push(...simpleCommands(s.words[k], depth + 1)); }
        if (shellFile && s.herestring) out.push(...simpleCommands(s.herestring, depth + 1));
        if (shellFile && docs.length) for (const d of docs) out.push(...simpleCommands(d, depth + 1));
        const piped = shellFile && prev && prevSep === "|" && ["echo", "printf"].includes(base(prev.words[0] || ""));
        if (piped) out.push(...simpleCommands(prev.words.slice(1).filter((w) => !w.startsWith("-")).join(" "), depth + 1));
        if (shellFile && !piped && !s.herestring && !docs.length && !s.inputs.length) out.push({ words: ["__shell_stdin__"], env: [], redirects: [], inputs: [], wrappers: [], bg: false, raw: s.raw });   // a shell fed by something the text does not show (curl | sh, cat x | bash)
      }
      if (head === "eval" && s.words[1]) out.push(...simpleCommands(s.words.slice(1).join(" "), depth + 1));
      if (head === "xargs" || head === "find" && s.words.includes("-exec")) {
        const k = head === "xargs" ? s.words.slice(1).filter((w) => !/^-/.test(w)) : s.words.slice(s.words.indexOf("-exec") + 1).filter((w) => w !== ";" && w !== "\;" && w !== "{}" && w !== "+");
        if (k.length) out.push(...simpleCommands(k.join(" "), depth + 1));
      }
      prev = s; prevSep = seg.sep;
    }
    for (const sub of subs) out.push(...simpleCommands(sub, depth + 1));
  }
  return out;
}

/** Files a command writes or changes, as far as its text shows: redirects, tee, cp/mv/install/ln, rm, touch, chmod, sed -i, dd of=, curl -o, wget -O. */
export function writeTargets(simples) {
  const out = [];
  for (const s of simples) {
    out.push(...s.redirects);
    const [h, ...a] = s.words; const head = base(h);
    const args = a.filter((w) => !/^-/.test(w));
    if (head === "tee") out.push(...args);
    else if (["cp", "mv", "install", "ln"].includes(head)) { if (args.length) out.push(args[args.length - 1]); if (head === "mv") out.push(...args.slice(0, -1)); }
    else if (["rm", "rmdir", "touch", "truncate", "unlink", "shred", "chattr"].includes(head)) out.push(...args);
    else if (["chmod", "chown", "chgrp"].includes(head)) out.push(...args.slice(1));
    else if (head === "sed" && a.some((w) => /^-[A-Za-z]*i/.test(w) || w === "--in-place")) out.push(...args.slice(1));
    else if (head === "perl" && a.some((w) => /^-[A-Za-z]*i/.test(w))) out.push(...args.slice(1));
    else if (head === "dd") out.push(...a.filter((w) => w.startsWith("of=")).map((w) => w.slice(3)));
    else if (head === "curl") { for (let i = 0; i < a.length; i++) if (a[i] === "-o" || a[i] === "--output") out.push(a[i + 1]); }
    else if (head === "wget") { for (let i = 0; i < a.length; i++) if (a[i] === "-O") out.push(a[i + 1]); }
    else if (head === "git" && a.includes("--file")) out.push(a[a.indexOf("--file") + 1]);
    else if (head === "rsync") { if (args.length) out.push(args[args.length - 1]); }
    else if (head === "sponge") out.push(...args);
    else if (head === "git") {
      // git checkout/restore write the working-tree paths they name: everything after "--", or every non-option word (a ref is harmless here)
      const g = gitCall(s);
      // (git restore --staged without --worktree/-W writes only the index)
      // only an exact --staged or -S is index-only; --worktree in any abbreviation git accepts (--w…), or -W, writes the working tree
      const worktree = (w) => (w.length >= 3 && "--worktree".startsWith(w)) || /^-[A-Za-z]*W/.test(w);
      const indexOnly = g?.sub === "restore" && g.args.some((w) => w === "--staged" || w === "-S") && !g.args.some(worktree);
      if (g && ["checkout", "restore"].includes(g.sub) && !indexOnly) { const dd = g.args.indexOf("--"); out.push(...(dd >= 0 ? g.args.slice(dd + 1) : g.args.filter((w) => !/^-/.test(w)))); }
    }
  }
  return out.filter(Boolean);
}

/** `git [-C d] [-c k=v] <sub> args` → { sub, args, all, config } or null. `config`: every -c key given. */
export function gitCall(s) {
  if (base(s.words[0]) !== "git") return null;
  let i = 1; const config = [];
  while (i < s.words.length) {
    const w = s.words[i];
    if (w === "-c") { config.push(s.words[i + 1] || ""); i += 2; continue; }
    if (w === "-C" || w === "--git-dir" || w === "--work-tree" || w === "--namespace") { i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace|exec-path)=/.test(w) || w === "--no-pager" || w === "-p" || w === "--paginate" || w === "--bare") { i++; continue; }
    break;
  }
  return { sub: s.words[i] || "", args: s.words.slice(i + 1), all: s.words, config };
}

/** Is this simple command `kit diagrams <render|derive|migrate|theme>` (the kit CLI by any path)? */
export function isKitDiagrams(s) {
  const w = s.words;
  const k = w.findIndex((x) => ["kit", "kit.js"].includes(base(x)));
  return k >= 0 && w[k + 1] === "diagrams" && ["render", "derive", "migrate", "theme"].includes(w[k + 2]);
}

/** Is this simple command `kit agent-guard sync|…` or `kit claude sync` (the generators allowed to write .claude/)? */
export function isKitGenerator(s) {
  const w = s.words;
  const k = w.findIndex((x) => ["kit", "kit.js"].includes(base(x)));
  return k >= 0 && ((w[k + 1] === "agent-guard" && w[k + 2] === "sync") || (w[k + 1] === "claude" && w[k + 2] === "sync") || (w[k + 1] === "vendor" && w[k + 2] === "sync"));
}
