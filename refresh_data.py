#!/usr/bin/env python3
"""Fetch fresh CC-BY-4.0 GTFS data and rebuild the map snapshot."""
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen
from build_data import ROOT, convert

URL = "https://gtfs.livetransport.eu/gtfs/stara-zagora.zip"
PUBLIC = Path("/var/www/html/transport/network.json") if Path("/var/www/html/transport").is_dir() else ROOT / "static" / "network.json"


def main():
    request = Request(URL, headers={"User-Agent": "StaraZagoraTransitMap/1.0"})
    with urlopen(request, timeout=25) as remote:
        content = remote.read(12_000_001)
    if len(content) > 12_000_000:
        raise ValueError("GTFS archive too large")
    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / "feed.zip"
        source.write_bytes(content)
        convert(source, PUBLIC, ROOT / "data" / "trip_routes.json")


if __name__ == "__main__":
    main()
