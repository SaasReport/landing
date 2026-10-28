/**
 * The daemon's identity integration (docs/AGENT-GUARD.md): which principal an event belongs to, the context it is told, the git commit-msg trailers, the
 * evidence signatures and the witness. Role-level principals: the main session, a subagent type, Codex; each with its OWN key from the key store.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { EvidenceLog, fileWitness } from "./evidence.js";
import { agentId, hasKey, keyDir, signBytes, slug, trailerText, fingerprintOf } from "./identity.js";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync as rf } from "node:fs";
import { gitEnv } from "../git.js";

const sh = (cwd, args, env) => new Promise((res, rej) => execFile("git", args, { cwd, env: gitEnv({ ...process.env, GIT_INDEX_FILE: env.GIT_INDEX_FILE }, { keep: ["GIT_INDEX_FILE"] }), encoding: "utf8" }, (e, o) => (e ? rej(e) : res(o))));
const projectKey = (root) => { try { return JSON.parse(readFileSync(join(root, "kit.canon.json"), "utf8")).project || "unknown"; } catch { /* unparseable input counts as absent, never as a valid value */ return "unknown"; } };
export const witnessPath = (root, env = process.env) => join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "kit-agent-guard/witness", `${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}.jsonl`);

export function identityExtras(root, kitRegistryFile, env = process.env) {
  const domain = slug(projectKey(root)), dir = keyDir(env);
  const idOf = (payload) => {
    const codex = payload.turn_id != null;
    if (payload.agent_id) return agentId({ domain, kind: "subagent", local: payload.agent_type || "unknown" });
    return agentId({ domain, kind: codex ? "codex" : "main", local: codex ? "codex" : "claude-code" });
  };
  const principalOf = (payload) => {
    let id; try { id = idOf(payload); } catch { /* failure here means no value; the caller holds on the empty answer */ return null; }
    if (!hasKey(dir, id)) return { id, fingerprint: null, sign: null };
    const f = join(dir, `${createHash("sha256").update(id).digest("hex").slice(0, 16)}.key`);
    const pub = createPublicKey(createPrivateKey(rf(f))).export({ type: "spki", format: "der" }).toString("base64");
    return { id, fingerprint: fingerprintOf(pub), sign: (h) => signBytes(dir, id, h) };
  };
  const guardKey = agentId({ domain, kind: "ci", local: "guard-daemon" });
  const witnessSign = hasKey(dir, guardKey) ? (t) => signBytes(dir, guardKey, t) : null;
  return {
    principalOf,
    signDecision: witnessSign,
    witness: fileWitness(witnessPath(root, env), witnessSign),
    contextSuffix(payload) {
      const p = principalOf(payload);
      if (!p) return "";
      return `\nYour kit principal id is ${p.id}${p.fingerprint ? ` (key ${p.fingerprint}). Your commits are signed with it by the commit-msg hook.` : ". It has no key yet, so your commits cannot be attributed: the owner issues it with `kit agent-guard identity issue`."}`;
    },
    /** A git commit an agent makes carries its principal id in the environment of that command, so the commit-msg hook can sign for the right agent. */
    updatedInput(payload) {
      if (payload.tool_name !== "Bash" || !payload.tool_input?.command) return null;
      if (!/\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*(commit|merge|rebase|cherry-pick|am|revert)\b/.test(payload.tool_input.command)) return null;
      const p = principalOf(payload); if (!p) return null;
      return { ...payload.tool_input, command: `export KIT_AGENT_ID='${p.id}'; ${payload.tool_input.command}` };
    },
    /** The commit-msg boundary: sign the commit for the agent named in the environment, or hold when that agent has no key. */
    async commitMsg(payload) {
      const id = payload.agent_id;
      if (!id) return { action: "allow" };                                    // the owner's own commit: no agent trailer
      if (!hasKey(dir, id)) return { action: "deny", rule: "agent-identity", reason: `${id} has no signing key, so its commit cannot be attributed. The owner issues it: kit agent-guard identity issue.` };
      const cwd = payload.cwd; const env = payload.index ? { GIT_INDEX_FILE: payload.index } : {};
      const file = resolve(cwd, payload.file || "");
      if (!(file === root || file.startsWith(`${root}/`)) && !file.includes("/.git/")) return { action: "deny", rule: "agent-identity", reason: "the commit message file is outside the project" };
      const message = readFileSync(file, "utf8");
      const tree = (await sh(cwd, ["write-tree"], env)).trim();
      let parents = []; try { parents = [(await sh(cwd, ["rev-parse", "HEAD"], env)).trim()]; } catch { /* failure here means no value; the caller holds on the empty answer */ }
      return { action: "allow", trailer_text: trailerText(dir, id, { tree, parents, message }).replace(/\n/g, "\\n") };
    },
  };
}
export { EvidenceLog };
void existsSync;
