// Render every template of the sample configs (SaasReport en, SaasReport en+ar) to HTML previews.
//   node packages/comms/examples/render.mjs <out-dir>
// Writes <out>/<project>/<template_id>.html (+ .txt) and <out>/index.html; lists what each config still needs (TODO).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePreviews, previewIndex } from "../src/node.js";
import { todos } from "../src/index.js";

const out = process.argv[2] || "comms-previews";
const projects = [];
for (const dir of ["saasreport", "saasreport-ar"]) {
  const config = (await import(`./${dir}/comms.config.js`)).default;
  const previews = writePreviews(config, join(out, dir));
  projects.push({ title: `${config.brand.name.en || config.brand.name[config.locales[0].split("-")[0]]} (${config.locales.join(", ")})`, dir, previews });
  const t = todos(config);
  console.log(`${dir}: ${previews.length} previews${t.length ? `; TODO: ${t.map(([p]) => p).join(", ")}` : ""}`);
}
writeFileSync(join(out, "index.html"), previewIndex(projects));
console.log(`index: ${join(out, "index.html")}`);
