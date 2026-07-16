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

test('parseGroupId extracts id from LiveTrack360 URL', () => {
  const { client } = makeClient('localhost');
  assert.equal(
    client.parseGroupId('https://livetrack360.com/livetracking/2d/7784/837424800/837511500'),
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

// ── parseGroupToken ─────────────────────────────────────────────────────────

test('parseGroupToken extracts token from URL with token param', () => {
  const { client } = makeClient('localhost');
  assert.equal(
    client.parseGroupToken('https://lt.flymaster.net/bs.php?grp=7784&token=abc123'),
    'abc123',
  );
});

test('parseGroupToken extracts token when token appears before grp', () => {
  const { client } = makeClient('localhost');
  assert.equal(
    client.parseGroupToken('https://lt.flymaster.net/bs.php?token=XYZ&grp=7784'),
    'XYZ',
  );
});

test('parseGroupToken returns null when no token in URL', () => {
  const { client } = makeClient('localhost');
  assert.equal(
    client.parseGroupToken('https://lt.flymaster.net/bs.php?grp=7784'),
    null,
  );
  assert.equal(client.parseGroupToken('7784'), null);
  assert.equal(client.parseGroupToken(null), null);
});

test('parseGroupToken decodes URL-encoded token values', () => {
  const { client } = makeClient('localhost');
  assert.equal(
    client.parseGroupToken('https://lt.flymaster.net/bs.php?grp=7784&token=hello%20world'),
    'hello world',
  );
});

test('parseLiveTrack360Window parses LiveTrack360 timestamps to Unix seconds', () => {
  const { client } = makeClient('localhost');
  const range = client.parseLiveTrack360Window(
    'https://livetrack360.com/livetracking/2d/7784/837424800/837511500',
  );
  assert.equal(range.fromTime, 1784109600);
  assert.equal(range.toTime, 1784196300);
});

test('parseLiveTrack360Window returns null for non-LiveTrack360 inputs', () => {
  const { client } = makeClient('localhost');
  assert.equal(client.parseLiveTrack360Window('https://lt.flymaster.net/bs.php?grp=7784'), null);
  assert.equal(client.parseLiveTrack360Window('7784'), null);
  assert.equal(client.parseLiveTrack360Window(null), null);
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

test('getLiveData parses string-valued fix fields (real API format)', async () => {
  // The real Flymaster API returns most fix fields as strings, not numbers.
  // Confirmed from vicb/flyXC fixture data.
  const rawResponse = {
    '5518': [
      { d: 1615411121, ai: '2850474', oi: '-7319830', h: '846', c: '841', s: '493', b: '36', v: '31' },
      { d: 1615411122, ai: '2850477', oi: '-7319826', h: '847', c: '841', s: '531', b: '30', v: '27' },
    ],
  };

  const { client } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => rawResponse,
  }));

  const pilots = [{ serial: '5518', name: 'Test' }];
  const tracks = await client.getLiveData('7784', pilots, 0);

  assert.ok(Array.isArray(tracks['5518']), 'track array exists');
  assert.equal(tracks['5518'].length, 2);
  const fix = tracks['5518'][0];
  assert.ok(Math.abs(fix.lat  -  47.5079) < 0.001, `lat ≈ 47.5079 (got ${fix.lat})`);
  assert.ok(Math.abs(fix.lon  - -121.997) < 0.001, `lon ≈ -121.997 (got ${fix.lon})`);
  assert.equal(fix.alt,    846);
  assert.equal(fix.gndAlt, 493);
  assert.equal(fix.speed,  31);
  assert.equal(fix.time,   1615411121);
});

// ── getLiveDataFromLB ───────────────────────────────────────────────────────

test('getLiveDataFromLB parses Layout A (flat d array with sn field)', async () => {
  // Layout A: { d: [{ sn, ai, oi, h, s, v, d }, ...] }
  // Using string values for numeric fields (matching real Flymaster API format)
  const rawResponse = {
    d: [
      { sn: '42', ai: '2826000', oi:  '601200', h: '1500', s: '1100', v: '35', d: 1700000100 },
      { sn: '42', ai: '2826600', oi:  '602400', h: '1510', s: '1110', v: '36', d: 1700000130 },
      { sn: '99', ai: '2900000', oi:  '700000', h: '1200', s:  '900', v: '40', d: 1700000100 },
      { sn: '99', ai: '2901000', oi:  '701000', h: '1210', s:  '910', v: '42', d: 1700000130 },
    ],
  };

  const { client } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => rawResponse,
  }));

  const tracks = await client.getLiveDataFromLB('7784', 0);

  assert.ok(Array.isArray(tracks['42']), 'track array for pilot 42');
  assert.equal(tracks['42'].length, 2);
  assert.ok(Array.isArray(tracks['99']), 'track array for pilot 99');
  assert.equal(tracks['99'].length, 2);

  const fix = tracks['42'][0];
  assert.ok(Math.abs(fix.lat - 47.1) < 0.001, `lat ≈ 47.1 (got ${fix.lat})`);
  assert.ok(Math.abs(fix.lon - 10.02) < 0.001, `lon ≈ 10.02 (got ${fix.lon})`);
  assert.equal(fix.time, 1700000100);
});

