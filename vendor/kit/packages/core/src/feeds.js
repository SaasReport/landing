/**
 * Feeds: RSS 2.0 for posts, and podcast RSS with iTunes and Podcasting 2.0 tags.
 *   rss(config, items, { title, description, path, feedPath }) → XML string
 *   podcastRss(config, show, episodes, { ownerEmail }) → Promise<XML string>   (podcast:guid needs SHA-1)
 *   podcastGuid(feedUrl) → Promise<UUIDv5>
 */
import { xmlEscape as x, absUrl } from "./seo.js";
import { strings, lang } from "./i18n.js";

const cdata = (s) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const rfc822 = (d) => new Date(d).toUTCString();

/**
 * RSS 2.0. items: { title, url | path | slug, summary?, html?, published_at, guid?, categories?, author? }
 * (slug resolves under paths.blog).
 */
export function rss(config, items, { title = config.site.name, description = config.site.description || config.site.name, path = config.paths?.blog || "/blog/", feedPath = `${config.paths?.blog || "/blog/"}feed.xml`, language } = {}) {
  const link = (i) => absUrl(config, i.url || i.path || `${config.paths?.blog || "/blog/"}${i.slug}`);
  const body = items.map((i) => `<item><title>${x(i.title)}</title><link>${x(link(i))}</link><guid isPermaLink="${i.guid ? "false" : "true"}">${x(i.guid || link(i))}</guid>`
    + `<pubDate>${rfc822(i.published_at)}</pubDate>${i.summary ? `<description>${x(i.summary)}</description>` : ""}`
    + `${i.html ? `<content:encoded>${cdata(i.html)}</content:encoded>` : ""}${(i.categories || i.tags || []).map((c) => `<category>${x(c)}</category>`).join("")}</item>`).join("\n");
  const newest = items.reduce((m, i) => (i.published_at > m ? i.published_at : m), "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>${x(title)}</title><link>${x(absUrl(config, path))}</link><atom:link href="${x(absUrl(config, feedPath))}" rel="self" type="application/rss+xml"/>
<description>${x(description)}</description><language>${x(language || lang(config))}</language>${newest ? `<lastBuildDate>${rfc822(newest)}</lastBuildDate>` : ""}
${body}
</channel></rss>`;
}

// podcast:guid is a UUIDv5 of the feed URL without the scheme and trailing slash (namespace ead4c236-bf58-58c6-a2c6-a6b28d128cb6), per Podcasting 2.0.
export async function podcastGuid(feedUrl) {
  const ns = "ead4c236bf5858c6a2c6a6b28d128cb6".match(/../g).map((h) => parseInt(h, 16));
  const name = new TextEncoder().encode(String(feedUrl).replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, ""));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array([...ns, ...name]))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const s = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
/** HH:MM:SS for itunes:duration. */
export const itunesDuration = (ms) => { const s = Math.round((ms || 0) / 1000); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

const categoryXml = (cat) => (Array.isArray(cat) ? cat : [cat])
  .map((c) => (Array.isArray(c) ? c : String(c).split(/\s*>\s*/))).filter((g) => g[0])
  .map(([top, sub]) => (sub ? `<itunes:category text="${x(top)}"><itunes:category text="${x(sub)}"/></itunes:category>` : `<itunes:category text="${x(top)}"/>`)).join("");

/**
 * Podcast RSS (Apple/Spotify-ready). show: a key of config.shows or a show object { key, title, description, feed, cover, cover1400, category, author, ownerEmail,
 *   guidPrefix } (episode guids are `${guidPrefix}${slug}`, default "<host>-podcast-"; keep it stable once published).
 * episodes: { slug, title, summary, published_at, audio_url?, audio_bytes?, duration_ms?, number?, url?, image?, type?, categories? (tag labels: one <category> each) } (audio defaults to paths.podcasts + "audio/<slug>.mp3").
 * category: "Business > Investing", or a list: ["Business > Investing", "Technology"] or [["Business", "Investing"], ["Technology"]].
 */
export async function podcastRss(config, show, episodes, { ownerEmail } = {}) {
  const S = typeof show === "string" ? config.shows[show] : show;
  if (!S) throw new Error(`unknown show ${JSON.stringify(show)}`);
  const P = config.paths?.podcasts || "/podcasts/";
  const page = absUrl(config, S.page || `${P}${S.key ? `#${S.key}` : ""}`);
  const cover = S.cover ? absUrl(config, S.cover) : null;
  const author = S.author || config.site.org?.name || config.site.name;
  const email = ownerEmail || S.ownerEmail;
  const str = strings(config);
  const multi = Array.isArray(config.site.locales) && config.site.locales.length > 1; // one show per locale: say its language twice
  const items = episodes.map((e) => {
    const url = absUrl(config, e.url || `${P}${e.slug}`);
    return `<item><title>${x(e.title)}</title><link>${x(url)}</link><guid isPermaLink="false">${x(e.guid || `${S.guidPrefix ?? `${new URL(config.site.url).host}-podcast-`}${e.slug}`)}</guid>
<pubDate>${rfc822(e.published_at)}</pubDate><description>${x(e.summary)}</description><content:encoded>${cdata(`<p>${x(e.summary)}</p><p><a href="${x(url)}">${x(str.transcript)}</a></p>`)}</content:encoded>
<enclosure url="${x(absUrl(config, e.audio_url || `${P}audio/${e.slug}.mp3`))}" length="${e.audio_bytes || 0}" type="${e.audio_type || "audio/mpeg"}"/><itunes:duration>${itunesDuration(e.duration_ms)}</itunes:duration>
${(e.categories || []).map((c) => `<category>${x(c)}</category>`).join("")}${e.number ? `<itunes:episode>${e.number}</itunes:episode>` : ""}<itunes:episodeType>${e.type || "full"}</itunes:episodeType><itunes:explicit>false</itunes:explicit>${e.image || cover ? `<itunes:image href="${x(absUrl(config, e.image || S.cover))}"/>` : ""}</item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>${x(S.title)}</title><link>${x(page)}</link><atom:link href="${x(absUrl(config, S.feed))}" rel="self" type="application/rss+xml"/>
<language>${x(lang(S.language || config.site.locale))}</language>${multi ? `<itunes:language>${x(lang(S.language || config.site.locale))}</itunes:language>` : ""}<copyright>© ${x(author)}</copyright><description>${x(S.description)}</description>
<itunes:author>${x(author)}</itunes:author><itunes:summary>${x(S.description)}</itunes:summary>${email ? `<itunes:owner><itunes:name>${x(author)}</itunes:name><itunes:email>${x(email)}</itunes:email></itunes:owner>` : ""}
${cover ? `<itunes:image href="${x(cover)}"/><image><url>${x(absUrl(config, S.cover1400 || S.cover))}</url><title>${x(S.title)}</title><link>${x(page)}</link></image>` : ""}
${categoryXml(S.category || "Business")}
<itunes:explicit>${S.explicit ? "true" : "false"}</itunes:explicit><itunes:type>${S.type || "episodic"}</itunes:type><podcast:locked>no</podcast:locked><podcast:guid>${await podcastGuid(absUrl(config, S.feed))}</podcast:guid>
${items}
</channel></rss>`;
}

export const feeds = { rss, podcastRss, podcastGuid, itunesDuration };
