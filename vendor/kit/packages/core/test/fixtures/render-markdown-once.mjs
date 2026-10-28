// Child process for markdown-progress.test.mjs: renders the inputs given as JSON on argv[2]; with argv[3] === "html" it also
// prints the HTML. A renderer that does not terminate cannot be stopped from inside its own process, so the test runs it here
// under a timeout.
import { renderMarkdown } from "../../src/markdown.js";
const inputs = JSON.parse(process.argv[2]);
const html = [];
let done = 0;
for (const md of inputs) { const r = renderMarkdown(md); if (typeof r.html === "string") { done++; if (process.argv[3] === "html") html.push(r.html); } }
console.log(JSON.stringify({ done, of: inputs.length, ...(process.argv[3] === "html" ? { html } : {}) }));
