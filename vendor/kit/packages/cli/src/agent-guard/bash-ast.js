/**
 * Bash read as bash: the canonical parser (tree-sitter-bash through web-tree-sitter, the grammar of @vscode/tree-sitter-wasm), never a regex over
 * the text. Used where a check must know what a script DOES: whether a command in a workflow step can fail the step.
 *
 * The parser is loaded once, at import (top-level await); a kit without it installed reports `bashAvailable() === false`, and the check that needs it
 * FAILS (it never passes unread).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let parser = null, loadError = null;
try {
  const { Parser, Language } = await import("web-tree-sitter");
  const require = createRequire(import.meta.url);
  await Parser.init();
  const lang = await Language.load(readFileSync(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm")));
  parser = new Parser(); parser.setLanguage(lang);
} catch (e) { loadError = e; }

export const bashAvailable = () => parser !== null;
export const bashLoadError = () => (loadError ? String(loadError.message || loadError) : null);
const parse = (text) => { if (!parser) throw new Error(`the bash parser is not installed (${bashLoadError()})`); return parser.parse(text).rootNode; };

/** The literal words of a command (assignments and redirects aside), or null when a word is built at run time (an expansion, a substitution). */
function literalArgv(cmd) {
  const out = [];
  for (const c of cmd.namedChildren) {
    if (c.type === "variable_assignment" || c.type === "file_redirect" || c.type === "heredoc_redirect" || c.type === "comment") continue;
    const w = c.type === "command_name" ? c.namedChildren[0] : c;
    if (!w) return null;
    if (w.type === "word" || w.type === "number") out.push(w.text);
    else if (w.type === "raw_string") out.push(w.text.slice(1, -1));
    else if (w.type === "string" && w.namedChildren.every((x) => x.type === "string_content")) out.push(w.text.slice(1, -1));
    else return null;
  }
  return out;
}

/** The commands of a top-level statement whose failure IS the statement's failure: the statement itself, or the members of a chain joined only by `&&`. Else null. */
function chainCommands(node) {
  if (node.type === "command") return [node];
  if (node.type === "redirected_statement") { const b = node.childForFieldName("body"); return b ? chainCommands(b) : null; }
  if (node.type === "list") {
    if (node.children.some((c) => !c.isNamed && c.type !== "&&")) return null;      // ||  &  ;  anything that can hide a failure
    const parts = node.namedChildren.map(chainCommands);
    return parts.some((p) => p === null) ? null : parts.flat();
  }
  return null;                                                              // a pipeline, if, loop, case, subshell, group, function, negation, ...
}

/** `kit agent-guard bench` with `--check` and no `--only`: the argv, as a node run of kit.js, of the site's bootstrap kit.mjs (the kit at its head, docs/FRESHNESS.md) or the kit command. */
const isBenchCheck = (argv) => {
  if (!argv) return false;
  const i = argv[0] === "node" && /(^|\/)kit\.m?js$/.test(argv[1] || "") ? 2 : argv[0] === "kit" ? 1 : -1;
  return i > 0 && argv[i] === "agent-guard" && argv[i + 1] === "bench" && argv.includes("--check") && !argv.some((a) => a === "--only" || a.startsWith("--only="));
};

export const NO_BENCH_COMMAND = "no top-level command is `kit agent-guard bench --check` (literal words, no --only)";
/** True when the script runs the bench with --check ANYWHERE (even where it cannot fail the step): the commands of the whole tree, read as bash. */
export const mentionsBenchCheck = (script) => parse(script).descendantsOfType("command").some((c) => isBenchCheck(literalArgv(c)));
/**
 * Why this script cannot be relied on to FAIL its step when the bench fails, or null when it can. The bench must be a top-level command (or a member of
 * an `&&` chain) of the script's LAST statement: not behind `||`, `;`, `&` or a pipe, not inside an if, loop, group or subshell, not followed by another
 * statement (a `set +e` or a later command could swallow its exit code), and not backgrounded.
 */
export function benchCheckProblem(script) {
  const root = parse(script);
  if (root.hasError) return "the script does not parse as bash";
  const stmts = root.namedChildren.filter((n) => n.type !== "comment");
  if (!stmts.length) return "the script is empty";
  const last = stmts[stmts.length - 1];
  if (last.nextSibling?.type === "&") return "the bench is started in the background (&): its exit code is never read";
  const cmds = chainCommands(last);
  if (!cmds) return `the last statement is a ${last.type.replace(/_/g, " ")}, not a plain command or && chain: the bench's exit code can be hidden`;
  if (!cmds.some((c) => isBenchCheck(literalArgv(c)))) {
    const inner = stmts.slice(0, -1).some((s) => s.descendantsOfType("command").some((c) => isBenchCheck(literalArgv(c))));
    return inner ? "the bench is not the script's last statement: a later command or `set +e` can swallow its exit code" : NO_BENCH_COMMAND;
  }
  return null;
}
