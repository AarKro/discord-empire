import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/** Turn Zod issues into readable, path-scoped lines for boot-time errors. */
export function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

export class ContentValidationError extends Error {
  constructor(source: string, err: z.ZodError) {
    super(`Invalid content in ${source}:\n${formatIssues(err)}`);
    this.name = "ContentValidationError";
  }
}

/** Parse + validate a YAML string against a schema, with a readable error. */
export function parseContent<S extends z.ZodTypeAny>(
  schema: S,
  raw: string,
  source = "<inline>",
): z.output<S> {
  const data = parseYaml(raw);
  const result = schema.safeParse(data);
  if (!result.success) throw new ContentValidationError(source, result.error);
  return result.data;
}

/** Load + validate a YAML file from disk. Used at boot (§8 "validated at boot"). */
export function loadContentFile<S extends z.ZodTypeAny>(schema: S, path: string): z.output<S> {
  const raw = readFileSync(path, "utf8");
  return parseContent(schema, raw, path);
}
