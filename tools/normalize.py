#!/usr/bin/env python3
"""Normalize (and optionally trim/stitch) videos in videos/incoming/ via ffmpeg.

Profiles:
  web    — ~720p, 2.5 Mbps (default output: videos/normalized)
  mobile — ~480p, 200 kbps, ~10× smaller (default: videos/normalized_mobile)
  all    — run both
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MEDIA_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m4a"}
FFMPEG_TAIL = ["-movflags", "+faststart"]


@dataclass(frozen=True)
class EncodeProfile:
    name: str
    default_out: str
    vf: str
    fps: str
    video_bitrate: str
    audio_bitrate: str
    audio_channels: str
    x264_preset: str = "medium"


PROFILES: dict[str, EncodeProfile] = {
    "web": EncodeProfile(
        name="web",
        default_out="videos/normalized",
        vf="scale='min(1280,iw)':-2",
        fps="30",
        video_bitrate="2500k",
        audio_bitrate="128k",
        audio_channels="2",
    ),
    "mobile": EncodeProfile(
        name="mobile",
        default_out="videos/normalized_mobile",
        # ~10× smaller than web: 480p @ 200 kbps, 20 fps, mono 48k AAC
        vf="scale='min(480,iw)':-2",
        fps="20",
        video_bitrate="200k",
        audio_bitrate="48k",
        audio_channels="1",
        x264_preset="slow",
    ),
}


class NormalizeError(Exception):
    pass


def which_or_die(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise NormalizeError(f"Required executable not found on PATH: {name}")
    return path


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def slugify(name: str) -> str:
    stem = Path(name).stem
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", stem).strip("-").lower()
    return slug or "video"


def ffprobe_duration(ffprobe: str, path: Path) -> float:
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    try:
        return float(result.stdout.strip())
    except ValueError as exc:
        raise NormalizeError(f"Could not read duration for {path}: {result.stdout!r}") from exc


def resolve_end_sec(duration: float, end_sec: float | None) -> float | None:
    if end_sec is None:
        return None
    if end_sec < 0:
        return max(0.0, duration + end_sec)
    return end_sec


def list_media(incoming: Path) -> list[Path]:
    return [
        p
        for p in sorted(incoming.iterdir())
        if p.is_file() and p.suffix.lower() in MEDIA_EXTS
    ]


def encode_args(profile: EncodeProfile) -> list[str]:
    return [
        "-c:v",
        "libx264",
        "-preset",
        profile.x264_preset,
        "-pix_fmt",
        "yuv420p",
        "-vf",
        profile.vf,
        "-r",
        profile.fps,
        "-b:v",
        profile.video_bitrate,
        "-c:a",
        "aac",
        "-b:a",
        profile.audio_bitrate,
        "-ac",
        profile.audio_channels,
        *FFMPEG_TAIL,
    ]


@dataclass
class Job:
    id: str
    input: str | None = None
    ops: list[dict[str, Any]] = field(default_factory=list)
    normalize: bool = True

    @property
    def source_files(self) -> list[str]:
        names: list[str] = []
        if self.input:
            names.append(self.input)
        for op in self.ops:
            if op.get("op") == "stitch":
                for item in op.get("inputs", []):
                    names.append(item["file"])
        return names


def load_jobs(jobs_path: Path | None, incoming: Path) -> tuple[list[Job], set[str]]:
    claimed: set[str] = set()
    jobs: list[Job] = []

    data: dict[str, Any] = {}
    if jobs_path and jobs_path.is_file():
        data = json.loads(jobs_path.read_text(encoding="utf-8"))

    defaults = data.get("defaults") or {}
    default_normalize = bool(defaults.get("normalize", True))

    for raw in data.get("jobs") or []:
        job = Job(
            id=raw["id"],
            input=raw.get("input"),
            ops=list(raw.get("ops") or []),
            normalize=bool(raw.get("normalize", default_normalize)),
        )
        if job.input:
            claimed.add(Path(job.input).name)
        for op in job.ops:
            if op.get("op") == "stitch":
                for item in op.get("inputs", []):
                    claimed.add(Path(item["file"]).name)
        jobs.append(job)

    for media in list_media(incoming):
        if media.name in claimed:
            continue
        jobs.append(Job(id=slugify(media.name), input=media.name, ops=[], normalize=True))

    return jobs, claimed


def encode_normalize(ffmpeg: str, src: Path, dest: Path, profile: EncodeProfile) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-i", str(src), *encode_args(profile), str(dest)]
    result = run(cmd, check=False)
    if result.returncode != 0:
        raise NormalizeError(result.stderr or result.stdout or "ffmpeg failed")


def encode_trim_normalize(
    ffmpeg: str,
    ffprobe: str,
    src: Path,
    dest: Path,
    start_sec: float | None,
    end_sec: float | None,
    profile: EncodeProfile,
) -> None:
    duration = ffprobe_duration(ffprobe, src)
    start = 0.0 if start_sec is None else float(start_sec)
    end = resolve_end_sec(duration, None if end_sec is None else float(end_sec))
    if end is not None and end <= start:
        raise NormalizeError(f"Invalid trim on {src.name}: start={start} end={end}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-ss", str(start)]
    if end is not None:
        cmd += ["-to", str(end)]
    cmd += ["-i", str(src), *encode_args(profile), str(dest)]
    result = run(cmd, check=False)
    if result.returncode != 0:
        raise NormalizeError(result.stderr or result.stdout or "ffmpeg trim failed")


def job_fingerprint(job: Job, profile: EncodeProfile) -> str:
    """Hash of job definition + encode profile — used for idempotent skip."""
    payload = {
        "id": job.id,
        "input": job.input,
        "ops": job.ops,
        "normalize": job.normalize,
        "profile": {
            "name": profile.name,
            "vf": profile.vf,
            "fps": profile.fps,
            "video_bitrate": profile.video_bitrate,
            "audio_bitrate": profile.audio_bitrate,
            "audio_channels": profile.audio_channels,
            "x264_preset": profile.x264_preset,
        },
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


def fingerprint_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + ".fp")


def write_fingerprint(output: Path, fp: str) -> None:
    fingerprint_path(output).write_text(fp + "\n", encoding="utf-8")


def read_fingerprint(output: Path) -> str | None:
    path = fingerprint_path(output)
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").strip() or None


def needs_rebuild(
    *,
    output: Path,
    inputs: list[Path],
    job: Job,
    profile: EncodeProfile,
    force: bool,
) -> bool:
    """Rebuild if missing, forced, inputs newer, or job/profile fingerprint changed.

    Existing outputs without a .fp file are treated as up to date and get a
    fingerprint written (migration), so a jobs.json touch does not re-encode all.
    """
    if force:
        return True
    if not output.is_file():
        return True
    out_mtime = output.stat().st_mtime
    for path in inputs:
        if path.is_file() and path.stat().st_mtime > out_mtime:
            return True
    expected = job_fingerprint(job, profile)
    existing = read_fingerprint(output)
    if existing is None:
        write_fingerprint(output, expected)
        return False
    return existing != expected


def resolve_incoming_file(incoming: Path, name: str) -> Path:
    path = incoming / name
    if not path.is_file():
        matches = [p for p in list_media(incoming) if p.name == name or p.stem == Path(name).stem]
        if len(matches) == 1:
            return matches[0]
        raise NormalizeError(f"Missing input file: {name}")
    return path


def collect_sources(job: Job, incoming: Path) -> list[Path]:
    sources: list[Path] = []
    if job.input:
        sources.append(resolve_incoming_file(incoming, job.input))
    for op in job.ops:
        if op.get("op") == "stitch":
            for item in op["inputs"]:
                sources.append(resolve_incoming_file(incoming, item["file"]))
        elif op.get("op") == "trim":
            if not job.input:
                raise NormalizeError(f"Job {job.id}: trim requires input")
            sources.append(resolve_incoming_file(incoming, job.input))
    if not sources and job.input:
        sources.append(resolve_incoming_file(incoming, job.input))
    return sources


def run_job_from_source(
    job: Job,
    *,
    src: Path,
    out_dir: Path,
    ffmpeg: str,
    ffprobe: str,
    profile: EncodeProfile,
    force: bool,
    extra_inputs: list[Path] | None = None,
) -> dict[str, Any]:
    """Re-encode a single already-prepared source (e.g. web output → mobile)."""
    output = out_dir / f"{job.id}.mp4"
    inputs = [src, *(extra_inputs or [])]
    fp = job_fingerprint(job, profile)
    if not needs_rebuild(output=output, inputs=inputs, job=job, profile=profile, force=force):
        print(f"skip {job.id} [{profile.name}] (up to date)")
        duration = ffprobe_duration(ffprobe, output) if output.is_file() else None
        return {
            "id": job.id,
            "profile": profile.name,
            "output": str(output),
            "sources": [src.name],
            "ops": job.ops,
            "durationSec": duration,
            "fingerprint": fp,
            "skipped": True,
        }

    encode_normalize(ffmpeg, src, output, profile)
    write_fingerprint(output, fp)
    duration = ffprobe_duration(ffprobe, output)
    size = output.stat().st_size
    print(f"ok {job.id} [{profile.name}] -> {output} ({duration:.1f}s, {size // 1024} KiB)")
    return {
        "id": job.id,
        "profile": profile.name,
        "output": str(output),
        "sources": [src.name],
        "ops": job.ops,
        "durationSec": round(duration, 3),
        "sizeBytes": size,
        "fingerprint": fp,
        "skipped": False,
    }


def run_job(
    job: Job,
    *,
    incoming: Path,
    out_dir: Path,
    ffmpeg: str,
    ffprobe: str,
    force: bool,
    profile: EncodeProfile,
) -> dict[str, Any]:
    output = out_dir / f"{job.id}.mp4"
    sources = collect_sources(job, incoming)
    fp = job_fingerprint(job, profile)

    if not needs_rebuild(output=output, inputs=sources, job=job, profile=profile, force=force):
        print(f"skip {job.id} [{profile.name}] (up to date)")
        duration = ffprobe_duration(ffprobe, output) if output.is_file() else None
        return {
            "id": job.id,
            "profile": profile.name,
            "output": str(output),
            "sources": [s.name for s in sources],
            "ops": job.ops,
            "durationSec": duration,
            "fingerprint": fp,
            "skipped": True,
        }

    with tempfile.TemporaryDirectory(prefix=f"mel40-{job.id}-") as tmp:
        tmp_path = Path(tmp)

        if not job.ops:
            if not job.input:
                raise NormalizeError(f"Job {job.id}: needs input or ops")
            src = resolve_incoming_file(incoming, job.input)
            if job.normalize:
                encode_normalize(ffmpeg, src, output, profile)
            else:
                shutil.copy2(src, output)
        else:
            current: Path | None = resolve_incoming_file(incoming, job.input) if job.input else None

            for i, op in enumerate(job.ops):
                kind = op.get("op")
                if kind == "trim":
                    if current is None:
                        raise NormalizeError(f"Job {job.id}: trim with no input")
                    next_path = tmp_path / f"step-{i}.mp4"
                    encode_trim_normalize(
                        ffmpeg,
                        ffprobe,
                        current,
                        next_path,
                        op.get("startSec"),
                        op.get("endSec"),
                        profile,
                    )
                    current = next_path
                elif kind == "stitch":
                    segments: list[Path] = []
                    for j, item in enumerate(op["inputs"]):
                        src = resolve_incoming_file(incoming, item["file"])
                        trim = item.get("trim") or {}
                        seg = tmp_path / f"stitch-{i}-{j}.mp4"
                        if trim:
                            encode_trim_normalize(
                                ffmpeg,
                                ffprobe,
                                src,
                                seg,
                                trim.get("startSec"),
                                trim.get("endSec"),
                                profile,
                            )
                        else:
                            encode_normalize(ffmpeg, src, seg, profile)
                        segments.append(seg)

                    list_file = tmp_path / f"concat-{i}.txt"
                    list_file.write_text(
                        "".join(f"file '{seg.resolve()}'\n" for seg in segments),
                        encoding="utf-8",
                    )
                    stitched = tmp_path / f"stitched-{i}.mp4"
                    cmd = [
                        ffmpeg,
                        "-y",
                        "-f",
                        "concat",
                        "-safe",
                        "0",
                        "-i",
                        str(list_file),
                        "-c",
                        "copy",
                        *FFMPEG_TAIL,
                        str(stitched),
                    ]
                    result = run(cmd, check=False)
                    if result.returncode != 0:
                        cmd = [
                            ffmpeg,
                            "-y",
                            "-f",
                            "concat",
                            "-safe",
                            "0",
                            "-i",
                            str(list_file),
                            *encode_args(profile),
                            str(stitched),
                        ]
                        result = run(cmd, check=False)
                        if result.returncode != 0:
                            raise NormalizeError(result.stderr or "stitch failed")
                    current = stitched
                else:
                    raise NormalizeError(f"Job {job.id}: unknown op {kind!r}")

            if current is None:
                raise NormalizeError(f"Job {job.id}: produced no output")

            if job.normalize and current != output:
                if current.suffix == ".mp4":
                    shutil.copy2(current, output)
                else:
                    encode_normalize(ffmpeg, current, output, profile)
            else:
                shutil.copy2(current, output)

        duration = ffprobe_duration(ffprobe, output)
        size = output.stat().st_size
        write_fingerprint(output, fp)
        print(f"ok {job.id} [{profile.name}] -> {output} ({duration:.1f}s, {size // 1024} KiB)")
        return {
            "id": job.id,
            "profile": profile.name,
            "output": str(output),
            "sources": [s.name for s in sources],
            "ops": job.ops,
            "durationSec": round(duration, 3),
            "sizeBytes": size,
            "fingerprint": fp,
            "skipped": False,
        }


def run_profile(
    *,
    profile: EncodeProfile,
    jobs: list[Job],
    incoming: Path,
    out_dir: Path,
    web_dir: Path,
    ffmpeg: str,
    ffprobe: str,
    force: bool,
    from_web: bool,
) -> list[dict[str, Any]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []

    for job in jobs:
        web_src = web_dir / f"{job.id}.mp4"
        if from_web and profile.name == "mobile" and web_src.is_file():
            entry = run_job_from_source(
                job,
                src=web_src,
                out_dir=out_dir,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                profile=profile,
                force=force,
            )
        else:
            entry = run_job(
                job,
                incoming=incoming,
                out_dir=out_dir,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                force=force,
                profile=profile,
            )
        entries.append(entry)

    manifest_path = out_dir / "manifest.json"
    by_id: dict[str, dict[str, Any]] = {}
    if manifest_path.is_file():
        try:
            for prev in json.loads(manifest_path.read_text(encoding="utf-8")):
                if isinstance(prev, dict) and prev.get("id"):
                    by_id[prev["id"]] = prev
        except json.JSONDecodeError:
            pass
    for entry in entries:
        by_id[entry["id"]] = entry
    merged = list(by_id.values())
    merged.sort(key=lambda e: str(e.get("id", "")))
    manifest_path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_path} ({len(merged)} entries)")
    return entries


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("--incoming", type=Path, default=root / "videos" / "incoming")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output dir (default depends on --profile)",
    )
    parser.add_argument("--jobs", type=Path, default=None, help="Path to jobs.json")
    parser.add_argument(
        "--profile",
        choices=("web", "mobile", "all"),
        default="web",
        help="Encode profile (mobile ≈10× smaller). Default: web",
    )
    parser.add_argument(
        "--from-web",
        action="store_true",
        default=True,
        help="For mobile: re-encode from videos/normalized when present (default: on)",
    )
    parser.add_argument(
        "--no-from-web",
        action="store_true",
        help="For mobile: always encode from incoming (ignore web outputs)",
    )
    parser.add_argument("--force", action="store_true", help="Rebuild even if up to date")
    parser.add_argument(
        "--only",
        type=str,
        default=None,
        help="Comma-separated job ids to process (others skipped entirely)",
    )
    args = parser.parse_args(argv)

    try:
        ffmpeg = which_or_die("ffmpeg")
        ffprobe = which_or_die("ffprobe")
    except NormalizeError as exc:
        print(exc, file=sys.stderr)
        return 1

    incoming: Path = args.incoming
    jobs_file = args.jobs if args.jobs else incoming / "jobs.json"
    if not jobs_file.is_file():
        jobs_file = None

    if not incoming.is_dir():
        print(f"Incoming folder missing: {incoming}", file=sys.stderr)
        return 1

    from_web = args.from_web and not args.no_from_web
    web_dir = root / "videos" / "normalized"
    profile_names = ["web", "mobile"] if args.profile == "all" else [args.profile]

    try:
        jobs, _claimed = load_jobs(jobs_file, incoming)
        if args.only:
            only_ids = {x.strip() for x in args.only.split(",") if x.strip()}
            jobs = [j for j in jobs if j.id in only_ids]
            missing = only_ids - {j.id for j in jobs}
            if missing:
                print(f"warning: unknown --only ids: {', '.join(sorted(missing))}", file=sys.stderr)
        if not jobs:
            print("No media files or jobs found.")
            return 0

        for name in profile_names:
            profile = PROFILES[name]
            if args.out and args.profile != "all":
                out_dir = args.out
            else:
                out_dir = root / profile.default_out
            print(f"=== profile {profile.name} → {out_dir} ===")
            run_profile(
                profile=profile,
                jobs=jobs,
                incoming=incoming,
                out_dir=out_dir,
                web_dir=web_dir,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                force=args.force,
                from_web=from_web,
            )

        print("Next: upload outputs to Drive, then set driveFileId + tags in the site config JSON.")
        return 0
    except NormalizeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(exc.stderr or str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
