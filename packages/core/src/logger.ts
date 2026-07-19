/**
 * Structured JSON logging keyed by correlation id (tech spec §Logging).
 * A child logger bound to a correlation id ties an entire event chain together
 * (stall click → dialogue → offer → trade), the primary debugging affordance.
 */
import pino from "pino";

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: { level: (label) => ({ level: label }) },
});

export type Logger = pino.Logger;

export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlation_id: correlationId });
}
