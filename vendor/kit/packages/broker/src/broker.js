/**
 * The broker's decisions, independent of HTTP. Two acts:
 *
 *   token(msg)  a registered agent, allowed this action on this repository, gets an installation token scoped to
 *               that one repository and the action's permissions. The evidence record is written before the token
 *               leaves; if it cannot be written the token is revoked and nothing is returned.
 *   merge(msg)  the broker merges, never the agent: the agent may merge, a different registered reviewer signed
 *               "clean" for exactly this base and head and named this agent; the base is one the broker serves; the
 *               pull request is open, not a draft, mergeable and still at that base and head; every required check
 *               (by name and creating app) is present and every run and commit status on the head is green. The
 *               merge is pinned to the head sha, so a push after the review cannot ride along.
 *
 * Unauthenticated requests (malformed, unknown agent, bad signature, stale) are refused without a record (nobody to
 * attribute them to, and a flood must not grow the chain). From authentication on, every allow and deny is recorded.
 */
import { appJwt } from "./jwt.js";
import { BrokerError } from "./errors.js";
import { githubClient } from "./github.js";
import { appendEvidence } from "./evidence.js";
import { authenticate, parseRequest, requestDigest, verifyReview } from "./verify.js";
import { checkConfig } from "./config.js";

/** Read-back delays after an unclear merge failure (seconds 1, 3, 6: well inside a Worker request). */
const SETTLE_MS = Object.freeze([1000, 3000, 6000]);

/**
 * The broker's own token for a merge: read the pull request, its check runs and its commit statuses, write the merge.
 * Never handed out. The App therefore needs Contents RW, Pull requests RW, Checks R and Commit statuses R.
 */
export const MERGE_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", checks: "read", statuses: "read" });

