'use strict';

/**
 * Integration tests for flymaster-client.js.
 *
 * These tests verify the proxy-selection logic and the URL transformations
 * used when fetching live Flymaster data.  All network calls are intercepted
 * via a mock global `fetch` so no real HTTP traffic is generated.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const clientSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'flymaster-client.js'),
  'utf8',
);

/**
 * Create a vm context that loads FlymasterClient with a given hostname.
 * `fetchSpy` captures every URL that `fetch` was called with.
 * Returns { client, fetchSpy }.
 */
function makeClient(hostname, fetchImpl) {
  const fetchSpy = [];
  const defaultFetch = async url => {
    fetchSpy.push(url);
    if (typeof fetchImpl === 'function') return fetchImpl(url);
    return { ok: true, json: async () => ({}) };
  };

  const ctx = vm.createContext({
    window: { location: { hostname } },
    fetch:  defaultFetch,
    Date,
    URL,
  });

  // flymaster-client.js uses `const FlymasterClient = …` at the top level.
  // Top-level `const`/`let` are not exposed as vm context properties, so we
  // wrap the entire source in an IIFE and capture the return value directly.
  const client = vm.runInContext(
    `(function(){ ${clientSrc}; return FlymasterClient; })()`,
    ctx,
  );
  return { client, fetchSpy };
}

// ── parseGroupId ────────────────────────────────────────────────────────────

test('parseGroupId extracts id from full Flymaster URL', () => {
  const { client } = makeClient('localhost');
  assert.equal(
    client.parseGroupId('https://lt.flymaster.net/bs.php?grp=7784'),
    '7784',
  );
});

test('parseGroupId accepts a bare numeric id', () => {
  const { client } = makeClient('localhost');
  assert.equal(client.parseGroupId('12345'), '12345');
});

test('parseGroupId returns null for invalid input', () => {
  const { client } = makeClient('localhost');
  assert.equal(client.parseGroupId('not-a-group'), null);
  assert.equal(client.parseGroupId(''), null);
  assert.equal(client.parseGroupId(null), null);
});

// ── proxyType ───────────────────────────────────────────────────────────────

test('proxyType returns "netlify" on .netlify.app hostname', () => {
  const { client } = makeClient('myapp.netlify.app');
  assert.equal(client.proxyType(), 'netlify');
});

test('proxyType returns "netlify" on .netlify.com hostname', () => {
  const { client } = makeClient('myapp.netlify.com');
  assert.equal(client.proxyType(), 'netlify');
});

test('proxyType returns "corsproxy" on .github.io hostname', () => {
  const { client } = makeClient('flozi76.github.io');
  assert.equal(client.proxyType(), 'corsproxy');
});

test('proxyType returns "nginx" on localhost', () => {
  const { client } = makeClient('localhost');
  assert.equal(client.proxyType(), 'nginx');
});

test('proxyType returns "nginx" on a custom domain', () => {
  const { client } = makeClient('replay.example.com');
  assert.equal(client.proxyType(), 'nginx');
});

// ── URL routing through correct proxy ───────────────────────────────────────

test('Netlify deployment: apiFetch wraps URL in Netlify proxy', async () => {
  const { client, fetchSpy } = makeClient('myapp.netlify.app');
  // getServerTime → apiFetch → should use Netlify proxy path
  try {
    await client.getServerTime('7784');
  } catch {
    // Response is a stub {} so the assertion inside getServerTime will throw –
    // that is fine; we only care about the URL that fetch was called with.
  }
  assert.equal(fetchSpy.length, 1);
  assert.match(fetchSpy[0], /^\/.netlify\/functions\/flymaster-proxy\?url=/);
  assert.match(fetchSpy[0], /lb\.flymaster\.net/);
});

