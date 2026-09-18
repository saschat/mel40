import type { VideoEntry } from "../lib/types";
import { mediaUrlFor } from "../lib/drive";
import { QUALITY_CHANGE_EVENT } from "../lib/quality";

type Options = {
  root: HTMLElement;
  getFilteredVideos: () => VideoEntry[];
};

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function mountPlayer(opts: Options): { playVideos: (videos: VideoEntry[]) => void } {
  const { root, getFilteredVideos } = opts;

  root.innerHTML = `
    <div class="player" data-player>
      <div class="player__stage">
        <video class="player__video player__video--a" playsinline></video>
        <video class="player__video player__video--b" playsinline hidden></video>
        <div class="player__overlay" data-overlay hidden>
          <p data-overlay-text>Next up…</p>
        </div>
      </div>
      <div class="player__meta">
        <h2 class="player__title" data-title hidden></h2>
        <p class="player__from" data-from hidden></p>
      </div>
      <div class="player__controls">
        <button type="button" class="player__play" data-play aria-label="Play or pause">Play</button>
        <button type="button" class="player__fullscreen" data-fullscreen aria-label="Toggle fullscreen">Fullscreen</button>
        <span class="player__time"><span data-time>0:00</span> / <span data-dur>0:00</span></span>
      </div>
    </div>
  `;

  const videoA = root.querySelector<HTMLVideoElement>(".player__video--a")!;
  const videoB = root.querySelector<HTMLVideoElement>(".player__video--b")!;
  const overlay = root.querySelector<HTMLElement>("[data-overlay]")!;
  const overlayText = root.querySelector<HTMLElement>("[data-overlay-text]")!;
  const titleEl = root.querySelector<HTMLElement>("[data-title]")!;
  const fromEl = root.querySelector<HTMLElement>("[data-from]")!;
  const timeEl = root.querySelector<HTMLElement>("[data-time]")!;
  const durEl = root.querySelector<HTMLElement>("[data-dur]")!;
  const playBtn = root.querySelector<HTMLButtonElement>("[data-play]")!;
  const fullscreenBtn = root.querySelector<HTMLButtonElement>("[data-fullscreen]")!;
  const playerEl = root.querySelector<HTMLElement>("[data-player]")!;
  const stageEl = root.querySelector<HTMLElement>(".player__stage")!;

  let queue: VideoEntry[] = [];
  let index = 0;
  let active: HTMLVideoElement = videoA;
  let standby: HTMLVideoElement = videoB;
  let standbyIndex: number | null = null;
  /** Bumps on every playIndex to drop stale async work. */
  let playGen = 0;

  function srcFor(video: VideoEntry): string {
    return mediaUrlFor(video);
  }

  function setMeta(video: VideoEntry | undefined) {
    if (!video) {
      titleEl.textContent = "";
      fromEl.textContent = "";
      titleEl.hidden = true;
      fromEl.hidden = true;
      return;
    }
    titleEl.hidden = false;
    titleEl.textContent = video.title;
    const from = video.from?.trim() ?? "";
    const showFrom = Boolean(from && from.toLowerCase() !== video.title.trim().toLowerCase());
    fromEl.hidden = !showFrom;
    fromEl.textContent = showFrom ? `From ${from}` : "";
  }

  function showOverlay(message: string | null) {
    if (!message) {
      overlay.hidden = true;
      return;
    }
    overlayText.textContent = message;
    overlay.hidden = false;
  }

  function setPlayingUi(playing: boolean) {
    playBtn.textContent = playing ? "Pause" : "Play";
  }

  function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
  }

  /** play() without treating load-interrupt aborts as user-facing failures. */
  async function safePlay(el: HTMLVideoElement): Promise<"ok" | "aborted" | "blocked"> {
    try {
      await el.play();
      return "ok";
    } catch (err) {
      if (isAbortError(err)) return "aborted";
      return "blocked";
    }
  }

  function waitCanPlay(el: HTMLVideoElement, gen: number): Promise<void> {
    if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const poll = window.setInterval(() => {
        if (gen !== playGen) finish();
      }, 100);
      const timer = window.setTimeout(finish, 10_000);
      function finish() {
        if (settled) return;
        settled = true;
        window.clearInterval(poll);
        window.clearTimeout(timer);
        el.removeEventListener("canplay", finish);
        el.removeEventListener("error", finish);
        resolve();
      }
      el.addEventListener("canplay", finish);
      el.addEventListener("error", finish);
    });
  }

  function assign(
    el: HTMLVideoElement,
    video: VideoEntry,
    { muted, preload }: { muted: boolean; preload: string },
  ) {
    el.pause();
    el.muted = muted;
    el.preload = preload as HTMLVideoElement["preload"];
    el.src = srcFor(video);
    el.load();
  }

  function warmNext() {
    const next = queue[index + 1];
    if (!next) {
      standby.pause();
      standby.removeAttribute("src");
      standby.load();
      standbyIndex = null;
      return;
    }
    if (standbyIndex === index + 1 && standby.getAttribute("src")) return;
    assign(standby, next, { muted: true, preload: "auto" });
    standbyIndex = index + 1;
  }

  function scheduleWarm(gen: number) {
    // Defer so load() on standby cannot race the active play() microtask.
    queueMicrotask(() => {
      if (gen === playGen) warmNext();
    });
  }

  async function playIndex(
    i: number,
    { fromStandby = false, resumeAt }: { fromStandby?: boolean; resumeAt?: number } = {},
  ) {
    if (i < 0 || i >= queue.length) return;
    const gen = ++playGen;
    index = i;
    const video = queue[index]!;
    setMeta(video);
    setPlayingUi(true);

    const useStandby = fromStandby && standbyIndex === i && Boolean(standby.getAttribute("src"));

    if (useStandby) {
      active.pause();
      active.hidden = true;
      standby.hidden = false;
      standby.muted = false;
      // Seeking a Drive-backed element often triggers a new load and aborts play().
      if (standby.currentTime > 0.35) {
        try {
          standby.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
      const prevActive = active;
      active = standby;
      standby = prevActive;
      standbyIndex = null;
      showOverlay(null);

      if (active.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        await waitCanPlay(active, gen);
        if (gen !== playGen) return;
      }

      const result = await safePlay(active);
      if (gen !== playGen) return;
      if (result === "blocked" || (result === "aborted" && active.paused)) {
        showOverlay("Tap play to continue");
        setPlayingUi(false);
      }
      scheduleWarm(gen);
      return;
    }

    assign(active, video, { muted: false, preload: "auto" });
    active.hidden = false;
    standby.hidden = true;
    showOverlay(null);

    if (resumeAt != null && resumeAt > 0) {
      const seekTo = resumeAt;
      active.addEventListener(
        "loadedmetadata",
        () => {
          if (gen !== playGen) return;
          try {
            active.currentTime = Math.min(seekTo, active.duration || seekTo);
          } catch {
            /* ignore */
          }
        },
        { once: true },
      );
    }

    await waitCanPlay(active, gen);
    if (gen !== playGen) return;

    const result = await safePlay(active);
    if (gen !== playGen) return;
    if (result === "blocked" || (result === "aborted" && active.paused)) {
      showOverlay("Tap play to start");
      setPlayingUi(false);
    }
    scheduleWarm(gen);
  }

  function onTimeUpdate() {
    timeEl.textContent = formatTime(active.currentTime);
    const d = active.duration;
    durEl.textContent = Number.isFinite(d) ? formatTime(d) : formatTime(queue[index]?.durationSec ?? 0);

    const remaining = (Number.isFinite(d) ? d : 0) - active.currentTime;
    if (remaining > 0 && remaining < 8) {
      warmNext();
      const next = queue[index + 1];
      if (next && standby.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        showOverlay(`Next up: ${next.title}`);
      } else if (next) {
        showOverlay(null);
      }
    }
  }

  function onEnded() {
    if (index + 1 < queue.length) {
      // Prefer the prefetched element whenever it holds the next item (even if
      // still buffering) — re-assigning onto `active` races play()/load().
      const canSwap = standbyIndex === index + 1 && Boolean(standby.getAttribute("src"));
      void playIndex(index + 1, { fromStandby: canSwap });
    } else {
      setPlayingUi(false);
      showOverlay("End of playlist");
    }
  }

  videoA.addEventListener("ended", () => {
    if (active === videoA) onEnded();
  });
  videoB.addEventListener("ended", () => {
    if (active === videoB) onEnded();
  });
  videoA.addEventListener("timeupdate", () => {
    if (active === videoA) onTimeUpdate();
  });
  videoB.addEventListener("timeupdate", () => {
    if (active === videoB) onTimeUpdate();
  });
  videoA.addEventListener("play", () => {
    if (active === videoA) setPlayingUi(true);
  });
  videoB.addEventListener("play", () => {
    if (active === videoB) setPlayingUi(true);
  });
  videoA.addEventListener("pause", () => {
    if (active === videoA && !active.ended) setPlayingUi(false);
  });
  videoB.addEventListener("pause", () => {
    if (active === videoB && !active.ended) setPlayingUi(false);
  });

  playBtn.addEventListener("click", () => {
    if (!queue.length || active.ended || index >= queue.length) {
      const filtered = getFilteredVideos();
      if (!filtered.length) {
        showOverlay("No videos in selection");
        return;
      }
      playVideos(filtered);
      return;
    }
    if (active.paused) {
      void safePlay(active).then((result) => {
        if (result === "ok") {
          setPlayingUi(true);
          showOverlay(null);
        } else if (result === "blocked") {
          showOverlay("Tap play to start");
          setPlayingUi(false);
        }
      });
    } else {
      active.pause();
      setPlayingUi(false);
    }
  });

  function isFullscreen(): boolean {
    const fs =
      document.fullscreenElement ||
      (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement;
    return fs === playerEl || fs === active;
  }

  function syncFullscreenUi() {
    const on = isFullscreen();
    fullscreenBtn.textContent = on ? "Exit full" : "Fullscreen";
    playerEl.classList.toggle("player--fullscreen", on);
  }

  async function toggleFullscreen() {
    try {
      if (isFullscreen()) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
          await doc.webkitExitFullscreen?.();
        }
        return;
      }

      if (playerEl.requestFullscreen) {
        await playerEl.requestFullscreen();
        return;
      }

      // iOS Safari: fullscreen the active <video>
      const iosVideo = active as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
      };
      if (typeof iosVideo.webkitEnterFullscreen === "function") {
        iosVideo.webkitEnterFullscreen();
        return;
      }

      const el = playerEl as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      await el.webkitRequestFullscreen?.();
    } catch {
      showOverlay("Fullscreen not available");
    }
  }

  fullscreenBtn.addEventListener("click", () => {
    void toggleFullscreen();
  });

  stageEl.addEventListener("dblclick", () => {
    void toggleFullscreen();
  });

  document.addEventListener("fullscreenchange", syncFullscreenUi);
  document.addEventListener("webkitfullscreenchange", syncFullscreenUi as EventListener);
  syncFullscreenUi();

  function playVideos(videos: VideoEntry[]) {
    playGen += 1;
    queue = videos;
    index = 0;
    standbyIndex = null;
    active.pause();
    standby.pause();
    if (!queue.length) {
      setMeta(undefined);
      showOverlay("No videos in selection");
      setPlayingUi(false);
      return;
    }
    void playIndex(0);
  }

  root.addEventListener("mel40:play-one", ((ev: CustomEvent<VideoEntry>) => {
    playVideos([ev.detail]);
  }) as EventListener);

  window.addEventListener(QUALITY_CHANGE_EVENT, () => {
    if (!queue.length) return;
    const t = active.currentTime || 0;
    const wasPaused = active.paused;
    standbyIndex = null;
    standby.removeAttribute("src");
    void playIndex(index, { resumeAt: t }).then(() => {
      if (wasPaused) {
        active.pause();
        setPlayingUi(false);
      }
    });
  });

  return { playVideos };
}

export function playOne(root: HTMLElement, video: VideoEntry) {
  root.dispatchEvent(new CustomEvent("mel40:play-one", { detail: video }));
}
