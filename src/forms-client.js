// The page side of the declared forms: a form[data-form] is sent to /api/forms/<id> as JSON and answered in its modal.
// scripts/generate.mjs writes public/forms.js from this file with STRINGS (content/copy.json) in front of it.
// Every read of the form goes through the element's own prototype: its fields are named name, email, role and so on,
// and a control with such a name replaces the form's property of that name.
(() => {
  const attr = (el, n) => Element.prototype.getAttribute.call(el, n);
  const one = (el, s) => Element.prototype.querySelector.call(el, s);
  const all = (el, s) => Array.from(Element.prototype.querySelectorAll.call(el, s));
  const multiple = (form, name) => all(form, `input[type="checkbox"][name="${name}"]`).length > 1;

  function statusOf(form) {
    let s = one(form, "[data-form-status]");
    if (!s) {
      s = document.createElement("p");
      s.className = "fine";
      s.setAttribute("data-form-status", "");
      s.setAttribute("role", "status");
      s.setAttribute("aria-live", "polite");
      const foot = one(form, ".modal__foot") || form;
      foot.appendChild(s);
    }
    return s;
  }
  function say(form, text, alert) {
    const s = statusOf(form);
    s.setAttribute("role", alert ? "alert" : "status");
    s.textContent = text;
    // the answer is where the visitor is looking: on a phone the foot of a long form is below the fold of its modal
    if (text) s.scrollIntoView({ block: "nearest" });
  }
  function bodyOf(form) {
    const data = new FormData(form);
    const out = {};
    for (const name of new Set(data.keys())) {
      if (name === "consent") continue;
      Object.defineProperty(out, name, { value: multiple(form, name) ? data.getAll(name).map(String) : String(data.get(name)), enumerable: true });
    }
    for (const el of all(form, 'input[type="checkbox"][name]')) {
      const name = attr(el, "name");
      if (name !== "consent" && multiple(form, name) && !Object.prototype.hasOwnProperty.call(out, name)) Object.defineProperty(out, name, { value: [], enumerable: true });
    }
    Object.defineProperty(out, "consent", { value: data.get("consent") !== null, enumerable: true });
    return out;
  }
  function mark(form, errors) {
    for (const el of all(form, "[aria-invalid]")) el.removeAttribute("aria-invalid");
    let first = null;
    for (const e of errors || []) {
      const el = one(form, `[name="${String(e.field).replace(/[^\w-]/g, "")}"]`);
      if (!el) continue;
      el.setAttribute("aria-invalid", "true");
      first = first || el;
    }
    if (first) first.focus();
  }
  function done(form, reference) {
    for (const el of all(form, ".fgrid, .modal__foot > :not([data-form-status])")) { el.setAttribute("data-form-hidden", ""); el.style.display = "none"; }
    say(form, STRINGS.done.replace("{reference}", reference), false);
    HTMLFormElement.prototype.reset.call(form);
  }
  function restore(form) {
    for (const el of all(form, "[data-form-hidden]")) { el.removeAttribute("data-form-hidden"); el.style.display = ""; }
    const s = one(form, "[data-form-status]");
    if (s) s.textContent = "";
    mark(form, []);
  }

  document.addEventListener("submit", async (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    const id = attr(form, "data-form");
    if (!id) return;
    ev.preventDefault();
    if (attr(form, "aria-busy") === "true") return;
    if (!HTMLFormElement.prototype.checkValidity.call(form)) { HTMLFormElement.prototype.reportValidity.call(form); return; }
    const button = one(form, 'button[type="submit"]');
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 20000);
    form.setAttribute("aria-busy", "true");
    if (button) button.disabled = true;
    say(form, STRINGS.sending, false);
    try {
      const res = await fetch(`/api/forms/${encodeURIComponent(id)}`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(bodyOf(form)), signal: stop.signal, redirect: "error", credentials: "omit",
      });
      let answer = null;
      try { answer = await res.json(); } catch { /* an answer that is not JSON is a failure */ }
      if (res.status === 201 && answer && typeof answer.reference === "string") { done(form, answer.reference); return; }
      if (res.status === 422 && answer && Array.isArray(answer.errors)) { say(form, STRINGS.invalid, true); mark(form, answer.errors); return; }
      say(form, res.status === 429 ? STRINGS.busy : STRINGS.failed, true);
    } catch {
      say(form, STRINGS.failed, true);
    } finally {
      clearTimeout(timer);
      form.removeAttribute("aria-busy");
      if (button) button.disabled = false;
    }
  });
  // A closed modal opens fresh: the confirmation of one request does not stay in front of the next.
  document.addEventListener("close", (ev) => {
    const dialog = ev.target;
    if (!(dialog instanceof HTMLDialogElement)) return;
    for (const form of all(dialog, "form[data-form]")) restore(form);
  }, true);
})();
