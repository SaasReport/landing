const STUB = "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\nexport class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\nexport class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n";
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true };
  return next(specifier, context);
}
