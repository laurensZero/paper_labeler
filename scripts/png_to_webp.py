"""Batch-convert existing page PNGs to WebP and remove the originals.

Usage: python scripts/png_to_webp.py [--dry-run] [--quality 85]

Default: converts all page_*.png under data/pages/ to WebP (quality=85),
then deletes the original PNGs.  Pass --dry-run to preview without changes.
"""

import argparse
import sys
from pathlib import Path
from PIL import Image

# Resolve project root (one level up from scripts/)
ROOT = Path(__file__).resolve().parents[1]
PAGE_DIR = ROOT / "data" / "pages"


def convert(dry_run: bool = False, quality: int = 85) -> None:
    if not PAGE_DIR.exists():
        print(f"pages dir not found: {PAGE_DIR}")
        sys.exit(1)

    pngs = sorted(PAGE_DIR.rglob("page_*.png"))
    if not pngs:
        print("No page_*.png files found.")
        return

    total_before = 0
    total_after = 0
    converted = 0
    errors = 0

    for png_path in pngs:
        webp_path = png_path.with_suffix(".webp")
        if webp_path.exists():
            print(f"  SKIP (webp exists): {png_path.relative_to(ROOT)}")
            continue

        png_size = png_path.stat().st_size
        total_before += png_size

        if dry_run:
            # Estimate: WebP is roughly 50-60% of PNG for document scans
            est = int(png_size * 0.55)
            total_after += est
            print(f"  WOULD CONVERT: {png_path.relative_to(ROOT)}  {png_size // 1024}KB -> ~{est // 1024}KB")
            converted += 1
            continue

        try:
            with Image.open(png_path) as img:
                img.save(str(webp_path), "WEBP", quality=quality)
            webp_size = webp_path.stat().st_size
            total_after += webp_size
            # Remove original PNG
            png_path.unlink()
            saved_pct = 100 - (webp_size * 100 // png_size) if png_size else 0
            print(
                f"  OK: {png_path.relative_to(ROOT)}  "
                f"{png_size // 1024}KB -> {webp_size // 1024}KB  (-{saved_pct}%)"
            )
            converted += 1
        except Exception as e:
            print(f"  ERROR: {png_path.relative_to(ROOT)}: {e}")
            errors += 1

    print()
    print(f"{'[DRY RUN] ' if dry_run else ''}Done.")
    print(f"  Converted: {converted} files")
    if errors:
        print(f"  Errors: {errors}")
    print(f"  Total before: {total_before / 1024 / 1024:.1f} MB")
    print(f"  Total after:  {total_after / 1024 / 1024:.1f} MB")
    if total_before:
        saved = 100 - (total_after * 100 // total_before)
        print(f"  Space saved:  ~{saved}%")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert page PNGs to WebP")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no changes")
    parser.add_argument("--quality", type=int, default=85, help="WebP quality (1-100, default 85)")
    args = parser.parse_args()
    convert(dry_run=args.dry_run, quality=args.quality)
