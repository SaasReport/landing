// Layout QA for rendered widgets: the largest empty vertical gap inside a widget (and inside each device box), so a
// widget never shows a tall block of white space (an empty device, a fixed min-height, a dead column).

/**
 * Runs in the page. For every widget (.kw) and every box inside it ([data-kw-dev], .kw-nc__main, .kw-nc__col), projects
 * its visible "ink" (text, images, svg, small coloured marks) onto the vertical axis and returns the largest run of
 * height with no ink, top and bottom edges included.
 */
export function gapProbe() {
  const visible = (el) => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05; };
  const shown = (el) => { for (let x = el; x && x !== document.body; x = x.parentElement) if (!visible(x)) return false; return true; };
  const ink = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !shown(n.parentElement)) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const b of r.getClientRects()) if (b.height > 0 && b.width > 0) out.push([b.top, b.bottom]);
    }
    for (const el of root.querySelectorAll("img,svg,canvas,video,i,button,input,select,textarea,.kw-scene__dot,.kw-dev__notch")) {
      if (!shown(el)) continue; const b = el.getBoundingClientRect(); if (b.height > 0 && b.width > 0) out.push([b.top, b.bottom]);
    }
    return out;
  };
  const gap = (box) => {
    const b = box.getBoundingClientRect(); if (b.height < 1) return { gap: 0 };
    const iv = ink(box).map(([t, u]) => [Math.max(t, b.top), Math.min(u, b.bottom)]).filter(([t, u]) => u > t).sort((x, y) => x[0] - y[0]);
    let at = b.top, best = 0, where = 0;
    for (const [t, u] of iv) { if (t - at > best) { best = t - at; where = at - b.top; } at = Math.max(at, u); }
    if (b.bottom - at > best) { best = b.bottom - at; where = at - b.top; }
    return { gap: Math.round(best), at: Math.round(where), height: Math.round(b.height) };
  };
  const name = (el) => el.dataset.kwDev ? `device ${el.dataset.kwDev}` : el.id || el.className.split(" ")[0];
  return [...document.querySelectorAll(".kw")].filter(shown).map((w) => {
    const boxes = [w, ...w.querySelectorAll("[data-kw-dev],.kw-nc__main,.kw-nc__col")].filter(shown);
    const worst = boxes.map((el) => ({ box: el === w ? "widget" : name(el), ...gap(el) })).sort((x, y) => y.gap - x.gap)[0];
    return { widget: w.id || w.dataset.kwWidget || w.className, ...worst };
  });
}

/** Opens each url at each width, scrolls every widget into view, samples at the given times, returns the worst gaps. */
export async function measureGaps(playwright, { urls, widths = [390, 1280], times = [600, 4000, 12000, 25000], executablePath, maxGap = 120 }) {
  const browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
  const results = [];
  try {
    for (const url of urls) for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(url, { waitUntil: "networkidle" });
      await page.evaluate(async () => { for (const w of document.querySelectorAll(".kw")) { w.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
      const worst = new Map(); const t0 = Date.now();
      for (const t of times) {
        await page.waitForTimeout(Math.max(0, t - (Date.now() - t0)));
        for (const r of await page.evaluate(gapProbe)) { const k = r.widget; if (!worst.has(k) || worst.get(k).gap < r.gap) worst.set(k, { ...r, t }); }
      }
      for (const r of worst.values()) results.push({ url, width, ...r, ok: r.gap < maxGap });
      await page.close();
    }
  } finally { await browser.close(); }
  return results;
}
