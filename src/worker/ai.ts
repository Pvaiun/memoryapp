import type { Env } from './env';

// Thin Anthropic Messages API client (fetch-based; no SDK dependency).
// Model routing per §12: capture → CAPTURE_MODEL (cheap tier),
// Brain → BRAIN_MODEL (top tier).

export function llmAvailable(env: Env): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

export async function anthropicJson<T>(
  env: Env,
  model: string,
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<T> {
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
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  return extractJson<T>(text);
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
