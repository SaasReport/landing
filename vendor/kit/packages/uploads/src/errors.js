/** Errors of the upload engine. */
export class IntegrityError extends Error { constructor(m) { super(m); this.name = "IntegrityError"; } }
export class UnknownFormError extends Error { constructor(form) { super(`no upload policy for form "${form}"`); this.name = "UnknownFormError"; this.form = form; } }
/** A compare-and-set write lost: the record changed (or is a final tombstone) since it was read. The operation aborted before touching any object. */
export class ConflictError extends Error { constructor(m, id) { super(m); this.name = "ConflictError"; this.upload_id = id; } }
/** A human decision that does not verify: unsigned, unknown key, wrong action, wrong file, stale, replayed, or no roster. */
export class AuthError extends Error { constructor(reason, detail) { super(`decision refused (${reason})${detail ? `: ${detail}` : ""}`); this.name = "AuthError"; this.reason = reason; } }
/** A retention delete refused by its own guard: the record is on hold or not past retain_until when it was read for the write. */
export class NotEligibleError extends Error { constructor(m) { super(m); this.name = "NotEligibleError"; } }
