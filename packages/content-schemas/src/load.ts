import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/**
 * Expand `${VAR_NAME}` placeholders in raw YAML text from process.env, BEFORE
 * parsing — so placeholders work anywhere, including mapping keys (e.g. the
 * per-guild persona keys in manifests). Content stays committable with no real
 * guild IDs in git (§9); each environment supplies its own via .env.
 * A missing variable is a config bug: fail loudly at boot, naming every one.
 */
export function substituteEnv(raw: string, source = "<inline>", env = process.env): string {
  const missing = new Set<string>();
  const out = raw.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_m, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.add(name);
      return "";
    }
    return value;
  });
  if (missing.size > 0) {
    throw new Error(
      `Missing environment variable(s) referenced by ${source}: ${[...missing].join(", ")}. ` +
        `Set them in .env (see .env.example).`,
    );
  }
  return out;
}

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
  const raw = substituteEnv(readFileSync(path, "utf8"), path);
  return parseContent(schema, raw, path);
}
