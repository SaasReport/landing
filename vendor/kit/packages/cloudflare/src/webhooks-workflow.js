/** Workers-only entry: the WebhookWorkflow class on top of Cloudflare's WorkflowEntrypoint (see webhooks.js). */
import { WorkflowEntrypoint } from "cloudflare:workers";
import { webhookWorkflowClass } from "./webhooks.js";

/**
 * export const WebhookWorkflow = createWebhookWorkflow({ webhooks: config.webhooks });
 * wrangler.toml: [[workflows]] name = "<project>-webhooks", binding = "WEBHOOK_WF", class_name = "WebhookWorkflow"
 */
export const createWebhookWorkflow = (opts = {}) => webhookWorkflowClass(opts.Base ?? WorkflowEntrypoint, opts);
export { webhookWorkflowClass, enqueueWebhooks, subscribersFrom, intakeWebhook, parseKeys } from "./webhooks.js";
