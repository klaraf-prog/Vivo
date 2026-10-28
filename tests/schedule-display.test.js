'use strict';
const { berlDate, todayHoursFor, cardScheduleHint } = require('../netlify/functions/_schedule-display');

// Fixed test date: Wednesday 2026-11-18 in Berlin
const TODAY = '2026-11-18';
const TODAY_WD = 'mi';

describe('berlDate', () => {
  test('returns ISO date and German weekday code', () => {
    // 2026-11-18 UTC noon is Wednesday
    const result = berlDate(new Date('2026-11-18T12:00:00Z'));
    expect(result.iso).toBe('2026-11-18');
    expect(result.wd).toBe('mi');
  });

  test('Sunday maps to "so"', () => {
    const result = berlDate(new Date('2026-11-22T12:00:00Z'));
    expect(result.wd).toBe('so');
  });
});

describe('todayHoursFor', () => {
  test('returns null when no schedule', () => {
    expect(todayHoursFor({}, TODAY, TODAY_WD)).toBeNull();
  });

  test('returns null when schedule has no regularHours or exceptions', () => {
    const a = { schedule: { period: { from: '2026-11-01', to: '2026-12-31' } } };
    expect(todayHoursFor(a, TODAY, TODAY_WD)).toBeNull();
  });

  test('returns hours from regularHours matching today weekday', () => {
    const a = { schedule: { regularHours: [{ days: ['mo', 'di', 'mi', 'do', 'fr'], open: '11:00', close: '21:00' }] } };
    expect(todayHoursFor(a, TODAY, 'mi')).toEqual({ open: '11:00', close: '21:00' });
  });

  test('returns null when today weekday not in regularHours', () => {
    const a = { schedule: { regularHours: [{ days: ['sa', 'so'], open: '10:00', close: '18:00' }] } };
    expect(todayHoursFor(a, TODAY, 'mi')).toBeNull();
  });

  test('exception overrides regularHours - closed', () => {
    const a = {
      schedule: {
        regularHours: [{ days: ['mi'], open: '11:00', close: '21:00' }],
        exceptions: [{ date: TODAY, closed: true }],
      },
    };
    expect(todayHoursFor(a, TODAY, 'mi')).toEqual({ closed: true });
  });

  test('exception overrides regularHours - different times', () => {
    const a = {
      schedule: {
        regularHours: [{ days: ['mi'], open: '11:00', close: '21:00' }],
        exceptions: [{ date: TODAY, open: '09:00', close: '14:00' }],
      },
    };
    expect(todayHoursFor(a, TODAY, 'mi')).toEqual({ open: '09:00', close: '14:00' });
  });

  test('exception with no closed/open fields returns null', () => {
    const a = { schedule: { exceptions: [{ date: TODAY, note: 'Sondertag' }] } };
    expect(todayHoursFor(a, TODAY, 'mi')).toBeNull();
  });
});

describe('cardScheduleHint', () => {
  test('returns empty string when no schedule data', () => {
    expect(cardScheduleHint({}, TODAY, TODAY_WD)).toBe('');
  });

  test('shows full period when it has not started', () => {
    const a = { schedule: { period: { from: '2026-11-19', to: '2026-12-23' } } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('19.11.2026–23.12.2026');
  });

  test('shows "bis" when period is currently running', () => {
    const a = { schedule: { period: { from: '2026-11-01', to: '2026-12-23' } } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('bis 23.12.2026');
  });

  test('omits period that is entirely in the past', () => {
    const a = { schedule: { period: { from: '2026-01-01', to: '2026-11-17' } } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('');
  });

  test('shows next specific date without year when same year', () => {
    const a = { schedule: { dates: [{ date: '2026-11-20', startTime: '19:00', endTime: '22:00' }] } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('20.11. 19:00–22:00 Uhr');
  });

  test('shows next specific date with year when different year', () => {
    const a = { schedule: { dates: [{ date: '2027-01-15' }] } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('15.01.2027');
  });

  test('skips past specific dates', () => {
    const a = { schedule: { dates: [{ date: '2026-11-10' }, { date: '2026-11-25' }] } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('25.11.');
  });

  test('shows today opening hours when regularHours match', () => {
    const a = { schedule: { regularHours: [{ days: ['mi'], open: '10:00', close: '18:00' }] } };
    expect(cardScheduleHint(a, TODAY, 'mi')).toBe('Heute 10:00–18:00 Uhr');
  });

  test('combines period and today hours', () => {
    const a = {
      schedule: {
        period: { from: '2026-11-01', to: '2026-12-31' },
        regularHours: [{ days: ['mo', 'di', 'mi', 'do', 'fr'], open: '11:00', close: '21:00' }],
      },
    };
    const hint = cardScheduleHint(a, TODAY, 'mi');
    expect(hint).toBe('bis 31.12.2026 · Heute 11:00–21:00 Uhr');
  });

  test('exception closed overrides regularHours', () => {
    const a = {
      schedule: {
        regularHours: [{ days: ['mi'], open: '11:00', close: '21:00' }],
        exceptions: [{ date: TODAY, closed: true }],
      },
    };
    expect(cardScheduleHint(a, TODAY, 'mi')).toBe('heute geschlossen');
  });

  test('uses operatingPeriod when no schedule.period', () => {
    const a = { operatingPeriod: { from: '2026-12-01', to: '2026-12-31' } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('01.12.2026–31.12.2026');
  });

  test('returns empty when all dates are past', () => {
    const a = { schedule: { dates: [{ date: '2026-11-01' }, { date: '2026-11-10' }] } };
    expect(cardScheduleHint(a, TODAY, TODAY_WD)).toBe('');
  });
});
