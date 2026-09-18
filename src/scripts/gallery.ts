import type { VideoEntry } from "../lib/types";
import { playOne } from "./player";

type Options = {
  root: HTMLElement;
  videos: VideoEntry[];
  playerRoot: HTMLElement;
  onFilterChange: (filtered: VideoEntry[]) => void;
};

/** all = every non-hidden; easter = only hidden; string = tag filter */
type FilterMode = "all" | "easter" | string;

function normTag(t: string): string {
  return t.trim().toLowerCase();
}

export function mountGallery(opts: Options): { getFiltered: () => VideoEntry[] } {
  const { root, videos, playerRoot, onFilterChange } = opts;

  const allTags = [
    ...new Set(
      videos
        .filter((v) => !v.hidden)
        .flatMap((v) => v.tags.map(normTag))
        .filter(Boolean),
    ),
  ].sort();

  let mode: FilterMode = "all";

  root.innerHTML = `
    <div class="gallery">
      <div class="gallery__tags" data-tags></div>
      <div class="gallery__grid" data-grid></div>
    </div>
  `;

  const tagsEl = root.querySelector<HTMLElement>("[data-tags]")!;
  const gridEl = root.querySelector<HTMLElement>("[data-grid]")!;

  function filtered(): VideoEntry[] {
    if (mode === "all") {
      return videos.filter((v) => !v.hidden);
    }
    if (mode === "easter") {
      return videos.filter((v) => v.hidden);
    }
    return videos.filter(
      (v) => !v.hidden && v.tags.some((t) => normTag(t) === mode),
    );
  }

  function renderTags() {
    tagsEl.innerHTML = "";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tag" + (mode === "all" ? " tag--active" : "");
    clear.textContent = "All";
    clear.addEventListener("click", () => {
      // Second click on All → easter egg (hidden-only). Otherwise back to All.
      mode = mode === "all" ? "easter" : "all";
      render();
    });
    tagsEl.append(clear);

    for (const tag of allTags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag" + (mode === tag ? " tag--active" : "");
      btn.textContent = tag;
      btn.addEventListener("click", () => {
        mode = mode === tag ? "all" : tag;
        render();
      });
      tagsEl.append(btn);
    }
  }

  function renderGrid() {
    const list = filtered();
    onFilterChange(list);
    gridEl.innerHTML = "";
    if (!list.length) {
      // Stay quiet in easter mode if there are no hidden videos yet
      if (mode !== "easter") {
        gridEl.innerHTML = `<p class="gallery__empty">No videos for these tags.</p>`;
      }
      return;
    }
    for (const video of list) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.innerHTML = `
        <span class="card__title">${escapeHtml(video.title)}</span>
        ${
          video.from && video.from.trim().toLowerCase() !== video.title.trim().toLowerCase()
            ? `<span class="card__from">${escapeHtml(video.from)}</span>`
            : ""
        }
        ${
          (() => {
            const tags = video.tags.filter((t) => t.trim() && t.trim().toLowerCase() !== "todo");
            return tags.length
              ? `<span class="card__tags">${tags.map(escapeHtml).join(" · ")}</span>`
              : "";
          })()
        }
      `;
      card.addEventListener("click", () => playOne(playerRoot, video));
      gridEl.append(card);
    }
  }

  function render() {
    renderTags();
    renderGrid();
  }

  render();
  return { getFiltered: filtered };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
