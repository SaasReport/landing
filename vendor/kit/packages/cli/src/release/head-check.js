/**
 * `kit release head-check` (docs/RELEASE.md, central mode): the deployer's re-read of the source's main HEAD, as a command that FAILS CLOSED.
 * `git ls-remote` over SSH with the project's read-only deploy key (already loaded in ssh-agent; the host key pinned by the workflow's
 * GIT_SSH_COMMAND with StrictHostKeyChecking=yes and a UserKnownHostsFile) answers refs/heads/main of the registered source repository,
 * and that answer must equal BOTH KIT_RELEASE_SOURCE_SHA (the commit about to be shipped) and the checkout's HEAD (the tree that was
 * tested). Any mismatch, an unreadable answer, anything but exactly one refs/heads/main line, an unpinned host key, or a source that is not
 * registered for the project is a refusal (exit 1): a bare `git ls-remote` line in a workflow compares nothing, this command does.
 * Every outside effect is a dependency (lsRemote, checkoutHead), so the tests need no network.
 */
import { releaseIdentity, SHA_RE } from "./config.js";

export class HeadCheckError extends Error {}
const fail = (m) => { throw new HeadCheckError(m); };

/** `git ls-remote` output → the sha of refs/heads/main; anything but exactly one such line is refused. */
export function parseLsRemote(out) {
  const lines = String(out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const main = lines.map((l) => l.split(/\s+/)).filter(([, ref]) => ref === "refs/heads/main");
  if (lines.length !== 1 || main.length !== 1) fail(`ls-remote answered ${lines.length} line(s), not exactly refs/heads/main`);
  if (!SHA_RE.test(main[0][0])) fail(`ls-remote: ${main[0][0]} is not a commit`);
  return main[0][0];
}

/** Why GIT_SSH_COMMAND does not pin GitHub's host key (or null): the re-read must not trust whatever answers. */
export function sshPinProblem(cmd) {
  const c = String(cmd ?? "");
  if (!/\bStrictHostKeyChecking=yes\b/.test(c)) return "GIT_SSH_COMMAND does not set StrictHostKeyChecking=yes";
  if (!/\bUserKnownHostsFile=\S+/.test(c)) return "GIT_SSH_COMMAND names no UserKnownHostsFile (the pinned host key)";
  return null;
}

/**
 * → { repository, sha } or throws HeadCheckError. deps: { doc, kit, env, lsRemote(repository) → output text, checkoutHead() → sha }.
 */
export async function headCheck({ doc, kit, env, lsRemote, checkoutHead }) {
  let id;
  try { id = releaseIdentity(doc, env, kit); } catch (e) { fail(e.message); }
  if (!id.central) fail("kit release head-check is for central mode (release.json deployer): in local mode the run's own main HEAD is read from the API");
  const pin = sshPinProblem(env.GIT_SSH_COMMAND);
  if (pin) fail(`${pin}: the re-read of main's HEAD must trust only GitHub's pinned host key`);
  let head;
  try { head = parseLsRemote(await lsRemote(id.source)); } catch (e) { fail(e instanceof HeadCheckError ? e.message : `git ls-remote of ${id.source} failed (${e.message}): refused`); }
  if (head !== id.commit) fail(`${id.source}'s main is ${head}, not KIT_RELEASE_SOURCE_SHA ${id.commit}: only the source's main HEAD is deployed`);
  let at;
  try { at = await checkoutHead(); } catch (e) { fail(`the checkout's HEAD cannot be read (${e.message})`); }
  if (at !== id.commit) fail(`the checkout is at ${at}, not ${id.commit}: what is shipped must be the commit that was tested`);
  return { repository: id.source, sha: head };
}
