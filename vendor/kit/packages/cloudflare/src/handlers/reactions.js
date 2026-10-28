/**
 * Likes, 1–5 ratings and share targets for posts and episodes.
 *   GET  /api/reactions?items=post:a,episode:b   counts, average rating, this visitor's own like/rating
 *   POST /api/reactions {item, like: true|false} | {item, rating: 1..5}
 * No accounts: a random id in an HttpOnly cookie identifies the browser and is stored only as a salted hash.
 * Writes are same-origin only and rate-limited per IP (hashed).
 */
import { esc, json, sha256 } from "../util.js";
import { icon } from "../shell.js";
import { readJsonBody } from "../body.js";

// A slug, or on a multi-locale site a non-default locale's stored slug ("ar/week-…").
const ITEM_RE = /^(post|episode):((?:[a-z]{2,3}(?:-[a-z0-9]{2,8})*\/)?[a-z0-9-]{1,90})$/;
const MAX_ITEMS = 30;
const newId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Aggregates for items: {item: {likes, rating_avg, rating_count}}. */
export async function aggregates(env, items) {
  if (!items.length || !env.DB) return Object.fromEntries(items.map((i) => [i, { likes: 0, rating_avg: null, rating_count: 0 }]));
  const rows = (await env.DB.prepare(`SELECT item, SUM(liked) AS likes, COUNT(rating) AS n, AVG(rating) AS avg FROM reactions WHERE item IN (${items.map(() => "?").join(",")}) GROUP BY item`).bind(...items).all()).results || [];
  const out = Object.fromEntries(items.map((i) => [i, { likes: 0, rating_avg: null, rating_count: 0 }]));
  for (const r of rows) out[r.item] = { likes: r.likes || 0, rating_avg: r.n ? Math.round(r.avg * 10) / 10 : null, rating_count: r.n || 0 };
  return out;
}

async function itemExists(env, item, now) {
  const [, type, slug] = ITEM_RE.exec(item) || [];
  if (type === "post") return Boolean(await env.DB.prepare("SELECT 1 AS x FROM posts WHERE slug = ? AND status = 'published' AND published_at <= ?").bind(slug, now).first());
  if (type === "episode") return Boolean(await env.DB.prepare("SELECT 1 AS x FROM podcast_episodes WHERE slug = ? AND status = 'published'").bind(slug).first());
  return false;
}

function sameOrigin(k, request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return !request.headers.get("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin";
  try { const o = new URL(origin); return o.host === url.host || o.origin === k.config.site.origin; } catch { return false; /* not a URL: not a same-origin request */ }
}

export async function handleReactions(k, request, env, url) {
  const { reactions } = k.config;
  const cookieRe = new RegExp(`(?:^|;\\s*)${reactions.cookie}=([A-Za-z0-9_-]{16,64})`);
  const salt = env.IP_SALT || reactions.salt || k.config.site.id;   // reactions.salt: fallback when the IP_SALT secret is unset
  const vid = cookieRe.exec(request.headers.get("cookie") || "")?.[1] || null;
  const visitor = vid ? await sha256(`${vid}|${salt}`) : null;

  if (request.method === "GET") {
    const items = [...new Set((url.searchParams.get("items") || "").split(",").map((s) => s.trim()).filter((s) => ITEM_RE.test(s)))].slice(0, MAX_ITEMS);
    const agg = await aggregates(env, items);
    if (visitor && items.length) {
      const mine = (await env.DB.prepare(`SELECT item, liked, rating FROM reactions WHERE visitor = ? AND item IN (${items.map(() => "?").join(",")})`).bind(visitor, ...items).all()).results || [];
      for (const m of mine) agg[m.item].mine = { liked: Boolean(m.liked), rating: m.rating };
    }
    return json({ ok: true, items: agg });
  }
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "GET, POST" });
  if (!sameOrigin(k, request, url)) return json({ ok: false, error: "forbidden_origin" }, 403);
  const { value: body, response: refused } = await readJsonBody(request);
  if (refused) return refused;
  const item = String(body?.item || "");
  const hasLike = typeof body?.like === "boolean";
  const hasRating = Number.isInteger(body?.rating) && body.rating >= 1 && body.rating <= 5;
  if (!ITEM_RE.test(item) || hasLike === hasRating) return json({ ok: false, error: "invalid" }, 422);
  if (hasRating && !reactions.ratings.includes(item.split(":")[0])) return json({ ok: false, error: "rating_not_supported" }, 422);
  if (!(await itemExists(env, item, k.now().toISOString()))) return json({ ok: false, error: "not_found" }, 404);

  const ipHash = await sha256(`${request.headers.get("cf-connecting-ip") || "0.0.0.0"}|${salt}`);
  const nowMs = k.now().getTime();
  const since = new Date(nowMs - reactions.windowMinutes * 60_000).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM reactions WHERE ip_hash = ? AND updated_at > ?").bind(ipHash, since).first();
  if ((recent?.n || 0) >= reactions.maxWrites) return json({ ok: false, error: "rate_limited" }, 429, { "retry-after": String(reactions.windowMinutes * 60) });

  const id = vid || newId();
  const who = visitor || (await sha256(`${id}|${salt}`));
  const now = new Date(nowMs).toISOString();
  const col = hasLike ? "liked" : "rating", val = hasLike ? (body.like ? 1 : 0) : body.rating;
  await env.DB.prepare(`INSERT INTO reactions (item, visitor, ${col}, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item, visitor) DO UPDATE SET ${col} = excluded.${col}, ip_hash = excluded.ip_hash, updated_at = excluded.updated_at`).bind(item, who, val, ipHash, now, now).run();
  const agg = (await aggregates(env, [item]))[item];
  const mine = await env.DB.prepare("SELECT liked, rating FROM reactions WHERE item = ? AND visitor = ?").bind(item, who).first();
  agg.mine = { liked: Boolean(mine?.liked), rating: mine?.rating ?? null };
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  const extra = vid ? {} : { "set-cookie": `${reactions.cookie}=${id}; Path=/; Max-Age=31536000; HttpOnly;${secure} SameSite=Lax` };
  return json({ ok: true, item, ...agg }, 200, extra);
}

