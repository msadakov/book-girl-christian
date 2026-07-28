#!/usr/bin/env python3
"""Optimize book illustrations from originals/ into docs/illustrations/.

Usage:
  python3 scripts/optimize_images.py
"""

from __future__ import annotations

import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "originals" / "illustrations"
DST = ROOT / "docs" / "illustrations"

# Reading column ~540–700 CSS px; 2× retina ≈ 1200. 960 is a good mobile/desktop balance.
MAX_SIDE = 960
WEBP_QUALITY = 78
JPEG_QUALITY = 82
WORKERS = 4


def optimize_one(src: Path) -> tuple[str, int, int]:
    rel = src.name
    suffix = src.suffix.lower()

    # Social preview: keep JPEG for Telegram/Open Graph compatibility
    if src.stem == "og-preview":
        out = DST / "og-preview.jpg"
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        return out.name, src.stat().st_size, out.stat().st_size

    out = DST / f"{src.stem}.webp"
    with Image.open(src) as im:
        im = im.convert("RGB")
        w, h = im.size
        scale = min(1.0, MAX_SIDE / max(w, h))
        if scale < 1.0:
            im = im.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
        im.save(out, "WEBP", quality=WEBP_QUALITY, method=6)
    return out.name, src.stat().st_size, out.stat().st_size


def main() -> int:
    if not SRC.is_dir():
        print(f"Missing originals: {SRC}", file=sys.stderr)
        return 1

    DST.mkdir(parents=True, exist_ok=True)
    files = sorted(
        p
        for p in SRC.iterdir()
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} and p.is_file()
    )
    if not files:
        print("No images found in originals/illustrations")
        return 1

    total_in = total_out = 0
    done = 0
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(optimize_one, f): f for f in files}
        for fut in as_completed(futures):
            name, nin, nout = fut.result()
            total_in += nin
            total_out += nout
            done += 1
            if done % 20 == 0 or done == len(files):
                print(f"[{done}/{len(files)}] last={name}  {nin/1024:.0f}K → {nout/1024:.0f}K")

    print(
        f"Done: {done} files, {total_in/1024/1024:.1f} MiB → {total_out/1024/1024:.1f} MiB "
        f"({100 * total_out / total_in:.1f}% of original)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
