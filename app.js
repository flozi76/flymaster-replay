'use strict';

/* ── Palette ───────────────────────────────────────────────── */
const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a',
  '#ff5722','#607d8b','#ff9800','#03a9f4','#cddc39',
];

/* ── State ─────────────────────────────────────────────────── */
let map;
let pilots        = [];   // array of pilot objects
let globalMin     = Infinity;
let globalMax     = -Infinity;
let currentTime   = 0;
let isPlaying     = false;
let animId        = null;
let lastTs        = null;
let speed         = 10;

/* ── Leaflet map ───────────────────────────────────────────── */
function initMap() {
  map = L.map('map', { center: [47.2, 10.6], zoom: 9, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
}

/* ── Pilot object factory ──────────────────────────────────── */
function makePilotLayers(pilot) {
  const { color, fixes, name } = pilot;

  // Full ghost track (faint)
  const fullLatLngs = fixes.map(f => [f.lat, f.lon]);
  const fullTrack = L.polyline(fullLatLngs, {
    color, weight: 1.5, opacity: 0.2, interactive: false,
  }).addTo(map);

  // Animated trail (solid)
  const trail = L.polyline([], {
    color, weight: 2.5, opacity: 0.9, interactive: false,
  }).addTo(map);

  // Marker
  const marker = L.circleMarker(fullLatLngs[0] || [0, 0], {
    radius: 6, color: '#fff', weight: 2,
    fillColor: color, fillOpacity: 1,
  }).addTo(map).bindTooltip(name, {
    permanent: false, direction: 'top', className: 'pilot-marker-label',
  });

  return { fullTrack, trail, marker };
}

/* ── Add a pilot to the state ──────────────────────────────── */
function addPilot({ id, name, fixes, color }) {
  if (!fixes || fixes.length < 2) return null;

  globalMin = Math.min(globalMin, fixes[0].time);
  globalMax = Math.max(globalMax, fixes[fixes.length - 1].time);

  const pilot = { id, name, color, fixes, visible: true };
  const layers = makePilotLayers(pilot);
  Object.assign(pilot, layers);
  pilots.push(pilot);
  return pilot;
}

/* ── Interpolate position at a given time ──────────────────── */
function posAtTime(fixes, t) {
  if (t <= fixes[0].time)                    return { ...fixes[0], trailEnd: 0 };
  if (t >= fixes[fixes.length - 1].time)    return { ...fixes[fixes.length - 1], trailEnd: fixes.length - 1 };

  let lo = 0, hi = fixes.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].time <= t) lo = mid; else hi = mid;
  }
  const a = fixes[lo], b = fixes[hi];
  const frac = (t - a.time) / (b.time - a.time);
  return {
    lat:    a.lat    + frac * (b.lat    - a.lat),
    lon:    a.lon    + frac * (b.lon    - a.lon),
    alt:    Math.round(a.alt + frac * (b.alt - a.alt)),
    trailEnd: lo + 1,
  };
}

/* ── Update all markers & trails ───────────────────────────── */
function updatePositions(t) {
  pilots.forEach(pilot => {
    if (!pilot.visible) return;
    const { fixes, trail, marker } = pilot;
    const first = fixes[0].time, last = fixes[fixes.length - 1].time;

    if (t < first) {
      // Before flight – hide
      marker.setStyle({ opacity: 0, fillOpacity: 0 });
      trail.setLatLngs([]);
      return;
    }

    const pos = posAtTime(fixes, t);
    marker.setLatLng([pos.lat, pos.lon]);

    const faded = t > last;
    marker.setStyle({ opacity: faded ? 0.35 : 1, fillOpacity: faded ? 0.35 : 1 });

    // Trail up to current position
    const trailPts = fixes.slice(0, pos.trailEnd + 1).map(f => [f.lat, f.lon]);
    if (!faded) trailPts.push([pos.lat, pos.lon]);
    trail.setLatLngs(trailPts);

    // Update altitude in pilot list
    const altEl = document.getElementById(`alt-${pilot.id}`);
    if (altEl && !faded) altEl.textContent = `${pos.alt} m`;
  });
}

