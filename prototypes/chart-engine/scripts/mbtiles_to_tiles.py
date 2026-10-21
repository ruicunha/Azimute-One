#!/usr/bin/env python3
"""Convert an MBTiles SQLite database (or ZIP containing one) to static XYZ PNG tiles.

MBTiles stores tile_row in TMS order; this script flips it to XYZ order for
MapLibre's {z}/{x}/{y}.png URL template. Uses only the Python standard library.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path


def locate_mbtiles(source: Path, temp_dir: Path) -> Path:
    if source.is_file() and source.suffix.lower() in {".mbtiles", ".sqlite", ".sqlite3"}:
        return source
    if not source.is_file() or not zipfile.is_zipfile(source):
        raise SystemExit(f"Expected an .mbtiles file or ZIP archive: {source}")
    with zipfile.ZipFile(source) as archive:
        candidates = [n for n in archive.namelist() if n.lower().endswith((".mbtiles", ".sqlite", ".sqlite3"))]
        if not candidates:
            raise SystemExit("ZIP archive contains no .mbtiles/.sqlite database.")
        # Prefer the largest database if the archive contains more than one.
        candidate = max(candidates, key=lambda n: archive.getinfo(n).file_size)
        target = Path(temp_dir) / Path(candidate).name
        with archive.open(candidate) as src, target.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        return target


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: mbtiles_to_tiles.py INPUT.mbtiles-or.zip OUTPUT_DIR")
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="mbtiles-") as temp:
        database = locate_mbtiles(source, Path(temp))
        connection = sqlite3.connect(f"file:{database.resolve()}?mode=ro", uri=True)
        try:
            metadata_rows = connection.execute("SELECT name, value FROM metadata").fetchall()
            metadata = {name: value for name, value in metadata_rows}
            columns = {row[1] for row in connection.execute("PRAGMA table_info(tiles)")}
            if not {"zoom_level", "tile_column", "tile_row", "tile_data"}.issubset(columns):
                raise SystemExit("MBTiles database has an unsupported tiles table schema.")

            min_zoom = int(metadata.get("minzoom", connection.execute("SELECT MIN(zoom_level) FROM tiles").fetchone()[0]))
            max_zoom = int(metadata.get("maxzoom", connection.execute("SELECT MAX(zoom_level) FROM tiles").fetchone()[0]))
            bounds_text = metadata.get("bounds")
            if bounds_text:
                bounds = [float(value) for value in bounds_text.split(",")]
            else:
                # Calculate a conservative geographic extent from tile coordinates.
                import math
                min_x, max_x, min_y, max_y = connection.execute(
                    "SELECT MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) FROM tiles WHERE zoom_level = ?",
                    (max_zoom,),
                ).fetchone()
                n = 2 ** max_zoom
                def lon(x: int) -> float:
                    return x / n * 360.0 - 180.0
                def lat(y_xyz: int) -> float:
                    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y_xyz / n))))
                bounds = [lon(min_x), lat(n - min_y), lon(max_x + 1), lat(n - 1 - max_y)]

            # Keep the public tile directory clean when regenerating it.
            for item in output.iterdir():
                if item.is_dir():
                    shutil.rmtree(item)
                else:
                    item.unlink()

            count = 0
            cursor = connection.execute(
                "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles ORDER BY zoom_level, tile_column, tile_row"
            )
            for zoom, x, tms_y, data in cursor:
                xyz_y = (1 << zoom) - 1 - tms_y
                target = output / str(zoom) / str(x) / f"{xyz_y}.png"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                count += 1

            public_metadata = {
                "name": metadata.get("name", "MBTiles raster chart"),
                "format": metadata.get("format", "png"),
                "bounds": bounds,
                "minzoom": min_zoom,
                "maxzoom": max_zoom,
                "tileCount": count,
            }
            (output / "metadata.json").write_text(json.dumps(public_metadata, indent=2) + "\n", encoding="utf-8")
            print(f"Converted {count} tiles ({min_zoom}-{max_zoom}) to {output}; bounds={bounds}")
        finally:
            connection.close()


if __name__ == "__main__":
    main()
