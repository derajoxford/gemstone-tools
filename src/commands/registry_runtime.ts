// src/commands/registry_runtime.ts
// Glue used by index.ts so it can merge command JSON and execute add-on commands
import { extraCommandsJSON, findCommandByName } from './registry';

export function buildCommandsFinal(baseJSON: any[]) {
  // baseJSON and extraCommandsJSON are already .toJSON()’d
  const byName = new Map<string, any>();
  const put = (arr: any[] | undefined) => {
    if (!arr) return;
    for (const c of arr) {
      const name = (c as any)?.name;
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, c);
    }
  };
  put(baseJSON);
  put(extraCommandsJSON);
  return Array.from(byName.values());
}

export async function tryExecuteRegistry(i: any) {
  const m = findCommandByName(i.commandName);
  if (m?.execute) return m.execute(i);
  return null;
}
