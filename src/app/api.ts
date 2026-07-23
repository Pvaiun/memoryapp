import type { CaptureResponse, Flavour, ItemView, MapPayload } from '../shared/types';
import { dayKey, EARLY_MORNING_CUTOFF_MINUTES } from '../shared/dates';

// The app's "day" rolls over at the 5am sleep-cycle cutoff, not midnight —
// opening at 12:30am is still last night, so the Brain doesn't rebuild the map
// out from under a late session (same boundary the date parser uses).
export function localDay(): string {
  return dayKey(new Date(Date.now() - EARLY_MORNING_CUTOFF_MINUTES * 60_000));
}

export function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

// One-time-per-device access gate: the password lives in localStorage after
// the unlock screen and rides along on every API call.
const AUTH_KEY = 'memory-auth';

export class AuthError extends Error {
  constructor() {
    super('unauthorized');
  }
}

export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_KEY, token);
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_KEY);
  return token ? { 'x-memory-auth': token } : {};
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init?.headers as Record<string, string>) },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => req<{ ok: boolean } & Record<string, unknown>>('/api/status'),

  capture: (text: string) =>
    req<CaptureResponse>('/api/capture', {
      method: 'POST',
      body: JSON.stringify({ text, localTime: new Date().toISOString(), tzOffsetMinutes: tzOffsetMinutes() }),
    }),

  undoRecapture: (itemId: string, appendedText: string) =>
    req<{ newItem: ItemView | null }>(`/api/items/${itemId}/undo-recapture`, {
      method: 'POST',
      body: JSON.stringify({ appendedText }),
    }),

  getMap: () => req<MapPayload>(`/api/map?day=${localDay()}`),

  // promptVariant omitted → the server-stored morning-prompt preference.
  rebuildMap: (force = false, noHistory = false, promptVariant?: 'full' | 'minimal') =>
    req<MapPayload>('/api/map/rebuild', {
      method: 'POST',
      body: JSON.stringify({ day: localDay(), tzOffsetMinutes: tzOffsetMinutes(), force, noHistory, promptVariant }),
    }),

  setBrainPrompt: (variant: 'full' | 'minimal') =>
    req<{ ok: boolean; variant: string }>('/api/settings/brain-prompt', {
      method: 'POST',
      body: JSON.stringify({ variant }),
    }),

  setBrainAddendum: (text: string) =>
    req<{ ok: boolean }>('/api/settings/brain-addendum', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // Only the fields passed are updated; the enabled flag alone gates usage.
  setBrainOverride: (fields: { enabled?: boolean; text?: string }) =>
    req<{ ok: boolean }>('/api/settings/brain-override', {
      method: 'POST',
      body: JSON.stringify(fields),
    }),

  brainPromptText: () => req<{ variant: 'full' | 'minimal'; text: string }>('/api/settings/brain-prompt-text'),

  addFirstStep: (bubbleId: string, title: string) =>
    req<{ map: MapPayload; capture: CaptureResponse }>(`/api/bubbles/${bubbleId}/first-step`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  exportAll: () => req<Record<string, unknown>>('/api/export'),

  brainSnapshot: () => req<Record<string, unknown>>('/api/debug/brain'),

  items: () => req<{ items: ItemView[] }>('/api/items'),

  editItem: (id: string, edits: Record<string, unknown>) =>
    req<{ item: ItemView }>(`/api/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...edits, tzOffsetMinutes: tzOffsetMinutes() }),
    }),

  // terminal: retire a recurring DO for good ("goal achieved") instead of
  // checking off today's occurrence.
  completeItem: (id: string, terminal = false) =>
    req<{ item: ItemView }>(`/api/items/${id}/complete`, { method: 'POST', body: JSON.stringify({ terminal }) }),
  uncompleteItem: (id: string) => req<{ item: ItemView }>(`/api/items/${id}/uncomplete`, { method: 'POST' }),
  dismissItem: (id: string) => req<{ item: ItemView }>(`/api/items/${id}/dismiss`, { method: 'POST' }),
  missItem: (id: string) => req<{ item: ItemView }>(`/api/items/${id}/miss`, { method: 'POST' }),
  reopenItem: (id: string) => req<{ item: ItemView }>(`/api/items/${id}/reopen`, { method: 'POST' }),
  rejectItem: (id: string) => req<{ ok: boolean }>(`/api/items/${id}`, { method: 'DELETE' }),

  browse: () =>
    req<{ themes: { id: string; name: string; itemIds: string[] }[]; items: Record<string, ItemView> }>('/api/browse'),

  calendar: (fromIso: string, toIso: string) =>
    req<{ entries: { itemId: string; date: string; kind: string }[]; items: Record<string, ItemView> }>(
      `/api/calendar?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    ),

  search: (q: string) =>
    req<{ itemIds: string[]; items: Record<string, ItemView> }>(`/api/search?q=${encodeURIComponent(q)}`),

  pushPublicKey: () => req<{ publicKey: string | null }>('/api/push/public-key'),

  pushSubscribe: (subscription: PushSubscriptionJSON) =>
    req<{ ok: boolean }>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription, tzOffsetMinutes: tzOffsetMinutes() }),
    }),
};

// Stable colour per theme name (§6: colour = theme).
// Hues come from a curated wheel, not `hash % 360`: HSL degrees are not
// perceptually uniform — the green-cyan band spans roughly a third of the
// wheel, so uniform-random hues read as "mostly greens and blues". The list
// below spaces hues by how different they *look*, and a second hash byte
// nudges lightness so name collisions on the same hue still separate.
const THEME_HUES = [347, 15, 38, 60, 90, 130, 165, 190, 210, 235, 262, 290, 318];

export function themeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = THEME_HUES[h % THEME_HUES.length];
  const light = 58 + ((h >>> 8) % 3) * 5; // 58 / 63 / 68
  return `hsl(${hue} 62% ${light}%)`;
}

export function itemColor(item: ItemView): string {
  return item.themes.length ? themeColor(item.themes[0].name) : 'hsl(220 15% 55%)';
}

export const FLAVOUR_ICONS: Record<Flavour, string> = {
  Task: '✓',
  Goal: '◎',
  Reminder: '⏰',
  Event: '📅',
  Note: '✎',
};
