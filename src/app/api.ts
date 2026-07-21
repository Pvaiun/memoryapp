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

  rebuildMap: (force = false) =>
    req<MapPayload>('/api/map/rebuild', {
      method: 'POST',
      body: JSON.stringify({ day: localDay(), tzOffsetMinutes: tzOffsetMinutes(), force }),
    }),

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

  completeItem: (id: string) => req<{ item: ItemView }>(`/api/items/${id}/complete`, { method: 'POST' }),
  uncompleteItem: (id: string) => req<{ item: ItemView }>(`/api/items/${id}/uncomplete`, { method: 'POST' }),
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
export function themeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 62%)`;
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
