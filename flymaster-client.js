'use strict';

/**
 * Flymaster LiveTracking API client.
 *
 * All API calls go through a server-side proxy when available, bypassing CORS.
 * Four proxy strategies are supported (see proxyType()):
 *   netlify   – Netlify serverless function (/.netlify/functions/flymaster-proxy)
 *   nginx     – nginx reverse proxy  (/api/lb/ → lb.flymaster.net,
 *                                    /api/lt/ → lt.flymaster.net)
 *   corsproxy – public corsproxy.io CORS proxy (GitHub Pages static hosting)
 *   direct    – browser calls Flymaster directly (fallback; CORS errors expected)
 *
 * Confirmed endpoints (reverse-engineered):
 *   lb.flymaster.net/time.php            → { st: <unix_s> }
 *   lb.flymaster.net/getlivedatam.php    → { plist: [{sn, nm}], ... }
 *   lb.flymaster.net/getlivedatam.php    → live position data (without plist=1)
 *   lt.flymaster.net/wlb/getLiveData.php → per-tracker track arrays
 *   lt.flymaster.net/scoring/{grp}/{t}   → { aaData: [[serial, rank, ...]] }
 *                                          (TODO: implement ranking overlay)
 *
 * Fix fields from getLiveData:
 *   ai / 60000 → lat   |   oi / 60000 → lon
 *   h  → GPS alt (m)   |   s  → ground alt (m)
 *   v  → speed (km/h)  |   d  → Unix timestamp (s)
 */