test('nginx deployment (localhost): apiFetch uses /api/lb/ path', async () => {
  const { client, fetchSpy } = makeClient('localhost');
  try {
    await client.getServerTime('7784');
  } catch {
    // Stub response – ignore assertion error.
  }
  assert.equal(fetchSpy.length, 1);
  assert.match(fetchSpy[0], /^\/api\/lb\//);
  assert.doesNotMatch(fetchSpy[0], /lb\.flymaster\.net/);
});

test('nginx deployment (custom domain): apiFetch uses /api/lb/ path', async () => {
  const { client, fetchSpy } = makeClient('replay.example.com');
  try {
    await client.getServerTime('7784');
  } catch {
    // Stub response – ignore assertion error.
  }
  assert.equal(fetchSpy.length, 1);
  assert.match(fetchSpy[0], /^\/api\/lb\//);
});

test('corsproxy deployment (GitHub Pages): apiFetch uses corsproxy.io', async () => {
  const { client, fetchSpy } = makeClient('flozi76.github.io');
  try {
    await client.getServerTime('7784');
  } catch {
    // Stub response – ignore assertion error.
  }
  assert.equal(fetchSpy.length, 1);
  assert.match(fetchSpy[0], /^https:\/\/corsproxy\.io\/\?url=/);
  assert.match(fetchSpy[0], /lb\.flymaster\.net/);
});

test('corsproxy deployment (GitHub Pages): lt.flymaster.net also routed via corsproxy', async () => {
  const pilots = [{ serial: '42', name: 'Test' }];
  const { client, fetchSpy } = makeClient('flozi76.github.io', async () => ({
    ok:   true,
    json: async () => ({}),
  }));
  await client.getLiveData('7784', pilots, 0);
  assert.equal(fetchSpy.length, 1);
  assert.match(fetchSpy[0], /^https:\/\/corsproxy\.io\/\?url=/);
  assert.match(fetchSpy[0], /lt\.flymaster\.net/);
});

// ── getLiveData parsing ─────────────────────────────────────────────────────

test('getLiveData parses fix fields correctly', async () => {
  const rawResponse = {
    '42': [
      { ai: 2826000, oi:  601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
      { ai: 2826600, oi:  602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
    ],
  };

  const { client } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => rawResponse,
  }));

  const pilots  = [{ serial: '42', name: 'Test Pilot' }];
  const tracks  = await client.getLiveData('7784', pilots, 0);

  assert.ok(Array.isArray(tracks['42']), 'track array exists under serial key');
  assert.equal(tracks['42'].length, 2);

  const fix = tracks['42'][0];
  assert.ok(Math.abs(fix.lat - 47.1) < 0.001, `lat ≈ 47.1 (got ${fix.lat})`);
  assert.ok(Math.abs(fix.lon - 10.02) < 0.001, `lon ≈ 10.02 (got ${fix.lon})`);
  assert.equal(fix.alt,    1500);
  assert.equal(fix.gndAlt, 1100);
  assert.equal(fix.speed,  35);
  assert.equal(fix.time,   1700000100);
});

test('tryGetLiveData returns empty object when getLiveData fails', async () => {
  const { client } = makeClient('localhost', async () => ({
    ok:     false,
    status: 403,
    json:   async () => ({}),
  }));

  const result = await client.tryGetLiveData('7784', [{ serial: '1', name: 'P' }], 0);
  // The returned object comes from the vm realm so we compare via JSON to
  // avoid cross-realm prototype mismatches with assert.deepEqual.
  assert.equal(JSON.stringify(result), '{}');
});

test('tryGetLiveData uses token when provided', async () => {
  const { client, fetchSpy } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => ({
      '1': [
        { ai: 2826000, oi: 601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
        { ai: 2826600, oi: 602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
      ],
    }),
  }));

  const result = await client.tryGetLiveData('7784', [{ serial: '1', name: 'P' }], 0, 'mytoken');
  // With a token, the first strategy should succeed and return data
  assert.ok(Array.isArray(result['1']), 'track array returned');
  assert.equal(result['1'].length, 2);
  // Token should appear in the fetch URL
  assert.ok(fetchSpy.some(url => url.includes('mytoken')), 'token included in request URL');
});

test('tryGetLiveData falls back to wider time window when today window returns no tracks', async () => {
  let callCount = 0;
  const { client } = makeClient('localhost', async url => {
    callCount++;
    // First call (strategy 2 = given time window) returns no tracks
    if (callCount <= 1) {
      return { ok: true, json: async () => ({}) };
    }
    // Second call (48h wider window) returns real tracks
    return {
      ok: true,
      json: async () => ({
        '1': [
          { ai: 2826000, oi: 601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
          { ai: 2826600, oi: 602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
        ],
      }),
    };
  });

  const result = await client.tryGetLiveData('7784', [{ serial: '1', name: 'P' }], 1700086400);
  assert.ok(Array.isArray(result['1']), 'tracks found via wider window');
  assert.equal(result['1'].length, 2);
});
