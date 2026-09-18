import type { VideoQuality } from "./types";

const STORAGE_KEY = "mel40-quality";
export const QUALITY_CHANGE_EVENT = "mel40:quality";

export function getQuality(): VideoQuality {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "hd" || stored === "mobile") return stored;
  } catch {
    /* ignore */
  }
  return "mobile";
}

export function setQuality(quality: VideoQuality): void {
  try {
    localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(QUALITY_CHANGE_EVENT, { detail: quality }));
}
