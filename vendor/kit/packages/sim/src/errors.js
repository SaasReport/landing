/** The one error of the engines: a refusal, never a wrong number. `code` is stable, `path` points into the input. */
export class SimError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.path = path;
  }
}

/** Refuse unless `cond` holds. */
export function need(cond, code, message, path = "") {
  if (!cond) throw new SimError(code, message, path);
}

export const isNum = (x) => typeof x === "number" && Number.isFinite(x);
