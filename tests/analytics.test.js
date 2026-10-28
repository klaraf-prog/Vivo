'use strict';

/**
 * Tests for the analytics-b2c Netlify function.
 * Focuses on buildTimeBuckets — the function responsible for
 * generating the time-series data shown in the "Events nach Datum" chart.
 */

const { handler, _buildTimeBuckets: buildTimeBuckets } = require('../netlify/functions/analytics-b2c');

// ── buildTimeBuckets ──────────────────────────────────────────────

describe('buildTimeBuckets', () => {
  test('returns [] when eventDates is empty', () => {
    expect(buildTimeBuckets('2024-01-01', '2024-01-31', [])).toEqual([]);
    expect(buildTimeBuckets(null, null, [])).toEqual([]);
  });

  test('returns daily buckets for ranges ≤14 days', () => {
    const dates = ['2024-06-01', '2024-06-01', '2024-06-03'];
    const buckets = buildTimeBuckets('2024-06-01', '2024-06-05', dates);
    expect(buckets.length).toBe(5); // 01–05
    expect(buckets[0]).toEqual({ label: '2024-06-01', count: 2 });
    expect(buckets[1]).toEqual({ label: '2024-06-02', count: 0 });
    expect(buckets[2]).toEqual({ label: '2024-06-03', count: 1 });
    expect(buckets[4]).toEqual({ label: '2024-06-05', count: 0 });
  });

  test('returns weekly buckets for ranges 15–92 days', () => {
    const dates = ['2024-06-03', '2024-06-10', '2024-06-10'];
    const buckets = buildTimeBuckets('2024-06-01', '2024-07-01', dates);
    expect(buckets.length).toBeGreaterThan(0);
    // Each bucket has label and count
    buckets.forEach(b => {
      expect(b).toHaveProperty('label');
      expect(b).toHaveProperty('count');
    });
    // Total count across all buckets equals number of event dates
    const total = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(3);
  });

  test('returns monthly buckets for ranges >92 days', () => {
    const dates = ['2024-01-15', '2024-03-20', '2024-03-25', '2024-06-01'];
    const buckets = buildTimeBuckets('2024-01-01', '2024-06-30', dates);
    expect(buckets.length).toBe(6); // Jan–Jun
    expect(buckets[0].label).toBe('2024-01');
    expect(buckets[0].count).toBe(1);
    expect(buckets[2].label).toBe('2024-03');
    expect(buckets[2].count).toBe(2);
    expect(buckets[5].label).toBe('2024-06');
    expect(buckets[5].count).toBe(1);
    // Total equals input
    const total = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(4);
  });

  test('derives date range from event data when no filter given (all-time view)', () => {
    const dates = ['2024-03-01', '2024-05-15', '2024-05-20'];
    // Both null = all-time
    const buckets = buildTimeBuckets(null, null, dates);
    expect(buckets.length).toBeGreaterThan(0);
    const total = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(3);
    // First bucket label ≤ earliest date
    expect(buckets[0].label <= '2024-03-01').toBe(true);
    // Last bucket label ≥ latest date slice
    const lastLabel = buckets[buckets.length - 1].label;
    expect(lastLabel >= '2024-05').toBe(true);
  });

  test('all-time with single day returns one bucket', () => {
    const dates = ['2024-06-01', '2024-06-01'];
    const buckets = buildTimeBuckets(null, null, dates);
    expect(buckets.length).toBe(1);
    expect(buckets[0]).toEqual({ label: '2024-06-01', count: 2 });
  });

  test('event dates outside the explicit range are not counted', () => {
    const dates = ['2024-01-01', '2024-06-15', '2024-12-31'];
    const buckets = buildTimeBuckets('2024-06-01', '2024-06-30', dates);
    const total = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1); // only 2024-06-15 is in range
  });
});

// ── handler auth guard ────────────────────────────────────────────

describe('analytics-b2c handler', () => {
  test('rejects non-GET requests with 405', async () => {
    const res = await handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {} });
    expect(res.statusCode).toBe(405);
  });

  test('rejects unauthenticated requests with 401', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    expect(res.statusCode).toBe(401);
  });

  test('rejects requests with invalid token with 401', async () => {
    const res = await handler({
      httpMethod: 'GET',
      headers: { authorization: 'Bearer invalid-token' },
      queryStringParameters: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
