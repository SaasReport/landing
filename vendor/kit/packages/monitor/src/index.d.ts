export interface JourneyResult { name: string; ok: boolean; ms: number; attempts: number; error?: string; notes?: string }
export interface Summary { ok: boolean; passed: number; failed: string[]; flaky: string[]; total: number }
export interface JourneyContext {
  site: string; config: any; now: Date; today: string;
  page(pathOrUrl: string): Promise<{ p: any; errors: string[] }>;
  get(pathOrUrl: string, init?: RequestInit): Promise<Response>;
  json(path: string): Promise<any>;
  expect(cond: unknown, message: string): void;
  sel: Record<string, any>; paths: Record<string, any>; m: Record<string, any>; ignore: (string | RegExp)[];
}
export interface Journey { name: string; builtin: boolean; run(ctx: JourneyContext): Promise<string | void> }
export type CustomJourney =
  | { name: string; run(ctx: JourneyContext): Promise<string | void> }
  | { name?: string; path: string; status?: number; contains?: string | string[]; selectors?: string[]; browser?: boolean; json?(data: any): boolean | string | void; consoleErrors?: boolean };

export function createMonitor(config: any, deps?: { puppeteer?: any; channels?: any; fetch?: typeof fetch; now?: () => Date }): {
  worker: { scheduled(event: any, env: any, ctx: any): Promise<void>; fetch(request: Request, env: any): Promise<Response> };
  default: { scheduled(event: any, env: any, ctx: any): Promise<void>; fetch(request: Request, env: any): Promise<Response> };
  MonitorRunner: new (ctx: any, env: any) => { run(trigger?: string): Promise<any>; fetch(request: Request): Promise<Response> };
  statusHandler: typeof statusHandler;
  journeys: string[];
};
export function runJourney(name: string, fn: (o: { attempt: number }) => Promise<unknown>, o?: { retries?: number; now?: () => number; onRetry?: (r: JourneyResult) => unknown }): Promise<JourneyResult>;
export function summarize(results: JourneyResult[]): Summary;
export function expect(cond: unknown, message: string): void;
export function journeys(config: any): Journey[];
export function journeyList(config: any): string[];
export function journeyContext(config: any, o: { page: any; get: any; site: string; now?: Date }): JourneyContext;
export function podcastSeries(config: any): { series: string; show: string; maxSeconds: number | null }[];
export function localParts(config: any, now?: Date): { iso: string; weekday: number; day: number; localDay: number; hm: string };
export function isDueToday(series: any, parts: ReturnType<typeof localParts>): boolean;
export function seriesDueToday(config: any, now?: Date): any[];
export function monitorSettings(config: any): { m: any; sel: Record<string, any>; paths: Record<string, any> };
export function statusHandler(env: any, o?: { limit?: number; db?: any; config?: any; now?: number | null }): Promise<Response>;
export type ReasonCode = "not-configured" | "timeout" | "rejected" | "provider-error" | "unreachable" | "failed" | "never-attempted";
export const REASON_CODES: readonly ReasonCode[];
export function reasonCode(text: unknown): ReasonCode | null;
export interface RouteFreshness { route: string; last_attempt_at: string | null; last_ok_at: string | null; last_reason: ReasonCode | null; failed: number }
export function statusDocument(rows: any[], o?: { now?: number | null; staleAfterMin?: number; deliveries?: any[]; declared?: string[] }): { ok: true; reason?: ReasonCode; status: "passing" | "failing" | "unknown" | "stale"; last: any; recent: any[]; routes: RouteFreshness[]; stale?: boolean; future?: boolean; age_min?: number | null; stale_after_min?: number };
export function routeFreshness(deliveries: any[], declared?: string[]): RouteFreshness[];
export function readiness(env: any, config?: any): string[];
export function assertReady(env: any, config?: any): void;
export function routes(env: any, config?: any, o?: { fetch?: typeof fetch }): { channel: string; adapter?: any; problem?: string }[];
export function routeSpec(env: any, config?: any): Record<string, any>;
export function deadManUrlProblem(provider: string, url: string): string | null;
export const DEAD_MAN_PROVIDERS: readonly string[];
export function canaryFor(config: any, site: string, started: string): { subject: string; lines: string[]; url: string; reference: string; idempotencyKey: string };
/** The delivery kinds, from contracts/delivery.schema.json. */
export const DELIVERY_KINDS: readonly string[];
/** The alert drill's message (POST /run?mode=drill): marked "ALERT DRILL — not an incident", sent through every route whatever the health. */
export function drillFor(config: any, site: string, started: string): { subject: string; lines: string[]; url: string; reference: string; idempotencyKey: string };
export function monitorDb(env: any, config?: any): any;
export function staleness(lastStartedAt: string | null, now?: number | Date, afterMin?: number): { stale: boolean; ageMin: number | null; future: boolean };
export function pingDeadMan(env: any, config?: any, outcome?: "ok" | "fail" | "start", o?: { fetch?: typeof fetch }): Promise<{ sent: boolean; provider: string; status?: number; error?: string; skipped?: string }>;
export function guardSettings(config?: any, env?: any): { dbBinding: string; deadManEnv: string; staleAfterMin: number; fetchTimeoutMs: number };
export class MonitorNotReady extends Error { problems: string[] }
export const GUARD_DEFAULTS: Readonly<{ dbBinding: string; deadManEnv: string; staleAfterMin: number; fetchTimeoutMs: number }>;
export function staleAlert(config: any, site: string, lastStartedAt: string, ageMin: number, started: string): { subject: string; lines: string[]; url: string; reference: string; idempotencyKey: string };
export function createRunnerClass(config: any, deps?: object): any;
export function alertFor(config: any, site: string, sum: Summary, results: JourneyResult[], started: string): { subject: string; lines: string[]; url: string; reference: string; idempotencyKey: string };
export const BUILTINS: Record<string, { when(config: any): boolean; run(ctx: JourneyContext): Promise<string | void> }>;
export const DEFAULT_SELECTORS: Record<string, any>;
export const DEFAULT_PATHS: Record<string, any>;
export const KEEP_ALIVE_MS: number;

// ---- runtime exports declared by name (packages/cli/test/types.test.mjs keeps this list complete); the JSDoc in
// the source documents each; the parameters are typed loosely until each gets its precise type ----
export declare function hasStarted(series: any, parts: any): any;
