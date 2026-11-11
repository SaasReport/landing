/**
 * The few GitHub calls the broker makes, as the App: find the installation, mint a downscoped installation token,
 * read a pull request, its check runs and its combined status, and merge pinned to a head sha. `fetch` is injected
 * (tests, Workers). Upstream failures become `upstream_failed`; the response body is never echoed (it may carry a
 * token).
 */
import { BrokerError } from "./errors.js";

const API_VERSION = "2022-11-28";
const MAX_CHECK_PAGES = 10;

export function githubClient({ api, fetch: doFetch = globalThis.fetch, userAgent }) {
  async function send(method, path, token, body) {
    try {
      return await doFetch(`${api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
          "user-agent": userAgent,
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new BrokerError("upstream_failed", `${method} ${path.split("?")[0]}: network`);
    }
  }

  async function call(method, path, token, body) {
    const res = await send(method, path, token, body);
    if (!res.ok) throw new BrokerError("upstream_failed", `${method} ${path.split("?")[0]}: ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  const revoke = (token) => call("DELETE", "/installation/token", token);

  return {
    revoke,
    /** The installation id of the app on an organisation (app JWT). */
    async installationId(jwt, owner) {
      const r = await call("GET", `/orgs/${encodeURIComponent(owner)}/installation`, jwt);
      if (!Number.isInteger(r?.id)) throw new BrokerError("upstream_failed", "installation has no id");
      return r.id;
    },
    /**
     * An installation token for exactly one repository and at most these permissions (app JWT). A grant wider than
     * asked is revoked at once and refused.
     */
    async installationToken(jwt, installationId, repo, permissions) {
      const r = await call("POST", `/app/installations/${installationId}/access_tokens`, jwt, { repositories: [repo], permissions });
      if (typeof r?.token !== "string" || !r.token) throw new BrokerError("upstream_failed", "no token in response");
      const granted = r.permissions || {};
      const wider = Object.entries(granted).find(([k, v]) =>
        !(k === "metadata" && v === "read") && permissions[k] !== v && !(permissions[k] === "write" && v === "read"));
      const repos = (r.repositories || []).map((x) => x.name);
      if (wider || repos.length > 1 || (repos.length === 1 && repos[0] !== repo)) {
        await revoke(r.token).catch(() => {});   // the wider grant is refused either way; an unrevoked token still expires within the hour
        throw new BrokerError("upstream_failed", wider ? `granted ${wider[0]}:${wider[1]} beyond the request` : "granted other repositories");
      }
      return { token: r.token, expiresAt: r.expires_at, permissions: granted };
    },
    async pull(token, owner, repo, pr) {
      const r = await call("GET", `/repos/${owner}/${repo}/pulls/${pr}`, token);
      return {
        state: r.state, merged: r.merged === true, mergeable: r.mergeable, head: r.head?.sha, base: r.base?.ref, draft: r.draft === true,
        mergeCommit: typeof r.merge_commit_sha === "string" ? r.merge_commit_sha : null,
      };
    },
    /** Every check run on a commit (paginated, bounded), with the id of the app that created it. */
    async checkRuns(token, owner, repo, sha) {
      const runs = [];
      for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
        const r = await call("GET", `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`, token);
        const batch = (r.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, appId: c.app?.id ?? null }));
        runs.push(...batch);
        if (runs.length >= (r.total_count || 0) || !batch.length) return runs;
      }
      throw new BrokerError("upstream_failed", "too many check runs to read");
    },
    /** The combined legacy commit status: "success", "pending" or "failure", and how many statuses it combines. */
    async combinedStatus(token, owner, repo, sha) {
      const r = await call("GET", `/repos/${owner}/${repo}/commits/${sha}/status`, token);
      // A reply without a count or a known state is not "no statuses": fail closed.
      if (!Number.isInteger(r?.total_count) || !["success", "pending", "failure", "error"].includes(r?.state)) {
        throw new BrokerError("upstream_failed", "malformed commit status");
      }
      return { state: r.state, count: r.total_count };
    },
    /**
     * Merge pinned to the head sha. A 4xx is a definite refusal (`definite: true`: GitHub did not merge). Anything else
     * that goes wrong (network, 5xx, an unreadable reply) is indefinite: GitHub may have merged, and the caller must
     * read the pull request back before saying either way.
     */
    async merge(token, owner, repo, pr, sha, method) {
      const definite = (e) => Object.assign(e, { definite: true });
      const res = await send("PUT", `/repos/${owner}/${repo}/pulls/${pr}/merge`, token, { sha, merge_method: method });
      if (res.status === 409) throw definite(new BrokerError("head_moved", "GitHub refused: the head is not the reviewed sha"));
      if (res.status === 405 || res.status === 422) throw definite(new BrokerError("not_mergeable", `GitHub refused the merge: ${res.status}`));
      if (res.status >= 400 && res.status < 500) throw definite(new BrokerError("upstream_failed", `PUT merge: ${res.status}`));
      if (!res.ok) throw new BrokerError("upstream_failed", `PUT merge: ${res.status}`);
      const r = await res.json().catch(() => null);   // an unreadable merge reply is the indefinite outcome thrown just below
      if (r?.merged !== true) throw new BrokerError("upstream_failed", "unreadable merge reply");
      return { sha: r.sha };
    },
  };
}
