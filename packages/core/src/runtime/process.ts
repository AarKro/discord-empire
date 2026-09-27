/**
 * Process-level crash policy (framework spec §9 "bots are stateless — kill or
 * restart any time").
 *
 * An error nothing caught — a rejected promise fired with `void`, a throw in an
 * event-emitter callback — must not be swallowed: a process that carries on in
 * an unknown state (a dead DB pool, a half-applied handler) can look alive while
 * doing no work. So we log it and exit, and let the orchestrator restart us
 * (`restart: unless-stopped` in infra/docker-compose.yml). That is lossless by
 * construction: the bus replays everything after this consumer's cursor on boot,
 * and every timer lives in the database, not in memory.
 */
import type { Logger } from "../logger.js";

let installed = false;

/** Log any uncaught error or unhandled rejection, then exit(1). Idempotent. */
export function installCrashHandlers(log: Logger): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    log.fatal({ err: reason }, "unhandled rejection; exiting for a clean restart");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception; exiting for a clean restart");
    process.exit(1);
  });
}
