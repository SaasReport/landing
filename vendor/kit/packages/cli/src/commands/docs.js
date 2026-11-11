/**
 * kit docs export-view <file.md> --out <dir> [--base-url <url>] [--max-image-kb n] [--max-total-kb n]
 *     a self-contained copy of a Markdown file for a viewer that cannot load relative images or draw Mermaid (the mobile app):
 *     images inlined as base64 data URIs (an image used twice is written once as a reference definition), each Mermaid block kept
 *     as image first + collapsed source (as ```text). With --base-url (https://github.com/<org>/<repo>/blob/<sha>) images become
 *     absolute URLs instead, for a PR body. There is no warning level: a missing image, one outside the repository, one over
 *     --max-image-kb (default 1000 per image) or --max-total-kb (default 8000 in all), a <picture>/srcset, a relative link to
 *     another Markdown file or a Mermaid block without its pairing is an error and nothing is written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CliError, onlyFlags } from "../args.js";
import { exportView, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES } from "../export-view.js";

export async function docs(io, { _: [sub, file, ...extra], flags }) {
  if (sub !== "export-view") throw new CliError(`unknown docs command "${sub ?? ""}" (export-view <file.md> --out <dir>)`);
  onlyFlags(flags, ["out", "base-url", "max-image-kb", "max-total-kb", "cwd", "config"], "kit docs export-view");
  if (!file || !flags.out || extra.length) throw new CliError("usage: kit docs export-view <file.md> --out <dir> [--base-url <url>] [--max-image-kb n] [--max-total-kb n]");
  const kb = (name, dflt) => { if (flags[name] == null) return dflt; const n = Number(flags[name]); if (!(n > 0)) throw new CliError(`--${name} must be a positive number of kilobytes`); return n * 1000; };
  const r = exportView(io.cwd, file, { baseUrl: flags["base-url"] ? String(flags["base-url"]) : null, maxImageBytes: kb("max-image-kb", MAX_IMAGE_BYTES), maxTotalBytes: kb("max-total-kb", MAX_TOTAL_BYTES) });
  for (const p of r.problems) io.err(`  ${file}: ${p}`);
  if (r.problems.length) { io.err(`kit docs export-view: ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}; nothing written`); return 1; }
  const dir = resolve(io.cwd, String(flags.out));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, basename(file));
  writeFileSync(out, r.text);
  io.out(`wrote ${out} (${(r.bytes / 1000).toFixed(0)} KB, ${r.images.length} image${r.images.length === 1 ? "" : "s"} ${flags["base-url"] ? "as URLs" : "inlined"})`);
  return 0;
}
