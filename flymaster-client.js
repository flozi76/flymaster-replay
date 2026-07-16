'use strict';

/**
 * Flymaster LiveTracking API client.
 *
 * All API calls go through the Netlify proxy function when the app is hosted
 * on Netlify (/.netlify/functions/flymaster-proxy), which avoids CORS.
 * When running locally or on GitHub Pages the client tries direct calls;
 * most browsers will block these due to CORS on lb/lt.flymaster.net.
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
  const PROXY = '/.netlify/functions/flymaster-proxy';

  // Use the Netlify proxy when the app is hosted on a Netlify domain.
  // On GitHub Pages or a plain local server the browser calls Flymaster
  // directly, which may be blocked by CORS.
  function useProxy() {
    const h = window.location.hostname;
    // Anchor to full domain boundary (leading dot) to prevent prefix spoofing
    // e.g. "evilnetlify.com".endsWith("netlify.com") would match without the dot.
    return h.endsWith('.netlify.app') || h.endsWith('.netlify.com');
  }

  async function apiFetch(url) {
    const target = useProxy()
      ? `${PROXY}?url=${encodeURIComponent(url)}`
      : url;

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
   * Try live data; if the token-free call fails fall back to an empty result.
   * Used for browsable (public) groups.
   */
  async function tryGetLiveData(groupId, pilots, fromTime) {
    try {
      return await getLiveData(groupId, pilots, fromTime);
    } catch {
      return {};
    }
  }

  return { parseGroupId, getServerTime, getPilots, getLiveData, tryGetLiveData };
})();
