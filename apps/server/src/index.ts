import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { ActionCapabilityRegistry, FailureInjector } from "./action-capabilities.js";
import { ActionCoordinator } from "./action-coordinator.js";
import { MockBookingProvider } from "./mock-booking-provider.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const provider = new MockBookingProvider(
  path.join(config.dataDirectory, "mock-bookings.json"),
);
const actions = new ActionCoordinator(
  store,
  provider,
  new ActionCapabilityRegistry(),
  new FailureInjector(),
);
const service = new AgentService(config, store, workspaces, runner, actions);
await provider.initialize();
await service.initialize();
await actions.initialize();

const app = await createApp(config, service, actions);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