/* ── Animation loop ────────────────────────────────────────── */
function animStep(ts) {
  if (!lastTs) lastTs = ts;
  const elapsed = ts - lastTs;
  lastTs = ts;

  currentTime += (elapsed / 1000) * speed;
  if (currentTime >= globalMax) {
    currentTime = globalMax;
    stopPlay();
  }
  updatePositions(currentTime);
  syncUI();
  if (isPlaying) animId = requestAnimationFrame(animStep);
}

/* ── Playback control ──────────────────────────────────────── */
function startPlay() {
  if (!pilots.length) return;
  isPlaying = true;
  lastTs = null;
  qs('#btn-play').style.display  = 'none';
  qs('#btn-pause').style.display = 'inline-flex';
  animId = requestAnimationFrame(animStep);
}

function pausePlay() {
  isPlaying = false;
  lastTs = null;
  cancelAnimationFrame(animId);
  qs('#btn-play').style.display  = 'inline-flex';
  qs('#btn-pause').style.display = 'none';
}

function stopPlay() {
  pausePlay();
}

function rewind() {
  pausePlay();
  currentTime = globalMin;
  updatePositions(currentTime);
  syncUI();
}

/* ── UI helpers ────────────────────────────────────────────── */
function qs(sel) { return document.querySelector(sel); }

function fmtTime(unix) {
  if (!isFinite(unix)) return '--:--:-- UTC';
  const d = new Date(unix * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function syncUI() {
  qs('#time-display').textContent = fmtTime(currentTime);
  const range = globalMax - globalMin;
  if (range > 0) {
    qs('#time-slider').value = Math.round(((currentTime - globalMin) / range) * 1000);
  }
}

function renderPilotList() {
  const ul = qs('#pilot-list');
  ul.innerHTML = '';
  pilots.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'pilot-entry';

    const dot = document.createElement('span');
    dot.className = 'pilot-dot';
    dot.style.background = p.color;

    const label = document.createElement('label');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = p.visible;
    checkbox.addEventListener('change', () => togglePilot(i, checkbox.checked));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'pilot-name';
    nameSpan.title = p.name;
    nameSpan.textContent = p.name;

    const altSpan = document.createElement('span');
    altSpan.className = 'pilot-alt';
    altSpan.id = `alt-${p.id}`;

    label.append(checkbox, nameSpan);
    li.append(dot, label, altSpan);
    ul.appendChild(li);
  });
  qs('#pilot-count').textContent = `${pilots.length} pilot${pilots.length !== 1 ? 's' : ''}`;
  qs('#btn-clear').style.display = pilots.length ? 'inline-block' : 'none';
}

function fitMap() {
  if (!pilots.length) return;
  const pts = pilots.flatMap(p => p.fixes.map(f => [f.lat, f.lon]));
  if (pts.length) map.fitBounds(L.latLngBounds(pts));
}

/* ── Toggle pilot visibility ───────────────────────────────── */
function togglePilot(i, visible) {   // called from checkbox event listener
  const p = pilots[i];
  p.visible = visible;
  [p.fullTrack, p.trail].forEach(l => visible ? l.addTo(map) : l.remove());
  visible ? p.marker.addTo(map) : p.marker.remove();
}

/* ── Clear all ─────────────────────────────────────────────── */
function clearAll() {
  stopPlay();
  pilots.forEach(p => {
    p.fullTrack.remove(); p.trail.remove(); p.marker.remove();
  });
  pilots       = [];
  globalMin    = Infinity;
  globalMax    = -Infinity;
  currentTime  = 0;
  qs('#time-slider').value = 0;
  qs('#time-display').textContent = '--:--:-- UTC';
  renderPilotList();
}

