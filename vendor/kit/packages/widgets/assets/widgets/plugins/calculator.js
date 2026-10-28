/* The calculator archetype's runtime (a plugin module of @saasreport/widgets): progressive enhancement of the static markup.
   Loaded by assets/widgets.js only when a widget of this archetype is on the page. No content of its own. */
/* ---------- calculator: + - * / ( ) min max round floor ceil pow abs over input names ---------- */
const FNS = { min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow, abs: Math.abs, gte: (a, b) => (a >= b ? 1 : 0), lte: (a, b) => (a <= b ? 1 : 0) };
function evaluate(src, vars) {
  const t = src.match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),]/g) || []; let i = 0;
  const prim = () => {
    const k = t[i++];
    if (k === "(") { const e = add(); i++; return e; }
    if (k === "-") return -prim();
    if (/^\d/.test(k)) return +k;
    if (FNS[k] && t[i] === "(") { i++; const a = [add()]; while (t[i] === ",") { i++; a.push(add()); } i++; return FNS[k](...a); }
    return Number(vars[k]);
  };
  const mul = () => { let a = prim(); while (t[i] === "*" || t[i] === "/") { const o = t[i++]; const b = prim(); a = o === "*" ? a * b : a / b; } return a; };
  const add = () => { let a = mul(); while (t[i] === "+" || t[i] === "-") { const o = t[i++]; const b = mul(); a = o === "+" ? a + b : a - b; } return a; };
  return add();
}

export default function mount(w, { $, $$, reduce, wait, sequence }) {
  const form = $("[data-kw-calc]", w), N = form.dataset;
  // The page's numerals and separators come from @saasreport/format (data-numerals, data-group, data-decimal), so the
  // browser's ICU never decides the digits.
  const nf = (d) => ({ format: (v) => { const [i, f] = Math.abs(v).toFixed(+d || 0).split("."); const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, N.group || ",") + (f ? (N.decimal || ".") + f : ""); return (v < 0 ? "\u2212" : "") + s.replace(/[0-9]/g, (x) => (N.numerals || "0123456789")[x]); } });
  const update = () => {
    const vars = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, Number(v)]));
    $$("output[data-expr]", form).forEach((o) => {
      const v = evaluate(o.dataset.expr, vars); o.textContent = Number.isFinite(v) ? nf(o.dataset.decimals).format(v) : "—";
      // the band the value falls in (the highest min not above it)
      const bands = o.closest("p")?.nextElementSibling?.matches?.("[data-kw-bands]") ? $$("li", o.closest("p").nextElementSibling) : [];
      let on = bands[0]; for (const b of bands) if (v >= +b.dataset.min) on = b;
      bands.forEach((b) => { if (b === on) b.dataset.on = "1"; else delete b.dataset.on; });
    });
  };
  form.addEventListener("input", update); form.addEventListener("submit", (e) => e.preventDefault());
}
