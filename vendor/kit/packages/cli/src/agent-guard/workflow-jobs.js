/**
 * The jobs of a workflow text, line-based: [{ id, line, runsOn, continueOnError, reusable, body }], and the values of a job's matrix key. Moved here from
 * the removed canon/workflows.js check (main replaced that check by declared finding classes); used by the guard's CI audit (install.js).
 */
const indentOf = (l) => l.match(/^ */)[0].length;
const unquote = (v) => v.trim().replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2").trim();
const inlineList = (v) => (/^\[.*\]$/.test(v.trim()) ? v.trim().slice(1, -1).split(",").map(unquote).filter(Boolean) : null);

/** The jobs of one workflow text: [{ id, line, runsOn: string[] | null, continueOnError, reusable, body: string[] }]. */
export function parseJobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let jobIndent = null;
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) { if (cur) cur.body.push(l); continue; }
    const ind = indentOf(l);
    if (ind === 0) break;
    if (jobIndent === null) jobIndent = ind;
    if (ind === jobIndent) {
      const m = /^\s*([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(l);
      cur = { id: m ? m[1] : l.trim(), line: i + 1, body: [] };
      jobs.push(cur);
      continue;
    }
    if (cur) cur.body.push(l);
  }
  for (const job of jobs) {
    const props = job.body.filter((l) => l.trim() && !/^\s*#/.test(l));
    const propIndent = props.length ? Math.min(...props.map(indentOf)) : 0;
    const own = (key) => {
      const idx = job.body.findIndex((l) => indentOf(l) === propIndent && new RegExp(`^\\s*${key}:`).test(l));
      return idx < 0 ? null : { idx, value: job.body[idx].replace(new RegExp(`^\\s*${key}:`), "").trim() };
    };
    job.reusable = Boolean(own("uses"));
    const coe = own("continue-on-error");
    job.continueOnError = coe ? unquote(coe.value) : null;
    const ro = own("runs-on");
    if (!ro) job.runsOn = null;
    else if (ro.value && !/^#/.test(ro.value)) job.runsOn = inlineList(ro.value) || [unquote(ro.value)];
    else {
      const items = [];
      for (let k = ro.idx + 1; k < job.body.length && (indentOf(job.body[k]) > propIndent || !job.body[k].trim()); k++) {
        const m = /^\s*-\s*(.+)$/.exec(job.body[k]);
        if (m) items.push(unquote(m[1]));
      }
      job.runsOn = items.length ? items : null;
    }
  }
  return jobs;
}

/** Values a job's matrix gives `key` (from `key: [..]`, `key: v`, `- key: v` and block lists under `key:`). */
export function matrixValues(job, key) {
  const out = [];
  const re = new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.*)$`);
  job.body.forEach((l, i) => {
    const m = re.exec(l);
    if (!m) return;
    const v = m[1].trim();
    if (v && !/^#/.test(v)) { out.push(...(inlineList(v) || [unquote(v)])); return; }
    const ind = indentOf(l);
    for (let k = i + 1; k < job.body.length && (indentOf(job.body[k]) > ind || !job.body[k].trim()); k++) {
      const item = /^\s*-\s*(.+)$/.exec(job.body[k]);
      if (item) out.push(unquote(item[1]));
    }
  });
  return out;
}