/* ── IGC file loading ──────────────────────────────────────── */
async function loadIGCFiles(files) {
  const igcFiles = Array.from(files).filter(f => /\.igc$/i.test(f.name));
  if (!igcFiles.length) return;

  const startIndex = pilots.length;
  await Promise.all(igcFiles.map((file, i) => new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseIGC(e.target.result);
      const name = parsed.pilotName ||
        file.name.replace(/\.igc$/i, '').replace(/_/g, ' ');
      addPilot({
        id:    `igc-${startIndex + i}`,
        name,
        fixes: parsed.fixes,
        color: COLORS[(startIndex + i) % COLORS.length],
      });
      resolve();
    };
    reader.readAsText(file);
  })));

  finalisePilots();
}

/* ── Flymaster live group loading ──────────────────────────── */
async function loadFlymasterGroup(urlOrId, token = '') {
  const groupId = FlymasterClient.parseGroupId(urlOrId);
  if (!groupId) {
    setStatus('Could not parse group ID from that input.', 'error');
    return;
  }

  setStatus('Connecting to Flymaster…');
  qs('#btn-load-group').disabled = true;

  try {
    // 1 – Pilot list
    setStatus('Fetching pilot list…');
    const pilotList = await FlymasterClient.getPilots(groupId);
    if (!pilotList.length) {
      setStatus('No pilots found in this group.', 'error');
      return;
    }
    setStatus(`Found ${pilotList.length} pilots — fetching tracks…`);

    // 2 – Track data: look back 48 h so yesterday's events are covered too
    const from48h = Math.floor(Date.now() / 1000) - 48 * 3600;

    const tracks = await FlymasterClient.tryGetLiveData(groupId, pilotList, from48h, token);

    const startIndex = pilots.length;
    let added = 0;
    pilotList.forEach((p, i) => {
      const fixes = tracks[p.serial] || [];
      if (fixes.length < 2) return;
      addPilot({
        id:    `fm-${groupId}-${p.serial}`,
        name:  p.name,
        fixes,
        color: COLORS[(startIndex + i) % COLORS.length],
      });
      added++;
    });

    if (added === 0) {
      setStatus(
        `Pilots loaded but no track data found.\n` +
        `If this is a private group, enter the access token above.\n` +
        `For full replay, download IGC files from the group page and upload them here.`,
        'error',
      );
    } else {
      setStatus(`Loaded ${added} pilot${added !== 1 ? 's' : ''} with tracks.`, 'ok');
      finalisePilots();
    }
  } catch (err) {
    setStatus(
      `Failed: ${err.message}\n` +
      `Check your network connection and try again, ` +
      `or upload IGC files directly.`,
      'error',
    );
  } finally {
    qs('#btn-load-group').disabled = false;
  }
}

function setStatus(msg, cls = '') {
  const el = qs('#live-status');
  el.textContent = msg;
  el.className = `status-msg ${cls}`;
}

/* ── Finalise after adding pilots ──────────────────────────── */
function finalisePilots() {
  if (globalMin === Infinity) return;
  currentTime = globalMin;
  renderPilotList();
  fitMap();
  updatePositions(currentTime);
  syncUI();
}

/* ── Wire up DOM events ────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initMap();

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      qs(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // IGC drop zone
  const dropZone = qs('#drop-zone');
  const fileInput = qs('#file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  fileInput.addEventListener('change', e => {
    loadIGCFiles(e.target.files);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    loadIGCFiles(e.dataTransfer.files);
  });

  // Flymaster group
  qs('#btn-load-group').addEventListener('click', () => {
    const token = (qs('#group-token').value || '').trim();
    loadFlymasterGroup(qs('#group-url').value, token);
  });

  // Playback controls
  qs('#btn-play').addEventListener('click', startPlay);
  qs('#btn-pause').addEventListener('click', pausePlay);
  qs('#btn-rewind').addEventListener('click', rewind);

  qs('#speed-select').addEventListener('change', e => {
    speed = parseInt(e.target.value, 10);
  });

  qs('#time-slider').addEventListener('input', e => {
    const range = globalMax - globalMin;
    currentTime = globalMin + (parseInt(e.target.value, 10) / 1000) * range;
    lastTs = null;
    updatePositions(currentTime);
    qs('#time-display').textContent = fmtTime(currentTime);
  });

  qs('#btn-clear').addEventListener('click', clearAll);
});
