// Module-private in-process seam for the kit's OWN tests (not in the package's exports map, so a consumer of @saasreport/cli cannot reach it):
// io[TEST] = { prompt, registry, trust, owner, ownerKeys, repo, witness }. The shipped CLI builds its io from the process, so it never has one.
export const TEST = Symbol("kit.test-seam");
