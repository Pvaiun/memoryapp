import type { Env } from './env';

// Embeddings back recapture-match retrieval (§10.3) and semantic search (§6).
// Production: Workers AI bge-base (768d). Dev fallback: deterministic character
// trigram hashing — crude, but stable and good enough to exercise the flow
// locally without any account or key.

const WORKERS_AI_MODEL = '@cf/baai/bge-base-en-v1.5';
export const FALLBACK_DIMS = 384;

export async function embed(env: Env, text: string): Promise<Float32Array> {
  if (env.AI) {
    try {
      const res = (await env.AI.run(WORKERS_AI_MODEL as never, { text: [text] } as never)) as unknown as {
        data: number[][];
      };
      if (res?.data?.[0]?.length) return Float32Array.from(res.data[0]);
    } catch {
      // fall through to the local fallback (e.g. `wrangler dev` without AI access)
    }
  }
  return trigramEmbed(text);
}

export function trigramEmbed(text: string): Float32Array {
  const v = new Float32Array(FALLBACK_DIMS);
  const norm = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  for (let i = 0; i < norm.length - 2; i++) {
    const tri = norm.slice(i, i + 3);
    v[hashStr(tri) % FALLBACK_DIMS] += 1;
    // Word-level unigrams too, so short paraphrases overlap.
  }
  for (const word of norm.trim().split(' ')) {
    if (word.length > 2) v[hashStr(`w:${word}`) % FALLBACK_DIMS] += 2;
  }
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
