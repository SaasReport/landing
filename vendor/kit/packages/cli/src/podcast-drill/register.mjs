// Preloaded by the drill child (node --conditions=workerd --import register.mjs): the Workers-only module "cloudflare:workers" that the
// project's Worker and @saasreport/podcast (export condition "workerd") import resolves to a stub whose WorkflowEntrypoint is a plain class
// holding (ctx, env), the way the platform constructs it. Nothing else of the platform is faked here.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
