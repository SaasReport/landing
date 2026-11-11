// Writes the generated lifecycle diagrams (two views) into docs/diagrams/upload-lifecycle*.mmd and the paired blocks of docs/UPLOADS.md (header lines kept).
import { readFileSync, writeFileSync } from "node:fs";
import { lifecycleMermaid } from "../src/lifecycle-diagram.js";

const root = new URL("../../../", import.meta.url);
const VIEWS = [
  { view: "review", file: "docs/diagrams/upload-lifecycle.mmd", block: "kit.docs.uploads.3", png: "upload-lifecycle.png", title: "Upload lifecycle: review and retention" },
  { view: "disposal", file: "docs/diagrams/upload-lifecycle-disposal.mmd", block: "kit.docs.uploads.5", png: "upload-lifecycle-disposal.png", title: "Upload lifecycle: deletion" },
  { view: "intake", file: "docs/diagrams/upload-lifecycle-intake.mmd", block: "kit.docs.uploads.4", png: "upload-lifecycle-intake.png", title: "Upload lifecycle: intake and rollback" },
];
let md = readFileSync(new URL("docs/UPLOADS.md", root), "utf8");
for (const v of VIEWS) {
  const body = lifecycleMermaid(v.view);
  const path = new URL(v.file, root);
  const head = readFileSync(path, "utf8").split("\n").slice(0, 2);
  writeFileSync(path, `${head.join("\n")}\n${body}\n`);
  const header = head[1].replace(/"id":"[^"]*"/, `"id":"${v.block}"`);
  const block = `![${v.title} (${v.block})](diagrams/${v.png})\n\n<details><summary>Mermaid source (${v.block})</summary>\n\n\`\`\`mermaid\n${head[0]}\n${header}\n${body}\n\`\`\`\n\n</details>\n`;
  const at = md.indexOf(`"id":"${v.block}"`);
  if (at < 0) throw new Error(`docs/UPLOADS.md has no block ${v.block}: add its marker once (see the other blocks)`);
  const start = md.lastIndexOf(`![`, at), end = md.indexOf("</details>\n", at) + "</details>\n".length;
  md = md.slice(0, start) + block + md.slice(end);
}
writeFileSync(new URL("docs/UPLOADS.md", root), md);
console.log("wrote", VIEWS.length, "views");
