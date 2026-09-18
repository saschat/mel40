import { configIdFromPath, loadSiteConfig } from "../lib/drive";
import { getQuality, setQuality } from "../lib/quality";
import type { VideoEntry, VideoQuality } from "../lib/types";
import { mountGallery } from "./gallery";
import { mountPlayer } from "./player";

function mountQualityToggle(host: HTMLElement): void {
  host.innerHTML = `
    <div class="quality" role="group" aria-label="Video quality">
      <button type="button" class="quality__btn" data-quality="mobile">Mobile</button>
      <button type="button" class="quality__btn" data-quality="hd">HD</button>
    </div>
  `;

  const sync = (q: VideoQuality) => {
    for (const btn of host.querySelectorAll<HTMLButtonElement>(".quality__btn")) {
      btn.classList.toggle("quality__btn--active", btn.dataset.quality === q);
    }
  };

  sync(getQuality());

  host.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-quality]");
    if (!btn?.dataset.quality) return;
    const q = btn.dataset.quality as VideoQuality;
    if (q !== "mobile" && q !== "hd") return;
    setQuality(q);
    sync(q);
  });
}

async function main() {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) return;

  const configId = configIdFromPath(window.location.pathname, import.meta.env.BASE_URL);

  if (!configId) {
    app.innerHTML = `
      <main class="shell shell--gate">
        <h1 class="brand">Mel’s 40</h1>
        <p class="lede">Open a private link to view this birthday gallery.</p>
        <p class="hint">Local preview: <a href="${import.meta.env.BASE_URL}local">/local</a></p>
      </main>
    `;
    return;
  }

  app.innerHTML = `
    <main class="shell">
      <header class="top">
        <div class="top__row">
          <h1 class="title" data-site-title>Loading…</h1>
          <div data-quality-root></div>
        </div>
      </header>
      <div data-status class="status">Loading gallery…</div>
      <section data-player-root></section>
      <section data-gallery-root></section>
    </main>
  `;

  const status = app.querySelector<HTMLElement>("[data-status]")!;
  const titleEl = app.querySelector<HTMLElement>("[data-site-title]")!;
  const playerRoot = app.querySelector<HTMLElement>("[data-player-root]")!;
  const galleryRoot = app.querySelector<HTMLElement>("[data-gallery-root]")!;
  const qualityRoot = app.querySelector<HTMLElement>("[data-quality-root]")!;

  mountQualityToggle(qualityRoot);

  try {
    const config = await loadSiteConfig(configId);
    titleEl.textContent = config.title;
    status.hidden = true;

    let filteredCache: VideoEntry[] = config.videos;

    const player = mountPlayer({
      root: playerRoot,
      getFilteredVideos: () => filteredCache,
    });

    mountGallery({
      root: galleryRoot,
      videos: config.videos,
      playerRoot,
      onFilterChange: (filtered) => {
        filteredCache = filtered;
      },
    });

    (window as unknown as { __mel40?: unknown }).__mel40 = { config, player };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.classList.add("status--error");
    status.textContent = message;
  }
}

void main();
