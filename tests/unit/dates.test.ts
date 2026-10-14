import { describe, expect, it } from 'vitest';
import {
  addDays, addMonthsClamped, addMonthsToMonth, addYearsClamped, daysInMonth, formatDate, isValidIsoDate,
  monthRange, todayIn,
} from '../../src/domain/dates';

describe('calendar dates', () => {
  it('validates dates including leap years', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('1900-02-29')).toBe(false);
    expect(isValidIsoDate('2000-02-29')).toBe(true);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-1-01')).toBe(false);
  });
  it('knows month lengths', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
  it('clamps month-end when adding months', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('handles Feb 29 + 2 years (retention rule)', () => {
    expect(addYearsClamped('2024-02-29', 2)).toBe('2026-02-28');
    expect(addYearsClamped('2026-10-14', 2)).toBe('2028-10-14');
  });
  it('adds days across year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });
  it('builds month ranges', () => {
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(addMonthsToMonth('2026-01', -1)).toBe('2025-12');
  });
});

describe('timezone handling (America/Detroit)', () => {
  it('uses the household timezone for "today", not UTC', () => {
    // 2026-10-14 02:30 UTC is still Oct 13 in Detroit (UTC-4 in October)
    const instant = new Date('2026-10-14T02:30:00Z');
    expect(todayIn('America/Detroit', instant)).toBe('2026-10-13');
    expect(todayIn('UTC', instant)).toBe('2026-10-14');
  });
  it('handles the DST change day', () => {
    // 2026-11-01 is the fall-back day in the US
    expect(todayIn('America/Detroit', new Date('2026-11-01T04:30:00Z'))).toBe('2026-11-01');
    expect(todayIn('America/Detroit', new Date('2026-11-01T03:30:00Z'))).toBe('2026-10-31');
  });
  it('formats calendar dates without shifting them', () => {
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
  });
});
