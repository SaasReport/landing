/**
 * Who acts. The lifecycle table says which actor type may cause each transition; the actor is a PRINCIPAL the engine hands to the
 * transition, never a parameter a caller passes:
 *   - system principals (intake, rollback, rescan, reconciler, migrate, withdraw) and the retention principal are constants of the engine;
 *   - a human principal exists only as the result of authority.js: the verified entry of the approval ledger (kit.approval-ledger.v1,
 *     ledger id <project>:uploads). No cryptography lives here: the ledger code (@saasreport/core ledger.js, ed25519.js) verifies; this file
 *     only holds the type.
 */
const TOKEN = Symbol("principal");
export class Principal {
  constructor(token, type, id, extra = {}) {
    if (token !== TOKEN) throw new TypeError("a principal is made by the engine, never by a caller");
    this.type = type; this.id = id;
    Object.assign(this, extra);
    Object.freeze(this);
  }
}
const system = (name) => new Principal(TOKEN, "system", `system:${name}`);
export const SYSTEM = Object.freeze({ intake: system("intake"), rollback: system("rollback"), rescan: system("rescan"), reconciler: system("reconciler"), migrate: system("migrate"), withdraw: system("withdraw") });
export const RETENTION = new Principal(TOKEN, "retention", "system:retention");
/** A human principal. Called only by authority.js, with the facts of a verified ledger entry. */
export const humanPrincipal = (member, ref, decidedAt) => new Principal(TOKEN, "human", `human:${member}`, { member, ref, decided_at: decidedAt });
