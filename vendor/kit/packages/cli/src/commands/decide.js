/**
 * kit decide --gate <gate.json|name> --state <file.json|-> [--config decide.config.json] [--backend name] [--json]
 *     answer a gate's typed questions about one state on the configured small model; prints each choice (or
 *     "escalate") and whether the big model must read the item; exit 0
 * kit decide eval --gate <gate> --cases <eval.json> [--config …] [--backend name] [--limit n] [--out results.json]
 *     run a gate over an eval set (kit.decide-eval.v1): accuracy, calibration, coverage, reads avoided, latency
 *
 * Config: --config, else ./decide.config.json, else the kit's packages/decide/decide.config.json. A gate given by name
 * is packages/decide/gates/<name>.json. Config, gate and eval set are validated against their schemas first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator, formatProblems } from "@saasreport/core/schema";
import { CliError } from "../args.js";

const pkg = fileURLToPath(new URL("../../../decide/", import.meta.url));
const engine = () => import("../../../decide/src/index.js");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function validator() {
  const files = ["schemas/decide-config.schema.json", "schemas/decide-gate.schema.json", "schemas/decide-eval.schema.json", "contracts/decision.schema.json"];
  const schemas = files.map((f) => readJson(resolve(pkg, f)));
  const v = createValidator(schemas);
  return (value, title, label) => {
    const s = schemas.find((x) => x.title === title);
    const problems = formatProblems(v.validate(value, s.$id));
    if (problems.length) throw new CliError(`${label} is not a valid ${title}:\n  ${problems.join("\n  ")}`);
    return value;
  };
}

function load(io, flags, check) {
  const cfgPath = flags.config ? resolve(io.cwd, String(flags.config)) : [resolve(io.cwd, "decide.config.json"), resolve(pkg, "decide.config.json")].find(existsSync);
  if (!cfgPath || !existsSync(cfgPath)) throw new CliError(`no config: ${flags.config}`);
  const config = check(readJson(cfgPath), "kit.decide-config.v1", cfgPath);
  if (!flags.gate) throw new CliError("--gate <gate.json|name> is required");
  const g = String(flags.gate);
  const gatePath = existsSync(resolve(io.cwd, g)) ? resolve(io.cwd, g) : resolve(pkg, "gates", `${g}.json`);
  if (!existsSync(gatePath)) throw new CliError(`no gate ${g}`);
  const gate = check(readJson(gatePath), "kit.decide-gate.v1", gatePath);
  const backend = flags.backend ? String(flags.backend) : config.backend;
  if (!config.backends[backend]) throw new CliError(`no backend "${backend}" in ${cfgPath}`);
  return { config, gate, backend };
}

export async function decide(io, { _: [sub], flags }) {
  const check = validator();
  const { config, gate, backend } = load(io, flags, check);
  const { createDecider, runGate, evaluate } = await engine();
  const run = createDecider({ config, backend, env: io.env, fetch: io.fetch });

  if (sub === "eval") {
    if (!flags.cases) throw new CliError("--cases <eval.json> is required");
    const set = check(readJson(resolve(io.cwd, String(flags.cases))), "kit.decide-eval.v1", String(flags.cases));
    if (set.gate !== gate.id) throw new CliError(`the eval set answers gate ${set.gate}, not ${gate.id}`);
    const cases = flags.limit ? set.cases.slice(0, Number(flags.limit)) : set.cases;
    const results = [];
    for (const [i, c] of cases.entries()) {
      results.push((await runGate(run, gate, c.state)).result);
      if (!flags.json && (i + 1) % 25 === 0) io.err(`  ${i + 1}/${cases.length}`);
    }
    const report = { gate: gate.id, backend, tier: config.backends[backend].tier, cases: cases.length, ...evaluate(gate, cases, results) };
    if (flags.out) writeFileSync(resolve(io.cwd, String(flags.out)), `${JSON.stringify({ report, results: cases.map((c, i) => ({ id: c.id, source: c.source, labels: c.labels, result: results[i] })) }, null, 2)}\n`);
    if (flags.json) { io.out(JSON.stringify(report, null, 2)); return 0; }
    for (const [q, m] of Object.entries(report.questions)) io.out(`${q}: accuracy ${m.accuracy}, coverage ${m.coverage}, covered accuracy ${m.coveredAccuracy}, ECE ${m.ece}, Brier ${m.brier}`);
    const g2 = report.gate;
    io.out(`gate: ${g2.events} events, big-model reads ${g2.reads}, avoided ${g2.avoided}, escalated ${g2.escalated}, missed ${g2.missed}`);
    io.out(`latency per request (${gate.questions.length} decisions): p50 ${report.latencyMs.p50} ms, p90 ${report.latencyMs.p90} ms`);
    return 0;
  }

  if (sub) throw new CliError(`unknown subcommand "${sub}" (kit decide [eval])`);
  if (!flags.state) throw new CliError("--state <file.json|-> is required");
  const raw = flags.state === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(io.cwd, String(flags.state)), "utf8");
  let state;
  try { state = JSON.parse(raw); } catch { state = raw; /* a state that is not JSON is plain text, which the gate also accepts */ }
  const { result, read } = await runGate(run, gate, state);
  if (flags.json) { io.out(JSON.stringify({ gate: gate.id, backend, read, result }, null, 2)); return 0; }
  for (const [id, a] of Object.entries(result)) io.out(`${id}: ${a.choice} (${a.confidence.toFixed(3)}${a.escalate && a.best ? `, best ${a.best}` : ""})`);
  io.out(`read: ${read ? "yes" : "no"}`);
  return 0;
}
