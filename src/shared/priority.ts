import type { Item, PriorityLevel } from './types';

// Priority (§9.3): displayed priority = capture-inferred base, moved up by
// recapture boosts, faded by slow time decay; a user edit takes precedence.

export const PRIORITY_BASE: Record<PriorityLevel, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
};

// Each recapture-match adds this much boost (before decay).
export const RECAPTURE_BOOST = 0.15;

// Decay is deliberately slow (§9.3): half-life of 21 days, tunable.
export const BOOST_HALF_LIFE_DAYS = 21;

export function decayedBoost(boost: number, boostUpdatedAt: string | null, now: Date): number {
  if (!boost || !boostUpdatedAt) return 0;
  const ageDays = (now.getTime() - new Date(boostUpdatedAt).getTime()) / 86_400_000;
  if (ageDays <= 0) return boost;
  return boost * Math.pow(0.5, ageDays / BOOST_HALF_LIFE_DAYS);
}

export function effectivePriority(
  item: Pick<Item, 'priorityBase' | 'priorityBoost' | 'boostUpdatedAt' | 'userPriority'>,
  now: Date,
): number {
  if (item.userPriority !== null && item.userPriority !== undefined) {
    return clamp01(item.userPriority);
  }
  return clamp01(item.priorityBase + decayedBoost(item.priorityBoost, item.boostUpdatedAt, now));
}

export function priorityLabel(value: number): PriorityLevel {
  if (value >= 0.65) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
