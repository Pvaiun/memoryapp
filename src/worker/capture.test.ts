import { describe, expect, it } from 'vitest';
import { resolveDatePhrase } from '../shared/dates';
import { sameWhen } from './capture';

// Recapture-match guard: a boost appends phrasing and nothing else, so a
// dated capture may only merge into an item already on that date.
describe('sameWhen', () => {
  const ref = new Date('2026-10-08T15:00:00Z'); // 11:00 local at UTC-4
  const tz = -240;
  const therapyToday = { eventAt: '2026-10-08T17:30:00.000Z', deadline: null, datePrecision: 'time' as const };

  it('the same name two weeks later at a different time is a different appointment', () => {
    const when = resolveDatePhrase('October 21 at 2:30pm', ref, tz);
    expect(when).not.toBeNull();
    expect(sameWhen(when, therapyToday, tz)).toBe(false);
  });

  it('same day, different time is still different', () => {
    expect(sameWhen(resolveDatePhrase('today at 2:30pm', ref, tz), therapyToday, tz)).toBe(false);
  });

  it('the same moment re-entered is a recapture', () => {
    expect(sameWhen(resolveDatePhrase('today at 1:30pm', ref, tz), therapyToday, tz)).toBe(true);
  });

  it('a dateless capture can always boost', () => {
    expect(sameWhen(null, therapyToday, tz)).toBe(true);
  });

  it('a dated capture never merges into an undated item — the date would be lost', () => {
    const when = resolveDatePhrase('tomorrow', ref, tz);
    expect(sameWhen(when, { eventAt: null, deadline: null, datePrecision: 'time' }, tz)).toBe(false);
  });

  it('day-precision dates compare by local day', () => {
    const due = { eventAt: null, deadline: resolveDatePhrase('Friday', ref, tz)!.iso, datePrecision: 'day' as const };
    expect(sameWhen(resolveDatePhrase('Friday', ref, tz), due, tz)).toBe(true);
    expect(sameWhen(resolveDatePhrase('Saturday', ref, tz), due, tz)).toBe(false);
  });
});
