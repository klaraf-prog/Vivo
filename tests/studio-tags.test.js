'use strict';

const mockVerifyStudioToken = jest.fn();
const mockInitAdmin = jest.fn();

jest.mock('../netlify/functions/_studio-shared', () => ({
  verifyStudioToken: (...args) => mockVerifyStudioToken(...args),
  initAdmin: (...args) => mockInitAdmin(...args),
  json: (statusCode, body) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
}));

const tagsHandler = require('../netlify/functions/studio-tags').handler;

function makeDbMock(snapsByPath = {}) {
  const mockSet = jest.fn().mockResolvedValue(undefined);
  const mockUpdate = jest.fn().mockResolvedValue(undefined);
  const mockOnce = jest.fn().mockImplementation(async () => {
    // default empty snap
    return { val: () => null };
  });
  const mockRef = jest.fn().mockImplementation((path) => ({
    once: jest.fn().mockImplementation(async () => {
      const data = snapsByPath[path];
      return { val: () => data !== undefined ? data : null };
    }),
    set: mockSet,
    update: mockUpdate,
  }));
  return { ref: mockRef, _mockSet: mockSet, _mockUpdate: mockUpdate };
}

const superadmin = { uid: 'sa_uid', email: 'sa@test.com', studioRole: 'superadmin' };

function post(body) {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer valid' }, body: JSON.stringify(body) };
}

beforeEach(() => jest.clearAllMocks());

describe('studio-tags GET', () => {
  test('returns baseline tags when Firebase catalog is empty', async () => {
    const db = makeDbMock({ '/config/tagCatalog': null });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler({ httpMethod: 'GET', headers: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.tags.length).toBeGreaterThan(30);
    const laufen = body.tags.find(t => t.id === 'laufen');
    expect(laufen).toBeDefined();
    expect(laufen.label).toBe('Laufen');
    expect(laufen.baseline).toBe(true);
    expect(laufen.active).toBe(true);
  });

  test('merges Firebase overrides with baseline', async () => {
    const db = makeDbMock({
      '/config/tagCatalog': {
        laufen: { label: 'Laufen (Custom)', synonyms: ['joggen'], active: true },
        custom_tag: { label: 'Custom', synonyms: [], active: true, createdAt: '2026-01-01' },
      },
    });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler({ httpMethod: 'GET', headers: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const laufen = body.tags.find(t => t.id === 'laufen');
    expect(laufen.label).toBe('Laufen (Custom)');
    expect(laufen.synonyms).toEqual(['joggen']);
    const custom = body.tags.find(t => t.id === 'custom_tag');
    expect(custom).toBeDefined();
    expect(custom.baseline).toBe(false);
  });

  test('OPTIONS returns 200', async () => {
    const res = await tagsHandler({ httpMethod: 'OPTIONS', headers: {} });
    expect(res.statusCode).toBe(200);
  });
});

describe('studio-tags POST', () => {
  test('returns 403 when no auth', async () => {
    mockVerifyStudioToken.mockResolvedValue(null);
    const db = makeDbMock({});
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'upsert', id: 'test_tag', label: 'Test' }));
    expect(res.statusCode).toBe(403);
  });

  test('returns 400 for invalid id', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    const db = makeDbMock({});
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'upsert', id: 'Invalid ID!', label: 'Test' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_id');
  });

  test('returns 400 for missing label on upsert', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    const db = makeDbMock({ '/config/tagCatalog/newtag': null });
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'upsert', id: 'newtag' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('label_required');
  });

  test('upsert creates a new tag', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    let storedEntry = null;
    const db = {
      ref: jest.fn().mockImplementation((path) => ({
        once: jest.fn().mockResolvedValue({ val: () => null }),
        set: jest.fn().mockImplementation(async (val) => { storedEntry = val; }),
        update: jest.fn().mockResolvedValue(undefined),
      })),
    };
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'upsert', id: 'wintermarkt', label: 'Wintermarkt' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(storedEntry).not.toBeNull();
    expect(storedEntry.label).toBe('Wintermarkt');
    expect(storedEntry.active).toBe(true);
    expect(storedEntry.createdBy).toBe('sa_uid');
  });

  test('deactivate sets active:false', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    let updatedData = null;
    const db = {
      ref: jest.fn().mockReturnValue({
        once: jest.fn().mockResolvedValue({ val: () => null }),
        update: jest.fn().mockImplementation(async (val) => { updatedData = val; }),
        set: jest.fn().mockResolvedValue(undefined),
      }),
    };
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'deactivate', id: 'laufen' }));
    expect(res.statusCode).toBe(200);
    expect(updatedData.active).toBe(false);
  });

  test('reactivate sets active:true', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    let updatedData = null;
    const db = {
      ref: jest.fn().mockReturnValue({
        once: jest.fn().mockResolvedValue({ val: () => null }),
        update: jest.fn().mockImplementation(async (val) => { updatedData = val; }),
        set: jest.fn().mockResolvedValue(undefined),
      }),
    };
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'reactivate', id: 'laufen' }));
    expect(res.statusCode).toBe(200);
    expect(updatedData.active).toBe(true);
  });

  test('returns 400 for unknown action', async () => {
    mockVerifyStudioToken.mockResolvedValue(superadmin);
    const db = makeDbMock({});
    mockInitAdmin.mockReturnValue({ database: () => db });
    const res = await tagsHandler(post({ action: 'merge', id: 'laufen' }));
    expect(res.statusCode).toBe(400);
  });

  test('returns 405 for DELETE', async () => {
    const res = await tagsHandler({ httpMethod: 'DELETE', headers: {} });
    expect(res.statusCode).toBe(405);
  });
});
