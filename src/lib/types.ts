/** Playback quality: mobile = default (smaller), hd = web/normalized. */
export type VideoQuality = "mobile" | "hd";

export type VideoEntry = {
  id: string;
  title: string;
  from?: string;
  /** Lower numbers appear first. */
  order?: number;
  /** Easter egg: only shown after clicking All a second time (All deselected). */
  hidden?: boolean;
  /** Drive file id for mobile (default) encode. */
  driveFileId: string;
  /** Drive file id for HD / web encode. */
  driveFileIdHd?: string;
  tags: string[];
  durationSec?: number;
  /** Local/direct URL for mobile (default). */
  src?: string;
  /** Local/direct URL for HD. */
  srcHd?: string;
};

export type SiteConfig = {
  title: string;
  videos: VideoEntry[];
};