test('getLiveDataFromLB parses Layout B (fixes keyed by serial)', async () => {
  // Layout B: { "<serial>": [{ ai, oi, h, s, v, d }, ...] }
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

  const tracks = await client.getLiveDataFromLB('7784', 0);

  assert.ok(Array.isArray(tracks['42']), 'track array for pilot 42');
  assert.equal(tracks['42'].length, 2);
  const fix = tracks['42'][0];
  assert.ok(Math.abs(fix.lat - 47.1) < 0.001, `lat ≈ 47.1`);
});

test('getLiveDataFromLB routes lb.flymaster.net through correct proxy', async () => {
  const { client, fetchSpy } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => ({}),
  }));

  await client.getLiveDataFromLB('7784', 0);
  assert.equal(fetchSpy.length, 1);
  assert.match(fetchSpy[0], /^\/api\/lb\//);
  assert.doesNotMatch(fetchSpy[0], /lt\.flymaster\.net/);
});

test('getLiveDataFromLB includes token in URL when provided', async () => {
  const { client, fetchSpy } = makeClient('localhost', async () => ({
    ok: true, json: async () => ({}),
  }));

  await client.getLiveDataFromLB('7784', 0, 'secret');
  assert.ok(fetchSpy.some(url => url.includes('secret')), 'token in URL');
});

// ── tryGetLiveData (updated strategies) ────────────────────────────────────

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

test('tryGetLiveData falls back to lb server when lt server returns no tracks', async () => {
  let callCount = 0;
  const { client } = makeClient('localhost', async url => {
    callCount++;
    // lt.flymaster.net calls (strategies 1-3) return empty
    if (url.includes('/api/lt/')) {
      return { ok: true, json: async () => ({}) };
    }
    // lb.flymaster.net call (lb fallback strategy) returns tracks in Layout A
    return {
      ok: true,
      json: async () => ({
        d: [
          { sn: '1', ai: 2826000, oi: 601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
          { sn: '1', ai: 2826600, oi: 602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
        ],
      }),
    };
  });

  const result = await client.tryGetLiveData('7784', [{ serial: '1', name: 'P' }], 1700086400);
  assert.ok(Array.isArray(result['1']), 'tracks found via lb fallback');
  assert.equal(result['1'].length, 2);
});

test('tryGetLiveData with token includes token in lb wider-window strategy (4b)', async () => {
  const fromTime = 1700086400;
  const expectedWiderFrom = fromTime - 48 * 3600;
  let lbCallCount = 0;
  const { client, fetchSpy } = makeClient('localhost', async url => {
    // lt calls fail
    if (url.includes('/api/lt/')) return { ok: true, json: async () => ({}) };
    // lb calls: first one (fromTime with token) returns empty; second (widerFrom with token) returns tracks
    lbCallCount++;
    if (lbCallCount === 1) return { ok: true, json: async () => ({}) };
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

  const result = await client.tryGetLiveData('7784', [{ serial: '1', name: 'P' }], fromTime, 'mytoken');
  // Token must appear in at least one lb call
  assert.ok(
    fetchSpy.filter(u => u.includes('/api/lb/')).some(u => u.includes('mytoken')),
    'token used in lb strategy',
  );
  // The wider time window must have been used in the second lb call
  assert.ok(
    fetchSpy.filter(u => u.includes('/api/lb/')).some(u => u.includes(`d=${expectedWiderFrom}`)),
    'wider time window used in lb strategy 4b',
  );
  assert.ok(Array.isArray(result['1']), 'tracks returned');
});

test('tryGetLiveData uses d=0 as last resort fallback', async () => {
  const { client, fetchSpy } = makeClient('localhost', async url => {
    // All calls return empty until d=0 is tried
    if (!url.includes('d=0')) return { ok: true, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        d: [
          { sn: '1', ai: 2826000, oi: 601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
          { sn: '1', ai: 2826600, oi: 602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
        ],
      }),
    };
  });

  const result = await client.tryGetLiveData('7784', [{ serial: '1', name: 'P' }], 1700086400);
  assert.ok(fetchSpy.some(u => u.includes('d=0')), 'd=0 strategy attempted');
  assert.ok(Array.isArray(result['1']), 'tracks found via d=0 fallback');
  assert.equal(result['1'].length, 2);
});

// ── getLiveDataFromLB Layout C (wrapped response) ───────────────────────────

test('getLiveDataFromLB handles Layout C – tracks wrapped under "data" key', async () => {
  const rawResponse = {
    data: {
      '42': [
        { ai: 2826000, oi: 601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
        { ai: 2826600, oi: 602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
      ],
    },
  };

  const { client } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => rawResponse,
  }));

  const tracks = await client.getLiveDataFromLB('7784', 0);
  assert.ok(Array.isArray(tracks['42']), 'track array under "data" wrapper');
  assert.equal(tracks['42'].length, 2);
});

test('getLiveDataFromLB handles Layout C – tracks wrapped under "response" key', async () => {
  const rawResponse = {
    response: {
      '42': [
        { ai: 2826000, oi: 601200, h: 1500, s: 1100, v: 35, d: 1700000100 },
        { ai: 2826600, oi: 602400, h: 1510, s: 1110, v: 36, d: 1700000130 },
      ],
    },
  };

  const { client } = makeClient('localhost', async () => ({
    ok:   true,
    json: async () => rawResponse,
  }));

  const tracks = await client.getLiveDataFromLB('7784', 0);
  assert.ok(Array.isArray(tracks['42']), 'track array under "response" wrapper');
  assert.equal(tracks['42'].length, 2);
});
