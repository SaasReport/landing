/**
 * `kit release review-marker` (docs/RELEASE.md, governance.json): the required check `independent-review` of a project whose governance
 * declares `independent_review_marker`. Success only when the repository OWNER (the registry's owner.github of the project: the comment's
 * author login is checked, never the body alone) has posted, on this pull request, the marker
 *
 *     <!-- independent-review head=<40-hex head sha> verdict=clean -->
 *
 * for the pull request's CURRENT head sha, and no later owner marker for that head says another verdict ("later" is the comment's last edit:
 * a marker edited to verdict=blocked, or deleted, counts from the edit). A new push moves the head, so the marker no longer matches and the
 * check fails until a review of the new head is recorded. A verdict only moves forward in comment time: the failure from a blocked marker
 * names the blocking comment (`blocked by comment <id>`) in the status description, and while it stands a clean marker counts only when its
 * comment id is not older than that one, so deleting the blocking comment never promotes an older clean marker (post a new one).
 *
 * The check is a COMMIT STATUS with the context `independent-review` that this command posts on the pull request's head (--post-status), from
 * every event that can change the answer: the pull request's own events AND issue_comment / pull_request_review_comment (created, edited,
 * deleted). A comment event runs on the default branch and its check run would attach to the default branch's commit, never to the pull
 * request's head, so the verdict is posted as a status on the head itself, where the ruleset requires it. After posting, the comments are
 * read again and the status re-posted while the answer changed, so two events racing end on the latest marker. The merge gate posts the
 * marker after an independent review of exactly that head came back clean. Pure over an injected fetch.
 */
import { SHA_RE } from "./config.js";

export const REVIEW_CONTEXT = "independent-review";
export const MARKER_RE = /<!-- independent-review head=([0-9a-f]{40}) verdict=([a-z-]+) -->/g;
export const markerText = (head, verdict = "clean") => `<!-- independent-review head=${head} verdict=${verdict} -->`;

/** → { ok, reason, head }: never throws on a refusal. head is the pull request's current head when it could be read. */
async function evaluate({ owner, repository, pr, head, get }) {
  const no = (reason, h = head) => ({ ok: false, reason, head: h });
  try {
    const pull = await get(`/repos/${repository}/pulls/${pr}`);
    const current = pull?.head?.sha;
    if (!SHA_RE.test(current || "")) return no(`the pull request's head ${current} is not a commit`);
    if (head && current !== head) return no(`the pull request's head is ${current}, not ${head}: a newer push needs its own review`, current);
    const comments = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await get(`/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    const at = (c) => String(c.updated_at ?? c.created_at ?? "");
    const mine = comments
      .filter((c) => String(c?.user?.login ?? "").toLowerCase() === owner.toLowerCase())
      .sort((a, b) => at(a).localeCompare(at(b)));
    let verdict = null, by = null;
    for (const c of mine) for (const m of String(c.body ?? "").matchAll(MARKER_RE)) if (m[1] === current) { verdict = m[2]; by = c.id; }
    if (verdict === null) return no(`no independent-review marker for ${current} by ${owner} on pull request ${pr}: the merge gate posts it after an independent review of exactly this head`, current);
    if (verdict !== "clean") return no(`blocked by comment ${by}: the latest independent-review marker for ${current} by ${owner} says verdict=${verdict}, not clean`, current);
    // A verdict only moves forward in comment time: a deletion can never promote an older clean marker over a blocked one that was
    // recorded. The latest status on this head says which comment blocked it; a clean marker counts only from that comment on.
    const statuses = await get(`/repos/${repository}/commits/${current}/statuses?per_page=100`);
    const prior = (Array.isArray(statuses) ? statuses : []).find((x) => x?.context === REVIEW_CONTEXT);
    const blockedBy = prior?.state === "failure" ? /blocked by comment (\d+)/.exec(String(prior.description ?? ""))?.[1] : undefined;
    if (blockedBy !== undefined && !(Number(by) >= Number(blockedBy))) return no(`blocked by comment ${blockedBy}: a blocking marker was deleted: post a new marker`, current);
    return { ok: true, reason: `${owner} recorded verdict=clean for ${current}`, head: current };
  } catch (e) { return no(`cannot read the pull request (${e.message}): refused`); }
}

/**
 * `post`: also post the verdict as the commit status `independent-review` on the pull request's head (and again while it changes).
 * The result then says `posted: true` when the status that stands on the head is the final verdict (whether it is success or failure): the verdict
 * is carried by the status, and the command that posts it has done its job. `posted` is absent when nothing stands (the pull request could not be
 * read, the status could not be written, the verdict kept changing): that is an error, not a verdict.
 */
export async function reviewMarker({ owner, repository, pr, head, token, fetch: f = globalThis.fetch, api = "https://api.github.com", post = false }) {
  const no = (reason) => ({ ok: false, reason });
  if (!owner) return no("the project has no owner.github in the kit registry: the marker's author cannot be checked");
  if (head && !SHA_RE.test(head)) return no(`--head ${head} is not a 40-hex commit`);
  if (!/^\d+$/.test(String(pr ?? ""))) return no(`--pr ${pr} is not a pull request number`);
  if (!token) return no("GH_TOKEN is not set (the job's github.token)");
  const call = async (method, path, body) => {
    const r = await f(`${api}${path}`, { method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}`);
    return r.json();
  };
  const get = (path) => call("GET", path);
  let result = await evaluate({ owner, repository, pr, head, get });
  if (!post) return { ok: result.ok, reason: result.reason };
  if (!SHA_RE.test(result.head || "")) return { ok: false, reason: result.reason };
  for (let round = 0; round < 5; round++) {
    try { await call("POST", `/repos/${repository}/statuses/${result.head}`, { state: result.ok ? "success" : "failure", context: REVIEW_CONTEXT, description: result.reason.slice(0, 140) }); }
    catch (e) { return { ok: false, reason: `the verdict cannot be posted as a status (${e.message}): refused` }; }
    const again = await evaluate({ owner, repository, pr, head: undefined, get });
    if (again.ok === result.ok && again.head === result.head) return { ok: result.ok, reason: result.reason, posted: true };
    result = again;                                   // the marker or the head changed while posting: post the latest, never a stale verdict
    if (!SHA_RE.test(result.head || "")) return { ok: false, reason: result.reason };
  }
  return { ok: false, reason: "the independent-review verdict kept changing while it was posted: re-run the check" };
}
