# Mel 40

Birthday video gallery: Astro static site + Google Drive configs/videos + local ffmpeg normalize pipeline.

## Quick start

```bash
npm install
cp .env.example .env   # optional for real Drive configs
npm run dev
```

Open [http://localhost:4321/local](http://localhost:4321/local) for the local gallery (no API key).

## How sharing works

1. Normalize videos (below) and upload the MP4s to Google Drive as **Anyone with the link → Viewer**.
2. Create a JSON config (see `public/site-config.example.json`) listing `driveFileId` and `tags`.
3. Upload that JSON to Drive the same way. Copy its **file id**.
4. Share `https://<your-site>/<drive-config-file-id>`.

Different config files = different audiences / subsets. Tags (`friends`, `family`, `groupX`, …) filter within a config.

Set `PUBLIC_GOOGLE_API_KEY` (Drive API enabled, HTTP-referrer restricted to your site). Optionally set `PUBLIC_MEDIA_PROXY_URL` to the Worker below for more reliable `<video>` streaming.

## Normalize videos (`tools/normalize.py`)

```text
videos/incoming/     # drop originals here
  jobs.json          # optional trim/stitch jobs
videos/normalized/   # outputs (gitignored)
```

```bash
npm run normalize              # web (~720p, 2.5 Mbps) → videos/normalized
npm run normalize:mobile       # mobile (~480p, 200 kbps, ~10× smaller) → videos/normalized_mobile
npm run normalize:all          # both
# or: python3 tools/normalize.py --profile mobile --force
```

- **Default:** every media file not claimed by a job is plain-normalized (H.264/AAC, `+faststart`).
- **Mobile:** by default re-encodes from `videos/normalized/` when present (fast); use `--no-from-web` to encode from incoming.
- **Jobs:** copy `videos/incoming/jobs.example.json` → `jobs.json`. Supports `trim` (negative `endSec` = drop last N seconds) and `stitch`, including combinations.

Requires `ffmpeg` and `ffprobe` on `PATH`.

## Player

- Tag filter gallery (OR across selected tags).
- “Play” queues the current filtered selection.
- A/B dual-element prefetch to warm the next full video before the cut.

Client-side clip ranges (`startSec`/`endSec`) are backlog.

## Optional Drive media Worker

```bash
cd worker
npx wrangler secret put GOOGLE_API_KEY
npx wrangler deploy
```

Then set `PUBLIC_MEDIA_PROXY_URL` to the worker URL.

## Deploy

`npm run build` writes `dist/` and copies `404.html` for GitHub Pages SPA paths.

- **GitHub Pages:** enable Pages (GitHub Actions). Workflow: `.github/workflows/deploy-pages.yml`. Add repository secrets `PUBLIC_GOOGLE_API_KEY` and optional `PUBLIC_MEDIA_PROXY_URL`. For a project site, set `base: '/<repo>/'` in `astro.config.mjs`.
- **Cloudflare Pages:** connect the repo; build `npm run build`, output `dist`. `public/_redirects` provides SPA fallback.
