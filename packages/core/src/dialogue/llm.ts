/**
 * LLM wording helper (framework spec §5.4 / §11 "LLM-worded dialogue"). A thin,
 * defensive wrapper over the Anthropic SDK that turns a system+user prompt into
 * one short in-character line. The model supplies WORDING ONLY — callers keep
 * every price, item, and outcome in game data (invariant of the `generated`
 * dialogue idea).
 *
 * Deliberately fail-loud-then-fall-back: `generateLine` THROWS on a disabled key,
 * a timeout, an API error, or a policy refusal, so the caller can drop to an
 * authored line. It never blocks the game longer than `timeoutMs`. The client is
 * injectable so tests never touch the network.
 */
import Anthropic from "@anthropic-ai/sdk";

/** Cheap + fast tier — flavor lines don't need Opus (§ model choice). */
const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_TOKENS = 150;

/** The sliver of the Anthropic SDK surface we depend on — lets tests inject a fake. */
export interface MessagesClient {
  messages: {
    create(
      body: {
        model: string;
        max_tokens: number;
        system: string;
        messages: { role: "user"; content: string }[];
      },
      options?: { timeout?: number },
    ): Promise<{ stop_reason: string | null; content: { type: string; text?: string }[] }>;
  };
}

let cached: Anthropic | null = null;
function defaultClient(): MessagesClient {
  cached ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the env
  return cached as unknown as MessagesClient;
}

/** True when an API key is configured — callers skip generation (and its cost) otherwise. */
export function isDialogueLlmEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface GenerateLineOptions {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One in-character line, or THROW so the caller falls back to an authored line.
 * Throws when: no key + no injected client, the model refuses, or the call
 * times out / errors.
 */
export async function generateLine(opts: GenerateLineOptions, client?: MessagesClient): Promise<string> {
  if (!client && !isDialogueLlmEnabled()) throw new Error("dialogue LLM disabled (no ANTHROPIC_API_KEY)");
  const c = client ?? defaultClient();
  const res = await c.messages.create(
    {
      model: process.env.DIALOGUE_MODEL ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    },
    { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (res.stop_reason === "refusal") throw new Error("dialogue LLM refused the request");
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("dialogue LLM returned no text");
  return text;
}
