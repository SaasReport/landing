/**
 * The rules of a broker config the schema cannot state, applied wherever a broker is built (the Worker and any caller
 * of createBroker): every named action exists, a reviewer never writes, agent ids are unique and no key is shared.
 */
import { BrokerError } from "./errors.js";

export function checkConfig(config) {
  const writes = (act) => act === "merge" || Object.values(config.actions[act].permissions).includes("write");
  for (const a of config.agents) {
    for (const act of a.actions) if (act !== "merge" && !Object.hasOwn(config.actions, act)) throw new BrokerError("config_invalid", `${a.id} names unknown action ${act}`);
    // Separation of duties: a reviewer never writes, so it can never review (or merge) its own work.
    if (a.reviewer && a.actions.some(writes)) throw new BrokerError("config_invalid", `${a.id} is a reviewer with a write action`);
  }
  if (new Set(config.agents.map((a) => a.id)).size !== config.agents.length) throw new BrokerError("config_invalid", "duplicate agent id");
  // Compare the key bytes, not their spelling (the schema requires canonical base64 as well).
  const keys = config.agents.map((a) => Array.from(atob(a.publicKey), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  if (new Set(keys).size !== keys.length) throw new BrokerError("config_invalid", "an agent key is shared");
  return config;
}
