'use strict';

/**
 * IGC file parser.
 * Returns { pilotName, gliderType, date, fixes[] }
 * Each fix: { time (Unix seconds), lat, lon, pressureAlt, gpsAlt }
 */
function parseIGC(content) {
  const lines = content.split(/\r?\n/);

  let pilotName  = null;
  let gliderType = null;
  let dayStartUnix = null; // Unix timestamp of midnight UTC on flight date
  const fixes = [];

  for (const line of lines) {
    if (!line) continue;
    const type = line[0];

    // ── Date record ──────────────────────────────────────────
    // Formats: HFDTE DDMMYY  |  HFDTEDATE:DDMMYY,NN
    if (type === 'H' && line.includes('DTE')) {
      const m = line.match(/(\d{2})(\d{2})(\d{2})/);
      if (m) {
        const dd   = parseInt(m[1], 10);
        const mm   = parseInt(m[2], 10) - 1; // 0-based month
        const year = 2000 + parseInt(m[3], 10);
        dayStartUnix = Date.UTC(year, mm, dd) / 1000;
      }
    }

    // ── Pilot name ────────────────────────────────────────────
    if (type === 'H' && /PLT/.test(line)) {
      const m = line.match(/PLT[^:]*:(.+)/);
      if (m) pilotName = m[1].trim() || null;
    }

    // ── Glider type ───────────────────────────────────────────
    if (type === 'H' && /GTY/.test(line)) {
      const m = line.match(/GTY[^:]*:(.+)/);
      if (m) gliderType = m[1].trim() || null;
    }

    // ── B record (GPS fix) ────────────────────────────────────
    // B HHMMSS DDMMmmmN DDDMMmmmE/W A PPPPP GGGGG
    if (type === 'B' && line.length >= 35) {
      const fix = parseBRecord(line, dayStartUnix);
      if (fix) fixes.push(fix);
    }
  }

  // Handle midnight rollover within the same file
  for (let i = 1; i < fixes.length; i++) {
    if (fixes[i].time < fixes[i - 1].time) {
      for (let j = i; j < fixes.length; j++) fixes[j].time += 86400;
    }
  }

  return { pilotName, gliderType, dayStartUnix, fixes };
}

function parseBRecord(line, dayStartUnix) {
  // Time
  const hh = parseInt(line.substring(1, 3),  10);
  const mm = parseInt(line.substring(3, 5),  10);
  const ss = parseInt(line.substring(5, 7),  10);
  if (isNaN(hh) || isNaN(mm) || isNaN(ss)) return null;

  const secondsInDay = hh * 3600 + mm * 60 + ss;
  // Prefer Unix timestamps; fall back to seconds-since-midnight if date unknown
  const time = dayStartUnix != null ? dayStartUnix + secondsInDay : secondsInDay;

  // Latitude: DDMMmmmN at positions 7–14
  const latDeg     = parseInt(line.substring(7,  9),  10);
  const latMin     = parseInt(line.substring(9,  11), 10);
  const latMilliMin = parseInt(line.substring(11, 14), 10);
  const latHem     = line[14];
  if (isNaN(latDeg) || isNaN(latMin) || isNaN(latMilliMin)) return null;

  let lat = latDeg + (latMin + latMilliMin / 1000) / 60;
  if (latHem === 'S') lat = -lat;

  // Longitude: DDDMMmmmE/W at positions 15–23
  const lonDeg     = parseInt(line.substring(15, 18), 10);
  const lonMin     = parseInt(line.substring(18, 20), 10);
  const lonMilliMin = parseInt(line.substring(20, 23), 10);
  const lonHem     = line[23];
  if (isNaN(lonDeg) || isNaN(lonMin) || isNaN(lonMilliMin)) return null;

  let lon = lonDeg + (lonMin + lonMilliMin / 1000) / 60;
  if (lonHem === 'W') lon = -lon;

  const pressureAlt = parseInt(line.substring(25, 30), 10);
  const gpsAlt      = parseInt(line.substring(30, 35), 10);

  return {
    time,
    lat,
    lon,
    pressureAlt: isNaN(pressureAlt) ? 0 : pressureAlt,
    gpsAlt:      isNaN(gpsAlt)      ? 0 : gpsAlt,
  };
}
