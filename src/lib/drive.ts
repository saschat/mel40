import type { SiteConfig, VideoEntry, VideoQuality } from "./types";
import { getQuality } from "./quality";

function apiKey(): string {
  return import.meta.env.PUBLIC_GOOGLE_API_KEY ?? "";
}

function mediaProxy(): string {
  return (import.meta.env.PUBLIC_MEDIA_PROXY_URL ?? "").replace(/\/$/, "");
}

function driveMediaUrl(driveFileId: string): string {
  const proxy = mediaProxy();
  if (proxy) return `${proxy}/${encodeURIComponent(driveFileId)}`;
  const key = apiKey();
  if (key) {
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media&key=${encodeURIComponent(key)}`;
  }
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`;
}

/** Resolve playable URL for the current (or given) quality. Defaults to mobile. */
export function mediaUrlFor(video: VideoEntry, quality: VideoQuality = getQuality()): string {
  if (quality === "hd") {
    if (video.srcHd) return video.srcHd;
    if (video.driveFileIdHd) return driveMediaUrl(video.driveFileIdHd);
    // Fall back to mobile fields if HD not configured
  }
  if (video.src) return video.src;
  if (video.driveFileId) return driveMediaUrl(video.driveFileId);
  if (video.srcHd) return video.srcHd;
  if (video.driveFileIdHd) return driveMediaUrl(video.driveFileIdHd);
  return "";
}

/** @deprecated use mediaUrlFor */
export function mediaUrl(driveFileId: string, overrideSrc?: string): string {
  if (overrideSrc) return overrideSrc;
  return driveMediaUrl(driveFileId);
}

export function previewEmbedUrl(driveFileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/preview`;
}

/** Local/dev configs shipped in public/configs/ (no Drive key needed). */
const LOCAL_CONFIGS: Record<string, string> = {
  local: "configs/mel40.json",
};

export async function loadSiteConfig(configId: string): Promise<SiteConfig> {
  const localPath = LOCAL_CONFIGS[configId];
  let config: SiteConfig;
  if (localPath) {
    const res = await fetch(`${import.meta.env.BASE_URL}${localPath}`);
    if (!res.ok) throw new Error(`Failed to load local config (${localPath})`);
    config = (await res.json()) as SiteConfig;
  } else {
    const key = apiKey();
    if (!key) {
      throw new Error(
        "Missing PUBLIC_GOOGLE_API_KEY. Set it in .env, or open /local.",
      );
    }

    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(configId)}?alt=media&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Could not load config (${res.status}): ${text.slice(0, 200)}`);
    }
    config = (await res.json()) as SiteConfig;
  }

  config.videos = [...config.videos].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
  return config;
}

/** Path segment after base, e.g. /abc123 → abc123 */
export function configIdFromPath(pathname: string, base = "/"): string | null {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  let path = pathname;
  if (normalizedBase && path.startsWith(normalizedBase)) {
    path = path.slice(normalizedBase.length) || "/";
  }
  const segment = path.replace(/^\/+/, "").split("/")[0] ?? "";
  if (!segment || segment === "index.html") return null;
  return decodeURIComponent(segment);
}
