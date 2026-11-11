/**
 * The Persian REVIEW SCOPE: what persian.config.json decides about which text a native reader must approve: the file that holds it (kit.canon.json's `persian` pointer), the `sources` (their files, register and `mixed`) and the `exclude`
 * list. Both are agent-editable files, so the OWNER signs this hash into the trust record (`approvals.persian.scope`) and the gate refuses a scope that differs: an exclude added
 * "with a reason", a source dropped or a `mixed` switched is a change of what needs the owner's signature, never a free edit. Lint settings (classes, rules, allow) are not scope.
 */
import { canonicalJson } from "./canonical.js";
import { sha256 } from "./sha256.js";

/** `path` is the config file kit.canon.json's `persian` names: the pointer is agent-editable too, so WHICH file is the config is part of the scope. */
export const scopeHash = (cfg, path = "persian.config.json") => sha256(canonicalJson({ config: path, sources: cfg?.sources ?? [], exclude: cfg?.exclude ?? [] }));
