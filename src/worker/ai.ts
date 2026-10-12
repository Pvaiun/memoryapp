import type { Env } from './env';

// Thin Anthropic Messages API client (fetch-based; no SDK dependency).
// Model routing per §12: capture → CAPTURE_MODEL (cheap tier),
// Brain → BRAIN_MODEL (top tier).

export function llmAvailable(env: Env): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

// The model's safety classifiers declined the request. Typed so the paths
// the user is watching (capture, the map build) can say so instead of
// recovering quietly the way they do from an outage.
export class ModelDeclinedError extends Error {
  constructor(readonly category: string | null) {
    super(`Anthropic API refusal (${category ?? 'uncategorized'})`);
    this.name = 'ModelDeclinedError';
  }
}

// What the user is told about a decline. The category (e.g. "general_harms")
// is the API's own label for which filter fired.
export function describeDecline(err: ModelDeclinedError): string {
  return err.category
    ? `the AI model declined the request (safety filter: ${err.category.replace(/_/g, ' ')})`
    : 'the AI model declined the request';
}

// Thinking is always on for the current models and counts toward max_tokens,
// so the default leaves room for it on top of the reply.
export async function anthropicText(
  env: Env,
  model: string,
  system: string,
  user: string,
  maxTokens = 16000,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    stop_reason?: string;
    stop_details?: { category?: string | null } | null;
  };
  // A decline is an HTTP 200 with empty or partial content; a max_tokens stop
  // is a cut-off reply. Neither is usable.
  if (data.stop_reason === 'refusal') {
    throw new ModelDeclinedError(data.stop_details?.category ?? null);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Anthropic API reply truncated at max_tokens=${maxTokens}`);
  }
  return data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

export async function anthropicJson<T>(
  env: Env,
  model: string,
  system: string,
  user: string,
  maxTokens?: number,
): Promise<T> {
  return extractJson<T>(await anthropicText(env, model, system, user, maxTokens));
}

// Models sometimes wrap JSON in prose or fences; extract the first balanced
// object/array rather than trusting the whole completion to be JSON.
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === open) depth++;
      if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(trimmed.slice(start, i + 1)) as T;
        }
      }
    }
  }
  throw new Error(`Could not extract JSON from model output: ${trimmed.slice(0, 200)}`);
}
