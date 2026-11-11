/** @saasreport/calendar/relative — Persian relative date expressions («سه روز کاری بعد از ۱۵ مهر ساعت ۱۰») on top of parseInput. */
export interface ResolveStep { step: "time" | "count" | "unit" | "direction" | "anchor" | "profile"; value: string }
export interface ResolveAssumption { kind: "year"; value: string }
export interface Resolved { ok: true; input: unknown; day: number; iso: string; time: string | null; uncertain: boolean; steps: ResolveStep[]; assumptions: ResolveAssumption[] }
export interface ResolveFailure { ok: false; input: unknown; error: { code: string; message: string }; steps: ResolveStep[] }
export declare function resolveRelative(input: unknown, options?: { now?: Date | number; timeZone?: string; profile?: "bank" | "government" | "market" }): Resolved | ResolveFailure;
