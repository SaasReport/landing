// The multi-select chip group of the landing's forms (control: "chips"): a fieldset with a legend and one native
// checkbox per option, every chip the same size; the options come from the config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSite, checkProject } from "../src/index.js";

const SAMPLE = fileURLToPath(new URL("../../../examples/site-sample/", import.meta.url));
const sample = (await import(`${SAMPLE}site.config.js`)).default;

test("chips: fieldset + legend, one checkbox per configured option, equal-width wrapping chips", () => {
  const en = structuredClone(sample.content.en);
  en.modals[0].fields.push({ name: "stack", label: "How you will use it", full: true, control: "chips", options: ["API", "SDK", "CLI", "Webhooks", "MCP"] });
  const project = { ...sample, content: { ...sample.content, en } };
  assert.deepEqual(checkProject(project), []);
  const { files } = buildSite(project, { root: SAMPLE, write: false });
  const html = files["index.html"];
  const group = html.match(/<fieldset class="f fchips f--full" data-chips="stack">[\s\S]*?<\/fieldset>/)?.[0];
  assert.ok(group, "a fieldset, not a label around a group");
  assert.match(group, /<legend>How you will use it<\/legend>/);
  assert.deepEqual([...group.matchAll(/<input type="checkbox" name="stack" value="([^"]+)">/g)].map((m) => m[1]), ["API", "SDK", "CLI", "Webhooks", "MCP"]);
  assert.doesNotMatch(group, /role="radio|type="radio"/);
  assert.match(files["styles.css"], /\.fchips__opts\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(104px,1fr\)\)/);
  assert.match(files["styles.css"], /\.fchips__o span\{[^}]*min-height:44px/);
});

test("a required chip group: the first checkbox carries the group's validity until one option is checked (shell.js)", async () => {
  const vm = await import("node:vm");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../assets/shell.js", import.meta.url), "utf8").replace("{{banner}}", "");
  const boxes = [0, 1, 2].map(() => ({ checked: false, msg: null, on: {}, setCustomValidity(m) { this.msg = m; }, addEventListener(t, f) { this.on[t] = f; } }));
  const group = { getAttribute: (k) => (k === "data-required" ? "Choose at least one." : null), querySelectorAll: () => boxes };
  const document = { querySelectorAll: (s) => (s === "[data-chips][data-required]" ? [group] : []), querySelector: () => null, documentElement: { classList: { toggle() {} } } };
  vm.runInNewContext(src, { document, navigator: {}, window: {} });
  assert.equal(boxes[0].msg, "Choose at least one.", "invalid while nothing is checked");
  boxes[2].checked = true; boxes[2].on.change();
  assert.equal(boxes[0].msg, "", "valid once one is checked");
  boxes[2].checked = false; boxes[2].on.change();
  assert.equal(boxes[0].msg, "Choose at least one.");
});

test("a required chip group renders its message and aria-required", () => {
  const en = structuredClone(sample.content.en);
  en.modals[0].fields.push({ name: "stack", label: "Use", required: true, control: "chips", options: ["A", "B"] });
  const { files } = buildSite({ ...sample, content: { ...sample.content, en } }, { root: SAMPLE, write: false });
  assert.match(files["index.html"], /<fieldset class="f fchips" data-chips="stack" data-required="Choose at least one\." aria-required="true">/);
});
