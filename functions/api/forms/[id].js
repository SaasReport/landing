// Cloudflare Pages Function: POST /api/forms/<id> (contracts/forms.openapi.json). The logic is src/form-intake.js;
// the declaration is src/forms.generated.js, written by scripts/generate.mjs from src/forms.js.
import { intake } from "../../../src/form-intake.js";
import FORMS from "../../../src/forms.generated.js";

export const onRequest = (context) => intake(context.request, context.env, String(context.params.id), FORMS);
