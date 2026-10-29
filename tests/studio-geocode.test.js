'use strict';
// Smoke tests for studio-geocode.js (auth checks; Nominatim fetch is mocked)
const { handler } = require('../netlify/functions/studio-geocode');

// Minimal mock for _studio-shared verifyStudioToken
jest.mock('../netlify/functions/_studio-shared', () => ({
  verifyStudioToken: jest.fn(),
  json: (status, body) => ({ statusCode: status, body: JSON.stringify(body) }),
}));

const { verifyStudioToken } = require('../netlify/functions/_studio-shared');

const mockFetch = jest.fn();
global.fetch = mockFetch;

const makeEvent = (body, method = 'POST') => ({
  httpMethod: method,
  headers: { authorization: 'Bearer tok' },
  body: JSON.stringify(body),
});

describe('studio-geocode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 405 for GET', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(res.statusCode).toBe(405);
  });

  it('returns 403 when not authenticated', async () => {
    verifyStudioToken.mockResolvedValue(null);
    const res = await handler(makeEvent({ query: 'Köln' }));
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when query is too short', async () => {
    verifyStudioToken.mockResolvedValue({ uid: 'u1' });
    const res = await handler(makeEvent({ query: 'a' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when query is missing', async () => {
    verifyStudioToken.mockResolvedValue({ uid: 'u1' });
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it('returns candidates from Nominatim on success', async () => {
    verifyStudioToken.mockResolvedValue({ uid: 'u1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { display_name: 'Ehrenfeld, Köln', lat: '50.9600', lon: '6.9200', type: 'suburb' },
        { display_name: 'Ehrenstraße, Köln', lat: '50.9410', lon: '6.9355', type: 'road' },
      ]),
    });
    const res = await handler(makeEvent({ query: 'Ehrenfeld Köln' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].lat).toBeCloseTo(50.96);
    expect(body.candidates[0].lng).toBeCloseTo(6.92);
    expect(body.candidates[0].displayName).toBe('Ehrenfeld, Köln');
  });

  it('returns empty candidates array when Nominatim returns no results', async () => {
    verifyStudioToken.mockResolvedValue({ uid: 'u1' });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    const res = await handler(makeEvent({ query: 'Nichtexistierend 99999' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates).toHaveLength(0);
  });

  it('filters candidates with invalid coordinates', async () => {
    verifyStudioToken.mockResolvedValue({ uid: 'u1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { display_name: 'Good', lat: '50.93', lon: '6.95', type: 'city' },
        { display_name: 'Bad', lat: 'NaN', lon: '6.95', type: 'city' },
      ]),
    });
    const res = await handler(makeEvent({ query: 'Köln Test' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].displayName).toBe('Good');
  });

  it('returns 502 when Nominatim fetch fails', async () => {
    verifyStudioToken.mockResolvedValue({ uid: 'u1' });
    mockFetch.mockRejectedValue(new Error('network error'));
    const res = await handler(makeEvent({ query: 'Köln' }));
    expect(res.statusCode).toBe(502);
  });
});
