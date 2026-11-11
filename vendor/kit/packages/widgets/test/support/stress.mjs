// The worst view the network budget allows (24 nodes and 40 flows), as a one-page site: the browser test counts its work on it,
// the dedicated-runner bench (bench/frame-budget.bench.mjs) times it.
import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { writeWidgetsSite } from "./page.mjs";

/** Copy the fixture `fix` to `src`, add the stress view to its network scenario, and write the site into `dir`. */
export async function writeStressSite(dir, fix, src) {
  cpSync(fix, src, { recursive: true });
  const spec = JSON.parse(readFileSync(join(src, "widgets.spec.json"), "utf8"));
  const sc = spec.scenarios.find((s) => s.id === "library-network"), net = sc.network;
  const cls = ["participant", "provider", "infrastructure"];
  for (let i = 0; i < 24; i++) net.nodes.push({ id: `z${i}`, label: { en: `Node ${i + 1}`, fa: `گره ${i + 1}` }, class: cls[i % 3] });
  const ids = net.nodes.filter((n) => n.id.startsWith("z")).map((n) => n.id);
  net.configurations = [{ id: "stress", label: { en: "Stress", fa: "فشار" }, layout: "rings", nodes: ids, flows: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, type: ["fees", "grants", "delivery"][i % 3], from: ids[i % 24], to: ids[(i * 7 + 5) % 24] === ids[i % 24] ? ids[(i + 1) % 24] : ids[(i * 7 + 5) % 24], label: { en: `Flow ${i}`, fa: `جریان ${i}` }, direction: i % 5 === 0 ? "both" : "forward" })) }];
  sc.widgets = sc.widgets.filter((w) => w.archetype === "network");
  spec.scenarios = [sc]; spec.archetypes = ["network"];
  writeFileSync(join(src, "widgets.spec.json"), JSON.stringify(spec));
  return writeWidgetsSite(dir, join(src, "widgets.spec.json"), { locale: "en" });
}
