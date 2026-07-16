# 🪂 Flymaster Replay

A browser-based tool for replaying a group flying day using **IGC flight log files** exported from Flymaster (or any compatible GPS logger). Load multiple pilots' IGC files, then watch all flights animate together on an interactive map — no backend, no API key required.

---

## Features

- **Multi-pilot replay** — load as many IGC files as you like; each pilot gets a unique colour
- **Interactive map** — built on [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles (free, no API key needed)
- **Animated playback** — play, pause, rewind and scrub through the flying day on a timeline
- **Variable speed** — 1×, 2×, 5×, 10×, 30×, 60× playback
- **Per-pilot visibility toggle** — hide/show individual pilots from the legend panel
- **Works fully offline** — once the page is loaded all processing happens in the browser
- **No build step** — plain HTML / CSS / JavaScript; just open `index.html` or run with Docker

---

## Getting Started

### Option A — Open directly in a browser

```bash
# Clone the repo
git clone https://github.com/flozi76/flymaster-replay.git
cd flymaster-replay

# Open in your browser (no server needed)
open index.html          # macOS
xdg-open index.html      # Linux
start index.html         # Windows
```

### Option B — Docker (recommended for local sharing)

**Requirements:** Docker + Docker Compose

```bash
# Build and start the container
docker compose up --build

# The app is now available at:
# http://localhost:8080
```

To stop:

```bash
docker compose down
```

---

## Free Cloud Deployment

The app is pure static HTML/CSS/JS — no server-side code — so it deploys for free on any static hosting platform.

### GitHub Pages (zero extra accounts)

1. Go to your repository **Settings → Pages**
2. Under *Source*, select **GitHub Actions**
3. Push to `main` — the workflow in `.github/workflows/deploy.yml` runs automatically
4. Your app is live at `https://<your-username>.github.io/<repo-name>/`

### Netlify

1. Log in at [netlify.com](https://netlify.com) and click **Add new site → Import an existing project**
2. Connect your GitHub repository
3. Leave the build command blank and set the publish directory to `.`
4. Click **Deploy** — Netlify picks up `netlify.toml` automatically
5. Your app gets a free `*.netlify.app` URL (custom domain also free)

### Render

1. Log in at [render.com](https://render.com) and click **New → Static Site**
2. Connect your GitHub repository
3. Render reads `render.yaml` and configures everything automatically
4. Your app gets a free `*.onrender.com` URL

| Platform | URL format | Custom domain | Deploy on push |
|----------|-----------|--------------|----------------|
| GitHub Pages | `<user>.github.io/<repo>` | ✅ free | ✅ |
| Netlify | `<site>.netlify.app` | ✅ free | ✅ |
| Render | `<site>.onrender.com` | ✅ free | ✅ |

---

## Usage

1. **Upload IGC files** — drag-and-drop one or more `.igc` files onto the upload zone, or click to open a file picker. You can add more files at any time.
2. **Press ▶ Play** — all pilots animate simultaneously from the earliest to the latest GPS fix.
3. **Scrub the timeline** — drag the slider to jump to any point in the day.
4. **Adjust speed** — use the speed selector (default 10×) to slow down or fast-forward.
5. **Toggle pilots** — check/uncheck pilot names in the left panel to show or hide them.
6. **Rewind** — press ⏮ to jump back to the start.

---

## Getting IGC Files

| Source | How |
|--------|-----|
| **Flymaster cloud** | Log in → My Flights → select flight → Download → IGC |
| **Flymaster LiveTracking** | After the event, each pilot can export their track |
| **XCTrack / XCSoar** | Save flight as IGC from the app |
| **Any IGC-compatible logger** | Any standard-compliant IGC file works |

> **Tip for group events:** ask each pilot to download their IGC file after landing and share them in a group chat. Then load all files into Flymaster Replay for a collective debrief.

---

## How It Works

The app parses **IGC B-records** (GPS fixes) from each file:

```
B HHMMSS DDMMmmmN DDDMMmmmE/W A PPPPP GGGGG
```

- `HHMMSS` — UTC time of fix
- Latitude / Longitude in degrees + decimal minutes
- `A`/`V` — 3D / 2D fix validity
- Pressure altitude and GPS altitude (metres)

Positions are linearly interpolated between fixes so the animation is smooth even at 1-second logging intervals.

---

## Project Structure

```
flymaster-replay/
├── index.html          # Single-page application shell
├── style.css           # UI styles
├── igc-parser.js       # Pure-JS IGC file parser
├── app.js              # Leaflet map, animation loop, controls
├── nginx.conf          # nginx configuration for the Docker image
├── Dockerfile          # nginx:alpine image definition
├── docker-compose.yml  # One-command startup
├── .gitignore
└── .dockerignore
```

---

## Development

No build tools are required. Edit any file and reload the browser.

For live-reload during development the Docker volume mount in `docker-compose.yml` serves local files directly:

```yaml
volumes:
  - .:/usr/share/nginx/html:ro
```

---

## Data Sources & API Notes

Flymaster does not expose an official public API. This tool deliberately avoids undocumented endpoints and works exclusively with locally-exported IGC files, which means:

- ✅ No API keys or authentication needed
- ✅ Works offline after page load
- ✅ Your flight data never leaves the browser
- ✅ Not affected by Flymaster server changes or rate limits

For live tracking integration, see [LiveTrack24](https://www.livetrack24.com/apps/flymaster) or the open-source [flyXC](https://github.com/vicb/flyxc) project.

---

## License

MIT
