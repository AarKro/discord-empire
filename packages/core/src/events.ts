/**
 * Small helpers for reasoning about bus-event envelopes (framework spec §3).
 * The bus is a broadcast log: every bot's capabilities see every event, so an
 * "addressed" event (one carrying a subject) must be filtered down to the bot
 * it names. Centralised here so the subtle rule — unaddressed events reach
 * everyone — lives in exactly one place.
 */
import type { BusEvent } from "./bus.js";

/**
 * True when `evt` is addressed to a DIFFERENT bot, so the caller should ignore
 * it. An event with no subject is unaddressed and reaches every bot (returns
 * false). Mirrors the guard every consuming capability used to inline:
 * `evt.subject && evt.subject.id !== ctx.bot`.
 */
export function notForMe(evt: Pick<BusEvent, "subject">, botId: string): boolean {
  return evt.subject != null && evt.subject.id !== botId;
}

/**
 * Read a single string field from an event's payload, with a fallback when it's
 * absent (nullish). Replaces the repeated `String((evt?.payload as {...})?.x ?? d)`
 * double-cast that action/handler code inlined to pull one value out of the
 * untyped payload. Non-string values (a number id) are stringified.
 */
export function payloadString(evt: { payload?: Record<string, unknown> } | null | undefined, key: string, fallback = ""): string {
  const value = evt?.payload?.[key];
  return value == null ? fallback : String(value);
}
