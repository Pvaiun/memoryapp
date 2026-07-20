export interface Env {
  DB: D1Database;
  AI?: Ai; // Workers AI, for embeddings; optional so local dev degrades gracefully
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  CAPTURE_MODEL: string;
  BRAIN_MODEL: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}
