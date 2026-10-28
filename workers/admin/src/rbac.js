// RBAC: the roles of admin.config.json and the permission each operation of the contract names (x-permission). The identities on the Access
// allowlist are owners; a request is allowed when its role holds the permission of the operation.
import { config } from "./config.js";
import { operations } from "./contract.js";
import { CONTRACT } from "./contract.js";

const PERMISSION = new Map();
for (const item of Object.values(CONTRACT.paths)) for (const op of Object.values(item)) if (op.operationId) PERMISSION.set(op.operationId, op["x-permission"]);

export const permissionOf = (operationId) => PERMISSION.get(operationId);
export const roleOf = (id) => config.roles.find((r) => r.id === id);
/** May a role perform the operation? An unknown role, an unknown operation or an operation with no permission is refused. */
export function can(roleId, operationId) {
  const need = PERMISSION.get(operationId), role = roleOf(roleId);
  return Boolean(role && need && role.permissions.includes(need));
}
export { operations };