const FlymasterClient = (() => {
  const LB = 'https://lb.flymaster.net';
  const LT = 'https://lt.flymaster.net';

  // Use the Netlify proxy when available (avoids CORS)
  const NETLIFY_PROXY = '/.netlify/functions/flymaster-proxy';

  // Nginx reverse-proxy paths used when the app is served by the Docker/nginx
  // container.  Requests to /api/lb/... and /api/lt/... are forwarded
  // server-side to lb.flymaster.net and lt.flymaster.net respectively.
  const NGINX_LB = '/api/lb';
  const NGINX_LT = '/api/lt';

  // Public CORS proxy used on GitHub Pages (no server-side code available).
  // corsproxy.io is open-source (https://github.com/Rob--W/cors-anywhere) and
  // free. Note: all proxied requests pass through this third-party service;
  // only public, non-sensitive Flymaster flight-tracking data is sent.
  // Users who need full data privacy should deploy on Netlify or with Docker
  // (both include a self-hosted server-side proxy).
  const CORS_PROXY = 'https://corsproxy.io/?url=';

  /**
   * Determine which proxy strategy to use for the current deployment:
   *   'netlify'   – Netlify serverless function (/.netlify/functions/flymaster-proxy)
   *   'nginx'     – nginx reverse proxy (/api/lb/, /api/lt/)
   *   'corsproxy' – public corsproxy.io CORS proxy (GitHub Pages)
   *   'direct'    – no proxy (browser calls Flymaster directly; CORS errors expected)
   *
   * Detection rules (most-specific first):
   *   • Netlify domains (.netlify.app / .netlify.com)   → 'netlify'
   *   • GitHub Pages (.github.io)                       → 'corsproxy'
   *   • localhost / 127.0.0.1 (Docker dev)              → 'nginx'
   *   • Everything else (custom domain, self-hosted)    → 'nginx'
   */
  function proxyType() {
    const h = window.location.hostname;
    // Anchor to full domain boundary (leading dot) to prevent prefix spoofing
    // e.g. "evilnetlify.com".endsWith("netlify.com") would match without the dot.
    if (h.endsWith('.netlify.app') || h.endsWith('.netlify.com')) return 'netlify';
    if (h.endsWith('.github.io'))                                  return 'corsproxy';
    // localhost / 127.0.0.1 → Docker dev; any other hostname → self-hosted nginx.
    // Both resolve to the same /api/lb/ and /api/lt/ proxy paths.
    return 'nginx';
  }

  async function apiFetch(url) {
    let target;
    const pt = proxyType();

    if (pt === 'netlify') {
      target = `${NETLIFY_PROXY}?url=${encodeURIComponent(url)}`;
    } else if (pt === 'corsproxy') {
      target = `${CORS_PROXY}${encodeURIComponent(url)}`;
    } else if (pt === 'nginx') {
      // Use URL origin comparison (not startsWith) so that a host like
      // lb.flymaster.net.evil.com is never matched.
      try {
        const parsed = new URL(url);
        if (parsed.origin === LB) {
          target = NGINX_LB + parsed.pathname + parsed.search;
        } else if (parsed.origin === LT) {
          target = NGINX_LT + parsed.pathname + parsed.search;
        } else {
          target = url;
        }
      } catch {
        target = url;  // malformed URL – fall through to direct
      }
    } else {
      target = url;  // 'direct' – no proxy
    }

    const resp = await fetch(target, {
      headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
  }

  /** Parse a group URL like https://lt.flymaster.net/bs.php?grp=7784 → "7784" */
  function parseGroupId(input) {
    if (!input) return null;
    const m = String(input).trim().match(/[?&]grp=(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(input.trim())) return input.trim();
    return null;
  }

  /** Current Flymaster server time (Unix seconds). */
  async function getServerTime(groupId) {
    const data = await apiFetch(
      `${LB}/time.php?grp=${groupId}&_=${Date.now()}`,
    );
    if (typeof data.st !== 'number') throw new Error('Unexpected time response');
    return data.st;
  }

  /**
   * Pilot list for a group.
   * Returns [{ serial, name }]
   */
  async function getPilots(groupId) {
    const st = await getServerTime(groupId);
    const data = await apiFetch(
      `${LB}/getlivedatam.php?grp=${groupId}&d=${st}&plist=1`,
    );
    const plist = data.plist || [];
    return plist.map(p => ({
      serial: String(p.sn),
      name:   p.nm || `Tracker ${p.sn}`,
    }));
  }

  /**
   * Live / recent track data for a set of pilots.
   * fromTime – Unix seconds; only fixes after this are returned.
   * Returns { serial → [{ time, lat, lon, alt, gndAlt, speed }] }
   *
   * Requires a group token for private groups. Public (browsable) groups
   * may or may not require it – we try without first.
   */
  async function getLiveData(groupId, pilots, fromTime, token = '') {
    const trackersParam = {};
    pilots.forEach(p => { trackersParam[p.serial] = fromTime; });

    let url = `${LT}/wlb/getLiveData.php?grp=${groupId}&trackers=${encodeURIComponent(JSON.stringify(trackersParam))}`;
    if (token) url += `&token=${encodeURIComponent(token)}`;

    const raw = await apiFetch(url);
    const tracks = {};

    for (const [serial, fixes] of Object.entries(raw)) {
      if (!Array.isArray(fixes)) continue;
      tracks[serial] = fixes
        .map(f => ({
          time:   Number(f.d),
          lat:    Number(f.ai) / 60000,
          lon:    Number(f.oi) / 60000,
          alt:    Number(f.h)  || 0,
          gndAlt: Number(f.s)  || 0,
          speed:  Number(f.v)  || 0,
        }))
        .filter(f => f.lat !== 0 || f.lon !== 0)
        .sort((a, b) => a.time - b.time);
    }

    return tracks;
  }

  /**
   * Alternative track-loading using lb.flymaster.net/getlivedatam.php with
   * a past fromTime.  The endpoint acts as a polling feed: calling it with a
   * past 'd' timestamp returns all fixes for the group since that time, which
   * gives us the full session history needed for replay.
   *
   * Two response layouts are handled:
   *   A) Flat array under 'd' key with per-fix 'sn' (serial):
   *      { "d": [{ sn, ai, oi, h, s, v, d }, …] }
   *   B) Fixes keyed by serial number (same layout as getLiveData):
   *      { "<serial>": [{ ai, oi, h, s, v, d }, …] }
   *
   * Returns { serial → [{ time, lat, lon, alt, gndAlt, speed }] }
   */
  async function getLiveDataFromLB(groupId, fromTime, token = '') {
    let url = `${LB}/getlivedatam.php?grp=${groupId}&d=${fromTime}`;
    if (token) url += `&token=${encodeURIComponent(token)}`;

    const raw = await apiFetch(url);
    const tracks = {};

    /** Normalise a raw Flymaster fix object into the app's internal format. */
    function normaliseFix(f) {
      return {
        time:   Number(f.d),
        lat:    Number(f.ai) / 60000,
        lon:    Number(f.oi) / 60000,
        alt:    Number(f.h)  || 0,
        gndAlt: Number(f.s)  || 0,
        speed:  Number(f.v)  || 0,
      };
    }

    // Layout A – flat fix array with a per-fix 'sn' field
    if (Array.isArray(raw.d)) {
      for (const fix of raw.d) {
        if (!fix.sn) continue;
        const sn = String(fix.sn);
        if (!tracks[sn]) tracks[sn] = [];
        tracks[sn].push(normaliseFix(fix));
      }
    } else {
      // Layout B – fixes keyed directly by serial (same as getLiveData)
      for (const [serial, fixes] of Object.entries(raw)) {
        if (!Array.isArray(fixes)) continue;
        tracks[serial] = fixes.map(normaliseFix);
      }
    }

    for (const sn of Object.keys(tracks)) {
      tracks[sn] = tracks[sn]
        .filter(f => f.lat !== 0 || f.lon !== 0)
        .sort((a, b) => a.time - b.time);
    }

    return tracks;
  }

  /**
   * Try live data with multiple fallback strategies:
   *
   * lt.flymaster.net / getLiveData.php strategies:
   *  1. With the provided token (if any) and the given fromTime.
   *  2. Without a token (public access) and the given fromTime.
   *  3. With/without token but a wider window (fromTime − 48 h).
   *
   * lb.flymaster.net / getlivedatam.php fallback strategies:
   *  4. With token and fromTime (skipped if no token).
   *  5. Without token and fromTime.
   *  6. Without token and wider window (fromTime − 48 h).
   *
   * Returns { serial → fixes[] } or {} when all strategies fail.
   */
  async function tryGetLiveData(groupId, pilots, fromTime, token = '') {
    /** Returns true when at least one pilot has ≥ 2 fixes (replayable). */
    function hasReplayableTracks(tracks) {
      return Object.values(tracks).some(fixes => fixes.length >= 2);
    }

    const widerFrom = fromTime - 48 * 3600;

    // ── lt.flymaster.net strategies (getLiveData.php) ─────────────────────
    // Strategy 1 – with token (skipped if no token provided)
    if (token) {
      try {
        const tracks = await getLiveData(groupId, pilots, fromTime, token);
        if (hasReplayableTracks(tracks)) return tracks;
      } catch { /* fall through */ }
    }

    // Strategy 2 – without token (public access)
    try {
      const tracks = await getLiveData(groupId, pilots, fromTime);
      if (hasReplayableTracks(tracks)) return tracks;
    } catch { /* fall through */ }

    // Strategy 3 – wider window in case the event started before fromTime
    try {
      const tracks = await getLiveData(groupId, pilots, widerFrom, token);
      if (hasReplayableTracks(tracks)) return tracks;
    } catch { /* fall through */ }

    // ── lb.flymaster.net fallback strategies (getlivedatam.php) ──────────
    // Strategy 4 – lb with token (skipped if no token provided)
    if (token) {
      try {
        const tracks = await getLiveDataFromLB(groupId, fromTime, token);
        if (hasReplayableTracks(tracks)) return tracks;
      } catch { /* fall through */ }
    }

    // Strategy 5 – lb without token
    try {
      const tracks = await getLiveDataFromLB(groupId, fromTime);
      if (hasReplayableTracks(tracks)) return tracks;
    } catch { /* fall through */ }

    // Strategy 6 – lb without token, wider window
    try {
      const tracks = await getLiveDataFromLB(groupId, widerFrom);
      if (hasReplayableTracks(tracks)) return tracks;
    } catch { /* fall through */ }

    return {};
  }

  return {
    parseGroupId, proxyType, getServerTime, getPilots,
    getLiveData, getLiveDataFromLB, tryGetLiveData,
  };
})();