/* ------------------------------------------------------------------ share targets */
const TARGETS = {
  telegram: "https://t.me/share/url?url={url}&text={title}",
  whatsapp: "https://wa.me/?text={title}%20{url}",
  x: "https://x.com/intent/post?url={url}&text={title}",
  linkedin: "https://www.linkedin.com/sharing/share-offsite/?url={url}",
  facebook: "https://www.facebook.com/sharer/sharer.php?u={url}",
  email: "mailto:?subject={title}&body={url}",
};

/** Resolved share targets: [{key, label, href}] plus flags for native share and copy link. */
export function shareTargets(k, { url, title }) {
  const u = encodeURIComponent(url), ti = encodeURIComponent(title);
  const fill = (tpl) => tpl.replace(/\{url\}/g, u).replace(/\{title\}/g, ti);
  const links = [];
  let native = false, copy = false;
  for (const x of k.config.share.targets) {
    if (x === "native") native = true;
    else if (x === "copy") copy = true;
    else if (typeof x === "string" && TARGETS[x]) links.push({ key: x, label: k.t(`share.${x}`), href: fill(TARGETS[x]) });
    else if (x && typeof x === "object" && x.url) links.push({ key: x.key || "custom", label: x.label || x.key, href: fill(x.url) });
  }
  return { links, native, copy };
}

/** Server-rendered like / rating / share block (counts render without JS). */
export function reactionsBlock(k, { item, url, title, agg = { likes: 0, rating_avg: null, rating_count: 0 } }) {
  const { t, d, config } = k;
  const f = config.features;
  if (!f.reactions && !f.share) return "";
  const type = item.split(":")[0];
  const rating = f.reactions && config.reactions.ratings.includes(type);
  const avg = agg.rating_count ? t("rx.ratings", { n: agg.rating_count, avg: d(String(agg.rating_avg)).replace(".", config.site.lang === "fa" || config.site.lang === "ar" ? "٫" : ".") }) : t("rx.noRatings");
  const stars = rating ? `<div class="rx__rate" role="radiogroup" aria-label="${esc(t("rx.rate"))}">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="rx__node" role="radio" aria-checked="false" data-rate="${n}" aria-label="${esc(t("rx.rateN", { n }))}"></button>`).join("")}
      <span class="rx__avg" data-rx-avg>${esc(avg)}</span></div>` : "";
  const like = f.reactions ? `<div class="rx__row"><button type="button" class="rx__like" data-rx-like aria-pressed="false">${icon("heart")}<span>${esc(t("rx.like"))}</span><b data-rx-likes>${d(agg.likes)}</b></button>${stars}</div>` : "";
  let share = "";
  if (f.share) {
    const s = shareTargets(k, { url, title });
    share = `<div class="rx__share"><b>${esc(t("rx.share"))}</b>
    ${s.native ? `<button type="button" class="btn btn--ghost btn--sm" data-rx-native hidden>${icon("share")}${esc(t("rx.native"))}</button>` : ""}
    ${s.links.map((l) => `<a class="btn btn--ghost btn--sm" data-share="${esc(l.key)}" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("")}
    ${s.copy ? `<button type="button" class="btn btn--ghost btn--sm" data-copy-url="${esc(url)}">${icon("copy")}${esc(t("rx.copy"))}</button>` : ""}
  </div>`;
  }
  return `<section class="rx"${f.reactions ? ` data-rx="${esc(item)}"` : ""} aria-label="${esc(t("rx.label"))}">${like}${share}</section>`;
}
