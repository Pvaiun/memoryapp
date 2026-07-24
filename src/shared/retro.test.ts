import { describe, expect, it } from 'vitest';
import { scoreRetro, type RetroBubbleInput } from './retro';

const bubble = (id: string, itemIds: string[], over: Partial<RetroBubbleInput> = {}): RetroBubbleInput => ({
  id,
  name: id,
  kind: 'situation',
  prominence: 0.5,
  reason: '',
  itemIds,
  ...over,
});

describe('scoreRetro', () => {
  it('marks a bubble engaged when a member was completed or touched', () => {
    const { bubbles } = scoreRetro(
      [bubble('b1', ['a', 'b']), bubble('b2', ['c'])],
      new Set(['a']),
      new Set(['c']),
      new Set(),
      0,
    );
    expect(bubbles[0]).toMatchObject({ completedItemIds: ['a'], engaged: true });
    expect(bubbles[1]).toMatchObject({ touchedItemIds: ['c'], completedItemIds: [], engaged: true });
  });

  it('does not double-count a completed item as touched', () => {
    const { bubbles } = scoreRetro([bubble('b1', ['a'])], new Set(['a']), new Set(['a']), new Set(), 0);
    expect(bubbles[0].completedItemIds).toEqual(['a']);
    expect(bubbles[0].touchedItemIds).toEqual([]);
  });

  it('a bubble whose members no one touched is not engaged', () => {
    const { bubbles, totals } = scoreRetro([bubble('b1', ['a', 'b'])], new Set(), new Set(), new Set(), 0);
    expect(bubbles[0].engaged).toBe(false);
    expect(totals.engagedBubbles).toBe(0);
  });

  it('surfaces an older completion the map buried as an off-map miss', () => {
    const { misses, totals } = scoreRetro(
      [bubble('b1', ['a'])],
      new Set(['a', 'x']), // x was completed but lived in no bubble
      new Set(),
      new Set(), // x is not fresh — the Brain had it and dropped it
      0,
    );
    expect(misses).toEqual([{ itemId: 'x', fresh: false }]);
    expect(totals.completedFromMap).toBe(1);
    expect(totals.completedOffMap).toBe(1);
  });

  it('a same-day capture completed off-map is a fair (fresh) miss, not a burial', () => {
    const { misses, totals } = scoreRetro(
      [bubble('b1', ['a'])],
      new Set(['y']),
      new Set(),
      new Set(['y']), // created that day → Captured Today, never in the map yet
      3,
    );
    expect(misses).toEqual([{ itemId: 'y', fresh: true }]);
    expect(totals.completedOffMap).toBe(0); // fresh misses don't count against the Brain
    expect(totals.completedFromMap).toBe(0);
    expect(totals.capturedThatDay).toBe(3);
  });

  it('orders burials ahead of fresh misses', () => {
    const { misses } = scoreRetro(
      [],
      new Set(['fresh1', 'buried1']),
      new Set(),
      new Set(['fresh1']),
      0,
    );
    expect(misses.map((m) => m.itemId)).toEqual(['buried1', 'fresh1']);
  });
});
