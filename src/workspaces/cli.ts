#!/usr/bin/env bun
/**
 * Workspace provisioning CLI for system admins.
 *
 * Usage:
 *   bun run src/workspaces/cli.ts create <name> <ownerUserId>
 *   bun run src/workspaces/cli.ts list
 *   bun run src/workspaces/cli.ts status <workspaceId>
 */
import { config } from "../config.js";
import { JsonWorkspaceStore } from "./store.js";

const store = new JsonWorkspaceStore(config.workspaceStorePath, config.workspaceDataDir);
await store.load();

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "create": {
    const [name, ownerId] = args;
    if (!name || !ownerId) {
      console.error("Usage: create <name> <ownerUserId>");
      process.exit(1);
    }
    const ws = await store.create(name, ownerId);
    console.log(`Created workspace: ${ws.name} (${ws.id})`);
    console.log(`GWS config dir: ${ws.gwsConfigDir}`);
    console.log(`\nNext: authenticate GWS for this workspace:`);
    console.log(`  docker exec -it assistant gws auth login --config-dir ${ws.gwsConfigDir}`);
    break;
  }

  case "list": {
    const workspaces = store.getAll();
    if (workspaces.length === 0) {
      console.log("No workspaces found.");
      break;
    }
    for (const ws of workspaces) {
      const memberCount = Object.keys(ws.members).length;
      console.log(`${ws.id}  ${ws.name}  (owner: ${ws.ownerId}, members: ${memberCount})`);
    }
    break;
  }

  case "status": {
    const [wsId] = args;
    if (!wsId) {
      console.error("Usage: status <workspaceId>");
      process.exit(1);
    }
    const ws = store.get(wsId);
    if (!ws) {
      console.error(`Workspace not found: ${wsId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(ws, null, 2));
    break;
  }

  default:
    console.error("Commands: create, list, status");
    process.exit(1);
}
