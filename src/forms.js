// The project's lead forms (kit.lead-forms.v1, validated by kit check canon): one declaration per form the landing posts.
// The fields are the ones of the early-access modal in content/generated/landing.en.json; both come from content/copy.json.
import copy from "../content/copy.json" with { type: "json" };
import reportTypes from "../vendor/core/registry/report-types.json" with { type: "json" };
import naming from "../vendor/core/registry/naming.json" with { type: "json" };

const F = copy.form;
export const FORMS = {
  "early-access": {
    label: F.ownerLabel,
    template: `${naming.project}.early-access.ack.v1`,
    fields: [
      { key: "name", label: F.fields.name, required: true, max: 120 },
      { key: "email", label: F.fields.email, required: true, max: 200 },
      { key: "company", label: F.fields.company, required: true, max: 160 },
      { key: "role", label: F.fields.role, required: true, max: 200 },
      { key: "reports", label: F.fields.reports, multiple: true, options: reportTypes.report_types.map((r) => r.name) },
      { key: "message", label: F.fields.message, max: 2000 },
    ],
  },
};
export default FORMS;