export function createBroker({
  config, privateKey, store, fetch, now = () => Math.floor(Date.now() / 1000), userAgent,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  checkConfig(config); // the same rules whether the Worker or a caller builds the broker
  // Nonces are kept as long as a signed request or review can still be accepted.
  const retention = Math.max(config.freshnessSeconds, config.merge.reviewMaxAgeSeconds) + config.freshnessSeconds;
  const gh = githubClient({ api: config.githubApi, fetch, userAgent: userAgent || `${config.project}-broker` });

  async function installationToken(repo, permissions) {
    const t = now();
    const jwt = await appJwt({ appId: config.app.id, privateKey, now: t });
    const id = await gh.installationId(jwt, config.app.owner);
    return gh.installationToken(jwt, id, repo, permissions);
  }

  const base = (msg) => ({ at: now(), project: config.project, agent: msg.agent, action: msg.action, repo: msg.repo, request: requestDigest(msg) });
  const record = (msg, fields) => appendEvidence(store, { ...base(msg), ...fields });

  /** Run an authenticated act; a refusal from here on is recorded, then rethrown. */
  async function governed(msg, act) {
    try {
      return await act();
    } catch (e) {
      const reason = e instanceof BrokerError ? e.reason : "upstream_failed";
      // Already recorded (an outcome after a merge attempt), or the record itself failed: never write a deny over it.
      if (!e?.recorded && reason !== "evidence_failed" && reason !== "merged_evidence_failed") await record(msg, { decision: "deny", reason, ...(msg.pr ? { pr: msg.pr } : {}), ...(msg.base ? { base: msg.base } : {}), ...(msg.head ? { head: msg.head } : {}) });
      throw e instanceof BrokerError ? e : new BrokerError("upstream_failed");
    }
  }

  async function admit(raw, route) {
    const msg = parseRequest(raw);
    const t = now();
    const agent = await authenticate(config, msg, t);
    return { msg, agent, t, route };
  }

  /**
   * Every required check present on the head, created by its named app, completed with an allowed conclusion; every
   * other run completed and allowed too. Runs created by this broker's own app never count (an installation token
   * with checks:write is never issued, and the app's own runs are ignored besides).
   */
  function checksGreen(all) {
    const runs = all.filter((r) => r.appId !== config.app.id);
    const ok = new Set(config.merge.allowedConclusions);
    for (const req of config.merge.requiredChecks) {
      const mine = runs.filter((r) => r.name === req.name && r.appId === req.appId);
      if (!mine.length) throw new BrokerError("checks_not_green", `required check missing: ${req.name}`);
    }
    const bad = runs.filter((r) => r.status !== "completed" || !ok.has(r.conclusion));
    if (bad.length) throw new BrokerError("checks_not_green", `${bad.length} not green`);
  }

  /** The pull request read back after a merge attempt (twice at most); null when it cannot be read. */
  async function readBack(token, owner, repo, pr) {
    for (let i = 0; i < 2; i++) {
      const p = await gh.pull(token, owner, repo, pr).catch(() => null);   // an unreadable read-back is retried once, then reported as merge_outcome_unknown
      if (p && typeof p.base === "string" && p.base) return p;
    }
    return null;
  }

  function allowed(agent, msg) {
    if (!agent.actions.includes(msg.action)) throw new BrokerError("forbidden_action");
    if (!config.repos.includes(msg.repo)) throw new BrokerError("forbidden_repo");
  }

  return {
    async token(raw) {
      const { msg, agent, t } = await admit(raw);
      return governed(msg, async () => {
        if (!(await store.claimNonce(msg.agent, msg.nonce, t, retention))) throw new BrokerError("replayed");
        if (msg.action === "merge") throw new BrokerError("forbidden_action", "merge is not a token action");
        allowed(agent, msg);
        const permissions = config.actions[msg.action]?.permissions;
        if (!permissions) throw new BrokerError("forbidden_action", "no such token action");
        const tok = await installationToken(msg.repo, permissions);
        try {
          const ev = await record(msg, { decision: "allow", reason: "token_issued", permissions: tok.permissions, expiresAt: tok.expiresAt });
          return { token: tok.token, expiresAt: tok.expiresAt, permissions: tok.permissions, evidence: ev.seq };
        } catch (e) {
          await gh.revoke(tok.token).catch(() => {}); // the evidence error is the one to report
          throw e;
        }
      });
    },

    async merge(raw) {
      const { msg, agent, t } = await admit(raw);
      return governed(msg, async () => {
        if (!(await store.claimNonce(msg.agent, msg.nonce, t, retention))) throw new BrokerError("replayed");
        if (msg.action !== "merge") throw new BrokerError("forbidden_action", "not a merge request");
        allowed(agent, msg);
        if (!config.merge.allowedBases.includes(msg.base)) throw new BrokerError("forbidden_repo", "base branch not served");
        const reviewer = await verifyReview(config, msg, t);
        const tok = await installationToken(msg.repo, MERGE_PERMISSIONS);
        try {
          const owner = config.app.owner;
          const pr = await gh.pull(tok.token, owner, msg.repo, msg.pr);
          if (pr.state !== "open" || pr.merged || pr.draft) throw new BrokerError("not_mergeable", "not an open, ready pull request");
          if (pr.head !== msg.head) throw new BrokerError("head_moved");
          if (pr.base !== msg.base) throw new BrokerError("base_moved", "the base branch changed after the review");
          if (pr.mergeable !== true) throw new BrokerError("not_mergeable");
          checksGreen(await gh.checkRuns(tok.token, owner, msg.repo, msg.head));
          const status = await gh.combinedStatus(tok.token, owner, msg.repo, msg.head);
          if (status.count > 0 && status.state !== "success") throw new BrokerError("checks_not_green", `commit status ${status.state}`);
          // The review is spent only now, when every read-only gate has passed: an early attempt does not burn it.
          if (!(await store.claimNonce(reviewer.id, msg.review.nonce, t, retention))) throw new BrokerError("replayed", "the review was already used");
          // The decision is recorded before the irreversible act; only GitHub refusing the merge (a 4xx) is a deny after it.
          const pin = { pr: msg.pr, base: msg.base, head: msg.head, reviewer: reviewer.id };
          const ev = await record(msg, { decision: "allow", reason: "merge_admitted", ...pin });
          // GitHub's merge call pins the head but not the base: read the base again right before merging, so the
          // window for retargeting the pull request is one round trip (closed for good by rulesets on unserved branches).
          const again = await gh.pull(tok.token, owner, msg.repo, msg.pr);
          if (again.base !== msg.base) throw new BrokerError("base_moved");
          if (again.head !== msg.head) throw new BrokerError("head_moved");
          let reply = null;
          try {
            reply = await gh.merge(tok.token, owner, msg.repo, msg.pr, msg.head, config.merge.method);
          } catch (e) {
            if (e?.definite) throw e; // GitHub refused: nothing was merged, the deny is the truth
          }
          // From here GitHub may have merged (or may still be merging), so nothing is ever a refusal. One record says
          // what GitHub did, read back from the pull request: after an unclear failure it is polled with backoff, and a
          // pull request still unmerged at the end is an unknown outcome, never a deny (the merge may yet land).
          let seen = await readBack(tok.token, owner, msg.repo, msg.pr);
          if (!reply) for (const ms of SETTLE_MS) {
            if (seen?.merged) break;
            await sleep(ms);
            // An unmerged or unreadable result leads to the same outcome (unknown), so the latest read simply wins.
            seen = await readBack(tok.token, owner, msg.repo, msg.pr);
          }
          // GitHub said merged but the read-back is stale (still open): read once more; a base or commit taken from a
          // stale copy is never confirmed.
          if (reply && seen && !seen.merged) {
            await sleep(SETTLE_MS[0]);
            seen = await readBack(tok.token, owner, msg.repo, msg.pr);
          }
          const mergedSha = [reply?.sha, seen?.merged ? seen.mergeCommit : null].find((x) => /^[0-9a-f]{40}$/.test(x || ""));
          const reason = !reply && !seen?.merged ? "merge_outcome_unknown"
            : !seen || !mergedSha || !seen.merged ? "merged_unverified"
            : seen.base === msg.base ? "merged" : "merged_wrong_base";
          const fields = {
            decision: "allow", reason, ...pin, ...(mergedSha ? { merged: mergedSha } : {}),
            ...(reason === "merged_wrong_base" ? { base: seen.base, reviewedBase: msg.base } : {}),
          };
          const done = await record(msg, fields).catch(() => {
            throw new BrokerError("merged_evidence_failed", "the merge may have happened, but its record could not be written");
          });
          if (reason === "merge_outcome_unknown") {
            throw Object.assign(new BrokerError("merge_outcome_unknown", "GitHub's reply was lost and the merge could not be confirmed"), { recorded: true });
          }
          return { merged: true, ...(mergedSha ? { sha: mergedSha } : {}), evidence: done.seq, ...(reason !== "merged" ? { warning: reason } : {}) };
        } finally {
          await gh.revoke(tok.token).catch(() => {}); // expires within the hour regardless; the merge result stands
        }
      });
    },
  };
}
