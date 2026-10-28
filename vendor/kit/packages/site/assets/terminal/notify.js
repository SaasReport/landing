  /* ---------- notifications: one event, the right route ---------- */
  const faDay = (n) => KitFormat.digits(KitFormat.formatInstant(new Date(Date.now() + n * 864e5), { locale: "{{locale.dateIntl}}", calendar: "{{locale.calendar}}", day: "numeric", month: "long", timeZone: "{{tz}}" }), "{{locale.digits}}");
  const TONE = { ok: "{{color.ok}}", warn: "{{color.warn}}", err: "{{color.err}}", info: "{{color.muted}}", brand: "{{color.accent}}" };
  // the text colour derived for each tone fill (--on-c): chosen per background, never one fixed colour
  const TONE_ON = { ok: "{{color.onOk}}", warn: "{{color.onWarn}}", err: "{{color.onErr}}", info: "{{color.onMuted}}", brand: "{{color.onAccent}}" };
  const NTF_TYPE = { ok: "success", warn: "warning", err: "error", info: "info", brand: "brand" };
  // The project's own scenarios (data.notify, schema/terminal-notify.schema.json), generated from its widgets.spec.json
  // (kit widgets build, export "terminal-notify"). The view has no scenarios of its own.
  const NT = {{d.notify.scenarios|json}}.map((t) => ({ k: t.key, chip: t.chip, ev: t.event, tone: t.tone, who: t.recipient, ic: t.icon, title: t.title,
    body: () => t.body.replace(/\{date([+-]\d+)\}/g, (m, n) => faDay(+n)), rules: t.rules, ch: t.channels, fail: t.fail,
    acts: (t.actions || []).map((a) => [a.label, a.done, a.tone, a.title, a.text]) }));
  let ntfTurn = 0;
  VIEWS.notify = {
    fa: "{{s.notify.90|dq}}", group: "{{s.notify.91|dq}}", hint: "{{s.notify.92|dq}}",
    render(V) {
{{#if d.notify.channels}}      const CH = {{d.notify.channels|json}}.map((c) => [c.key, c.label]);
{{else}}      const CH = [["push", "{{s.notify.93|dq}}"], ["sms", "{{s.notify.94|dq}}"], ["email", "{{s.notify.95|dq}}"], ["msg", "{{s.notify.96|dq}}"], ["inapp", "{{s.notify.97|dq}}"], ["hook", "{{s.notify.98|dq}}"]];
{{/if}}
      const chName = Object.fromEntries(CH);
      V.el.innerHTML = `<div class="tv tv-ntf">
        <div class="ntypes" role="radiogroup" aria-label="{{s.notify.99|tl}}">${NT.map((t, i) => `<button role="radio" aria-checked="${!i}" data-nt="${i}" style="--c:${TONE[t.tone]};--on-c:${TONE_ON[t.tone]}"><i></i>${t.chip}</button>`).join("")}</div>
        <div class="tv-card"><h4>{{s.notify.100|tl}} <span class="pill idle" data-st>{{s.notify.101|tl}}</span></h4>
          <p class="mono" style="font-size:12.5px;margin-bottom:6px" data-ev></p>
          <dl class="kv"><dt>{{s.notify.102|tl}}</dt><dd data-who></dd><dt>{{s.notify.103|tl}}</dt><dd data-title style="font-weight:600"></dd></dl>
          <ul class="tchecks" data-rules></ul>
          <div class="chanx" data-chx>${CH.map(([k, n]) => `<label><input type="checkbox" data-ch="${k}"><span>${n}</span></label>`).join("")}</div>
          <button class="btn btn--primary btn--block" style="margin-top:12px" data-send>{{s.notify.104|tl}}</button></div>
        <div class="tv-card"><h4>{{s.notify.105|tl}} <span class="live">{{s.notify.106|tl}}</span></h4><div class="net" data-net style="aspect-ratio:1000/620"></div>
          <ol class="trace" data-log></ol></div>
        <div class="tphone tphone--lock"><div class="notch"></div><div class="lock-t">${fa(stamp(false).slice(0, 5))}</div><small class="lock-d">${faDay(0)}</small>
          <div class="nstack" data-stack aria-live="polite"></div></div>
      </div>`;
      const nodes = [{ id: "ev", x: 880, y: 310, label: "{{s.notify.100|dq}}", cls: "nn--mod" }, { id: "hub", x: 560, y: 310, cls: "nn--hub", label: "{{s.notify.107|dq}}", icon: '<img src="{{d.icon}}" width="96" height="96" alt="">' },
        ...CH.map(([k, n], i) => ({ id: k, x: 150, y: 50 + i * 104, label: n }))];
      V.g = graph($("[data-net]", V.el), { h: 620, nodes, edges: [["ev", "hub"], ...CH.map(([k]) => ["hub", k])] });
      const log = $("[data-log]", V.el), st = $("[data-st]", V.el), stack = $("[data-stack]", V.el);
      const line = (t, cls = "ok") => { log.insertAdjacentHTML("beforeend", `<li class="${cls}"><span>${esc(t)}</span><span class="mono">${stamp()}</span></li>`); while (log.children.length > 6) log.firstElementChild.remove(); };
      const on = (k) => $(`[data-ch="${k}"]`, V.el)?.checked;
      V.pick = (i) => {
        V.i = i; const t = NT[i];
        $$("[data-nt]", V.el).forEach((b) => b.setAttribute("aria-checked", +b.dataset.nt === i));
        $("[data-ev]", V.el).textContent = t.ev; $("[data-who]", V.el).textContent = t.who; $("[data-title]", V.el).textContent = t.title;
        $("[data-rules]", V.el).innerHTML = t.rules.map((r) => `<li>${esc(r)}</li>`).join("");
        $$("[data-ch]", V.el).forEach((c) => { c.checked = t.ch.includes(c.dataset.ch); });
        st.className = "pill idle"; st.textContent = "{{s.notify.101|dq}}";
      };
      // a notification card on the phone; actions resolve it and post the follow-up
      const card = (t, { title = t.title, body = t.body(), tone = t.tone, ic = t.ic, sms = false, acts = [] } = {}) => {
        const el = document.createElement("div");
        el.className = `nt ${sms ? "nt--sms" : ""}`; el.style.setProperty("--c", sms ? "{{color.ok}}" : TONE[tone]); el.style.setProperty("--on-c", sms ? "{{color.onOk}}" : TONE_ON[tone]);
        el.innerHTML = `<i>${sms ? "✉" : esc(ic)}</i><div><b>${sms ? esc(chName.sms) : esc(title)}</b><small>${esc(sms ? `${title}: ${body}` : body)}</small>${acts.length ? `<span class="nt__acts">${acts.map((a, j) => `<button type="button" data-a="${j}">${esc(a[0])}</button>`).join("")}</span>` : ""}</div>`;
        stack.prepend(el); requestAnimationFrame(() => el.classList.add("on"));
        while (stack.children.length > 3) stack.lastElementChild.remove();
        $$("[data-a]", el).forEach((b) => b.addEventListener("click", () => V.resolve(el, t, acts[+b.dataset.a])));
        return el;
      };
      V.resolve = V.act(async (el, t, a) => {
        if (!a || el.dataset.done) return; el.dataset.done = "1";
        if (V.toast != null) { window.{{ns.global}}Notify?.dismiss?.(V.toast); V.toast = null; }
        const ac = $(".nt__acts", el); if (ac) ac.outerHTML = `<em class="nt__done">${esc(a[1])}</em>`;
        line(`{{s.notify.108|tl}} ${a[0]}`); await V.wait(700);
        card(t, { title: a[3], body: a[4], tone: a[2], ic: a[2] === "err" ? "✕" : "✓" }); line(`{{s.notify.109|tl}} ${a[3]}`);
        V.shell?.feed(`${t.ev.split(".")[0]}.resolved`, a[2] === "err" ? "err" : "ok", a[3]);
      });
      V.send = V.act(async (human = false) => {
        const t = NT[V.i], btn = $("[data-send]", V.el); btn.disabled = true;
        log.innerHTML = ""; $$(".nn", V.el).forEach((n) => n.classList.remove("warn"));
        Object.keys(V.g.edgeEl).forEach((e) => V.g.edge(e));
        st.className = "pill run"; st.textContent = "{{s.notify.110|dq}}";
        const rl = $$("[data-rules] li", V.el); rl.forEach((r) => r.classList.remove("ok"));
        for (const r of rl) { await V.wait(240); r.classList.add("ok"); }
        V.g.edge("ev>hub", "on"); await V.g.fly(["ev>hub"], { dur: 650 }); line(`${t.ev} {{s.notify.111|tl}}`);
        const chans = CH.map(([k]) => k).filter(on);
        if (!chans.length) { line("{{s.notify.112|dq}}", "err"); st.className = "pill err"; st.textContent = "{{s.notify.113|dq}}"; btn.disabled = false; return; }
        const direct = chans.filter((k) => !(t.fail === "push" && k === "sms"));
        direct.forEach((k) => V.g.edge(`hub>${k}`, "on"));
        await Promise.all(direct.map((k) => V.g.fly([`hub>${k}`], { dur: 900 })));
        let pushed = null;
        for (const k of direct) {
          if (k === "push") { pushed = card(t, { acts: t.acts || [] }); line(`${chName.push}{{s.notify.114|tl}}`, t.fail === "push" ? "" : "ok"); }
          else if (k === "sms") { card(t, { sms: true }); line(`${chName.sms}{{s.notify.115|tl}}`); }
          else if (k === "hook") line(`${chName.hook}: 200 OK`);
          else line(`${chName[k]}{{s.notify.115|tl}}`);
        }
        if (human && on("inapp") && window.{{ns.global}}Notify) {
          V.toast = window.{{ns.global}}Notify.show({ type: NTF_TYPE[t.tone], title: t.title, message: t.body(), actions: (t.acts || []).slice(0, 2).map((a) => ({ label: a[0], onClick: () => { const c = pushed || card(t, { acts: t.acts }); V.resolve(c, t, a); } })) });
        }
        if (t.fail === "push" && on("push")) {
          await V.wait(1200); V.g.nodeEl.push.classList.add("warn"); V.g.edge("hub>push", "warn"); line(`${chName.push}{{s.notify.116|tl}}`, "err");
          await V.wait(800);
          if (on("sms")) { V.g.edge("hub>sms", "on"); await V.g.fly(["hub>sms"], { dur: 900 }); card(t, { sms: true }); line(`${chName.sms} {{s.notify.117|tl}}`); }
        }
        await V.wait(400); line("{{s.notify.118|dq}}");
        st.className = "pill ok"; st.textContent = "{{s.notify.119|dq}}"; btn.disabled = false;
        V.shell?.feed("notification.delivered", "ok", t.chip);
      });
      $$("[data-nt]", V.el).forEach((b) => b.addEventListener("click", () => { V.pick(+b.dataset.nt); V.send(true); }));
      $("[data-send]", V.el).addEventListener("click", () => V.send(true));
      V.pick(ntfTurn % NT.length);
    },
    async play(V, S) {
      const i = ntfTurn++ % NT.length;
      await S.sleep(700);
      await S.click($(`[data-nt="${i}"]`, V.el)); V.pick(i); await S.sleep(300);
      await V.send(false);
      const btn = $("[data-stack] .nt__acts button", V.el);
      if (btn) { await S.sleep(1100); await S.click(btn); btn.click(); await S.sleep(1200); }
      await S.sleep(2000);
    },
  };

