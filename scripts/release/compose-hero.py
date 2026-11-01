#!/usr/bin/env python3
"""Compose offline README artwork from the production native-light.png view.

Usage: python3 scripts/release/compose-hero.py INPUT_DIR OUTPUT_DIR
Only the named native image is read; no filesystem indexing or network is used.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def system_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Prefer macOS Arial, then installed system fonts, then Pillow's fallback."""
    filename = "Arial Bold.ttf" if bold else "Arial.ttf"
    dejavu = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    candidates = (
        Path("/System/Library/Fonts/Supplemental") / filename,
        Path("/System/Library/Fonts/Helvetica.ttc"),
        Path("/usr/share/fonts/truetype/dejavu") / dejavu,
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(str(candidate), size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def render_hero(native: Image.Image) -> Image.Image:
    """Keep the complete native view between separate headline and footer bands."""
    size = (1800, 1320)
    gradient = Image.linear_gradient("L").resize(size)
    canvas = Image.composite(
        Image.new("RGB", size, "#eaf3e9"),
        Image.new("RGB", size, "#faf6ed"),
        gradient,
    ).convert("RGBA")
    ink = "#173e32"
    secondary = "#486356"
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (96, 60), "FIND EVERYTHING · LOCAL FILE SEARCH",
        font=system_font(23, bold=True), fill=ink, anchor="lt",
    )
    draw.text(
        (92, 111), "Find the file. Keep your flow.",
        font=system_font(78, bold=True), fill=ink, anchor="lt",
    )
    draw.text(
        (96, 217), "Use precise filename filters to find files across folders.",
        font=system_font(29), fill=secondary, anchor="lt",
    )
    draw.rounded_rectangle(
        (96, 276, 529, 320), radius=10, fill="#e0eadd", outline="#ccdccc",
    )
    draw.text(
        (113, 285), "name:invoice ext:pdf !draft",
        font=system_font(27, bold=True), fill=ink, anchor="lt",
    )
    draw.text(
        (553, 285), "Filenames across folders · PDFs · excluding draft",
        font=system_font(25), fill=secondary, anchor="lt",
    )

    # Resize the entire source, never crop or recreate native application controls.
    scale = min(1480 / native.width, 884 / native.height)
    view_size = (max(1, round(native.width * scale)), max(1, round(native.height * scale)))
    view = native.convert("RGBA").resize(view_size, Image.Resampling.LANCZOS)
    x = (size[0] - view.width) // 2
    y = 344 + (884 - view.height) // 2
    shadow = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x, y + 15, x + view.width - 1, y + view.height + 14),
        radius=20, fill=(20, 52, 39, 48),
    )
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(22)))
    ImageDraw.Draw(canvas).rectangle(
        (x - 1, y - 1, x + view.width, y + view.height), outline="#c8d8cc", width=1,
    )
    canvas.alpha_composite(view, (x, y))
    ImageDraw.Draw(canvas).text(
        (160, 1273), "Production views · synthetic demo paths · not a benchmark",
        font=system_font(23), fill=secondary, anchor="lt",
    )
    return canvas.convert("RGB")


def feature_map_svg() -> str:
    """Accessible, self-contained query examples; these are not native screenshots."""
    features = (
        ("filenames", "Filenames, not just folders", "name:invoice ext:pdf !draft", "Filename filters"),
        ("properties", "Narrow it down", "size:>10m dm:7d sort:big", "Cached properties required"),
        ("phrases", "Ask with supported phrases", "(PDFs größer als 10 MB)", "Local rules · no model"),
        ("contents", "Find what a document says", 'content:"quarterly revenue"', "Explicit document-text index"),
        ("media", "Find the right media", "audio: duration:<1s channels:1", "Metadata setup required"),
        ("sound", "Describe a sound", "(kurze düstere Lasersounds)", "Optional model setup"),
        ("workflow", "Stay in your workflow", "CLI · local API · MCP · Raycast", "Raycast: source build"),
    )
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1274" viewBox="0 0 1800 1274"',
        ' role="img" aria-labelledby="feature-map-title feature-map-desc"',
        ' font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Arial, sans-serif">',
        '<title id="feature-map-title">One search line. Seven useful ways in.</title>',
        '<desc id="feature-map-desc">Seven query examples with their prerequisites: filename filters, cached properties, supported local rules, explicitly indexed document text, media metadata, optional sound models, and workflow integrations. Query examples are not screenshots; native views use synthetic demo paths.</desc>',
        '<rect width="1800" height="960" fill="#f5f6ed"/>',
        '<text x="80" y="76" font-size="21" font-weight="700" fill="#4b6657" letter-spacing="2">FIND EVERYTHING · QUERY EXAMPLES</text>',
        '<text x="77" y="146" font-size="52" font-weight="700" fill="#173e32">One search line. Seven useful ways in.</text>',
    ]
    for index, (key, title, query, prerequisite) in enumerate(features):
        x = 640 if index == 6 else 80 + (index % 3) * 560
        y = 210 + (index // 3) * 314
        lines.extend((
            f'<g data-feature="{key}" transform="translate({x} {y})">',
            '<rect width="520" height="280" rx="22" fill="#fdfdf8" stroke="#cfddd1"/>',
            f'<text x="30" y="43" font-size="19" font-weight="700" fill="#607765">0{index + 1}</text>',
            f'<text x="30" y="88" font-size="28" font-weight="700" fill="#173e32">{escape(title)}</text>',
            '<rect x="24" y="118" width="472" height="74" rx="12" fill="#e9f0e4"/>',
            '<text x="40" y="163" font-size="22" fill="#173e32" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">'
            f'{escape(query)}</text>',
            f'<text x="30" y="241" font-size="22" fill="#486356">{escape(prerequisite)}</text>',
            '</g>',
        ))
    lines.extend((
        '<path d="M80 1167H1720" stroke="#cbd9cd"/>',
        '<text x="80" y="1217" font-size="24" fill="#486356">Query examples, not screenshots; native views use synthetic demo paths.</text>',
        '</svg>',
    ))
    return "\n".join(lines) + "\n"


def compose(input_dir: Path, output_dir: Path) -> None:
    source = input_dir / "native-light.png"
    hero_path = output_dir / "hero.png"
    feature_path = output_dir / "feature-map.svg"
    # Refuse an output symlink that would overwrite the source image.
    if source.resolve() in (hero_path.resolve(), feature_path.resolve()):
        raise ValueError("An output path resolves to the native input image")
    with Image.open(source) as native:
        native.load()
        hero = render_hero(native)
    output_dir.mkdir(parents=True, exist_ok=True)
    hero.save(hero_path, format="PNG", optimize=True)
    feature_path.write_text(feature_map_svg(), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_dir", type=Path, help="Directory containing native-light.png")
    parser.add_argument("output_dir", type=Path, help="Directory for hero.png and feature-map.svg")
    args = parser.parse_args()
    try:
        compose(args.input_dir, args.output_dir)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot compose presentation artwork: {error}\n")


if __name__ == "__main__":
    main()
