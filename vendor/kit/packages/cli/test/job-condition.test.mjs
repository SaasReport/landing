// The job-condition evaluator agent-guard uses to decide that a bench job runs (independent review of kit #135): every operator,
// GitHub's loose comparison and every refused term, called directly rather than through workflow fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobConditionProblem } from "../src/agent-guard/job-condition.js";

const G = "github.event_name != 'pull_request' || github.event.pull_request.draft == false";
const RUNS = [
  undefined, true, "true", G, `\${{ ${G} }}`, `(${G}) && github.event_name != 'schedule'`,
  "!github.event.pull_request.draft", "github.event_name == 'PUSH' || github.event_name == 'Pull_Request'",
  "!(github.event_name == 'schedule')", "github.event.pull_request.draft != true", `(${G}) && 'it''s' == 'IT''S'`,
  "github.event.pull_request.draft == null || github.event.pull_request.draft == false",
];
const SKIPS = [
  false, "false", `(${G}) && false`, "github.event_name == 'push'", "github.event_name == 'pull_request'",
  `(${G}) && github.event_name == 'schedule'`, "github.event.pull_request.draft", "!true",
  "github.event_name != 'push' && github.event_name != 'pull_request'",
];
const UNPROVEN = [
  "constructor", "toString", "vars.RUN == 'yes'", `(${G}) && github.actor != 'dependabot[bot]'`, "contains(github.ref, 'main')",
  "always()", "success()", "github.event_name ==", "(github.event_name == 'push'", "github.event_name = 'push'",
];

test("conditions that run on a push and on a non-draft pull request", () => {
  for (const c of RUNS) assert.equal(jobConditionProblem(c), null, String(c));
});
test("conditions false on a push or on a non-draft pull request", () => {
  for (const c of SKIPS) assert.match(String(jobConditionProblem(c)), /false|is false on/, String(c));
});
test("conditions the evaluator cannot prove are refused, never assumed (inherited names included)", () => {
  for (const c of UNPROVEN) assert.match(String(jobConditionProblem(c)), /cannot be (proven|read)/, String(c));
});
test("only the events the workflow runs on are evaluated: a pull-request-only workflow need not run on push", () => {
  assert.equal(jobConditionProblem("github.event_name == 'pull_request'", ["pull_request"]), null);
  assert.match(String(jobConditionProblem("github.event_name == 'pull_request'", ["push", "pull_request"])), /false on push/);
});
