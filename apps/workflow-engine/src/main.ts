/**
 * Workflow engine service entrypoint (framework spec §3). Contains no Discord
 * code of its own: it dispatches actions through the capability registry, whose
 * handlers reach Discord via @empire/core. Loads + validates workflow YAML at
 * boot, subscribes to the bus (lossless replay), and recovers timers.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadContentFile, Workflow } from "@empire/content-schemas";
import { CapabilityRegistry, EventBus, rootLogger, tradeCapability, topologyCapability } from "@empire/core";
import { openDb } from "@empire/db";
import { WorkflowRuntime } from "./runtime.js";

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";

function loadWorkflows(): Workflow[] {
  const dir = join(CONTENT_DIR, "workflows");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    rootLogger.warn({ dir }, "no workflows directory; running empty");
    return [];
  }
  return files.map((f) => loadContentFile(Workflow, join(dir, f)));
}

async function main(): Promise<void> {
  const log = rootLogger.child({ service: "workflow-engine" });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const { sql } = openDb(url);
  const bus = new EventBus(sql, "workflow-engine", log);

  // The engine dispatches verbs; register the capabilities whose actions
  // workflows may call. Registry is discoverable (foundation for a visual editor).
  const registry = new CapabilityRegistry();
  registry.register(tradeCapability());
  registry.register(topologyCapability());

  const workflows = loadWorkflows();
  log.info({ count: workflows.length, actions: registry.actionCatalog() }, "workflows loaded");

  const runtime = new WorkflowRuntime(workflows, {
    sql,
    bus,
    registry,
    logger: log,
    makeContext: (correlationId) => ({
      bot: "workflow-engine",
      sql,
      bus,
      // Workflow engine has no gateway/personas of its own; action handlers that
      // need Discord run inside bot processes. These are intentionally absent
      // here and such verbs are not registered on this service.
      gateway: undefined as never,
      personas: undefined as never,
      logger: log.child({ correlation_id: correlationId }),
      config: {},
    }),
  });

  await bus.subscribe((evt) => runtime.onEvent(evt));
  await runtime.recoverTimers();
  log.info("workflow engine ready");
}

main().catch((err) => {
  rootLogger.error({ err }, "workflow engine crashed");
  process.exit(1);
});
