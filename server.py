#!/usr/bin/env python3
"""Tiny GTFS-Realtime bridge. No sample buses are ever presented as live."""
import json
import math
import mimetypes
import os
from pathlib import Path
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
TRIP_ROUTES = json.loads((ROOT / "data" / "trip_routes.json").read_text(encoding="utf-8"))
OFFICIAL_ROUTE_ALIASES = json.loads((ROOT / "data" / "official_route_aliases.json").read_text(encoding="utf-8"))
VEHICLE_MODELS = {"by_plate": {}, "by_id": {}, "by_label": {}}
for catalog_path in (ROOT / "data" / "vehicle_models.json", ROOT / "data" / "vehicle_models.local.json"):
    if catalog_path.is_file():
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        for key in VEHICLE_MODELS:
            VEHICLE_MODELS[key].update(catalog.get(key, {}))
OFFICIAL_FEED_URL = "https://sipbg.gov.bg/bgnap/portal/api/catalog/subsets/2903167d-48d9-497e-b8ce-18efb07946bf/realtime-download"
FEED_URL = os.getenv("GTFS_RT_URL", "").strip() or OFFICIAL_FEED_URL
FEED_SOURCE = os.getenv("GTFS_RT_SOURCE", "official").strip().lower()
FEED_HEADER = os.getenv("GTFS_RT_HEADER", "").strip()
FEED_TOKEN = os.getenv("GTFS_RT_TOKEN", "").strip()
PORT = int(os.getenv("TRANSIT_PORT", "8765"))
GPS_CACHE_SECONDS = 8
_lock = threading.Lock()
_cache_until = 0
_cached = None


def fields(buf):
    """Read common protobuf wire fields; tolerate unknown extensions."""
    pos = 0
    while pos < len(buf):
        tag, pos = varint(buf, pos)
        if not tag:
            raise ValueError("invalid protobuf tag")
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = varint(buf, pos)
        elif wire == 1:
            value = buf[pos:pos + 8]
            pos += 8
        elif wire == 2:
            length, pos = varint(buf, pos)
            if length > 8_000_000:
                raise ValueError("oversized protobuf field")
            value = buf[pos:pos + length]
            pos += length
        elif wire == 5:
            value = buf[pos:pos + 4]
            pos += 4
        else:
            raise ValueError("unsupported protobuf wire type")
        if pos > len(buf):
            raise ValueError("truncated protobuf")
        yield number, wire, value


def varint(buf, pos):
    result = 0
    for shift in range(0, 70, 7):
        if pos >= len(buf):
            raise ValueError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 127) << shift
        if byte < 128:
            return result, pos
    raise ValueError("invalid varint")


def utf8(value):
    return value.decode("utf-8", errors="replace")


def normalize_plate(value):
    # Bulgarian plates may use Cyrillic or visually identical Latin letters.
    latin = str(value or "").upper().translate(str.maketrans("АВЕКМНОРСТУХ", "ABEKMHOPCTYX"))
    return "".join(character for character in latin if character.isalnum())


def vehicle_model(vehicle):
    return (VEHICLE_MODELS["by_id"].get(str(vehicle.get("id", ""))) or
            VEHICLE_MODELS["by_plate"].get(normalize_plate(vehicle.get("license_plate"))) or
            VEHICLE_MODELS["by_label"].get(str(vehicle.get("label", ""))) or {})


def parse_protobuf(data):
    header_time = 0
    entities = []
    for number, wire, value in fields(data):
        if number == 1 and wire == 2:
            for n, w, v in fields(value):
                if n == 3 and w == 0:
                    header_time = int(v)
        elif number == 2 and wire == 2:
            entity_id = ""
            vehicle_message = None
            for n, w, v in fields(value):
                if n == 1 and w == 2:
                    entity_id = utf8(v)
                elif n == 4 and w == 2:
                    vehicle_message = v
            if vehicle_message is not None:
                entities.append(parse_vehicle(vehicle_message, entity_id, header_time))
    return entities


def parse_vehicle(data, entity_id, header_time):
    result = {"id": entity_id, "route": "", "trip": "", "lat": None, "lon": None, "bearing": None, "speed": None, "time": header_time}
    for number, wire, value in fields(data):
        if number == 1 and wire == 2:
            for n, w, v in fields(value):
                if n == 1 and w == 2:
                    result["trip"] = utf8(v)
                elif n == 5 and w == 2:
                    result["route"] = utf8(v)
        elif number == 2 and wire == 2:
            for n, w, v in fields(value):
                if w == 5 and n in (1, 2, 3, 5):
                    result[{1: "lat", 2: "lon", 3: "bearing", 5: "speed"}[n]] = round(struct.unpack("<f", v)[0], 6)
        elif number == 5 and wire == 0:
            result["time"] = int(value)
        elif number == 8 and wire == 2:
            for n, w, v in fields(value):
                if n == 1 and w == 2:
                    result["id"] = utf8(v)
                elif n == 2 and w == 2:
                    result["label"] = utf8(v)
                elif n == 3 and w == 2:
                    result["license_plate"] = utf8(v)
    return result


def parse_json_feed(data):
    document = json.loads(data)
    result = []
    header_time = int(document.get("header", {}).get("timestamp", 0))
    for item in document.get("entity", []):
        vehicle = item.get("vehicle", {})
        trip = vehicle.get("trip", {})
        position = vehicle.get("position", {})
        descriptor = vehicle.get("vehicle", {})
        if not position:
            continue
        result.append({
            "id": str(descriptor.get("id") or item.get("id") or ""),
            "label": str(descriptor.get("label") or ""),
            "license_plate": str(descriptor.get("licensePlate") or descriptor.get("license_plate") or ""),
            "route": str(trip.get("routeId") or trip.get("route_id") or ""),
            "trip": str(trip.get("tripId") or trip.get("trip_id") or ""),
            "lat": position.get("latitude"), "lon": position.get("longitude"),
            "bearing": position.get("bearing"), "speed": position.get("speed"),
            "time": int(vehicle.get("timestamp") or header_time),
        })
    return result


def fetch_vehicles():
    if not FEED_URL:
        return {"status": "unconfigured", "message": "Потокът за GPS позиции още не е свързан.", "vehicles": [], "updated": None}
    if urlparse(FEED_URL).scheme not in ("https", "http"):
        return {"status": "error", "message": "Невалиден адрес на потока.", "vehicles": [], "updated": None}
    headers = {"User-Agent": "StaraZagoraTransitMap/1.0", "Accept": "application/x-protobuf,application/json,*/*"}
    if FEED_HEADER and FEED_TOKEN:
        headers[FEED_HEADER] = FEED_TOKEN
    try:
        with urlopen(Request(FEED_URL, headers=headers), timeout=15) as reply:
            body = reply.read(8_000_001)
        if len(body) > 8_000_000:
            raise ValueError("oversized feed")
        vehicles = parse_json_feed(body) if body.lstrip().startswith(b"{") else parse_protobuf(body)
    except (OSError, URLError, HTTPError, ValueError, TypeError, KeyError, struct.error):
        return {"status": "error", "message": "GPS потокът не отговаря. Опитай по-късно.", "vehicles": [], "updated": None}
    now = int(time.time())
    fresh = []
    for vehicle in vehicles:
        try:
            lat, lon, stamp = float(vehicle["lat"]), float(vehicle["lon"]), int(vehicle["time"])
            if not (math.isfinite(lat) and math.isfinite(lon) and 41 <= lat <= 44 and 24 <= lon <= 27 and abs(now - stamp) <= 180):
                continue
            rid = vehicle["route"] or TRIP_ROUTES.get(vehicle["trip"], "")
            if FEED_SOURCE == "official":
                rid = OFFICIAL_ROUTE_ALIASES.get(rid, rid)
            bearing, speed = vehicle.get("bearing"), vehicle.get("speed")
            bearing = float(bearing) if bearing is not None else None
            speed = float(speed) if speed is not None else None
            bearing = bearing if bearing is not None and math.isfinite(bearing) and 0 <= bearing <= 360 else None
            # GTFS-RT speed is metres/second. Publish km/h only when provided.
            speed = round(speed * 3.6, 1) if speed is not None and math.isfinite(speed) and 0 <= speed <= 70 else None
            model = vehicle_model(vehicle)
            fresh.append({"id": str(vehicle["id"]), "label": vehicle.get("label", ""), "route": rid,
                          "license_plate": vehicle.get("license_plate", ""),
                          "model": model.get("model", ""), "vehicle_type": model.get("type", ""),
                          "model_source": model.get("source", ""), "model_source_note": model.get("note", ""),
                          "lat": lat, "lon": lon, "bearing": bearing, "speed": speed, "time": stamp})
        except (ValueError, TypeError, KeyError, OverflowError):
            continue
    if not fresh:
        return {"status": "empty", "message": "Няма актуални GPS позиции в потока.", "vehicles": [], "updated": now}
    return {"status": "live", "message": "GPS позиции на живо", "vehicles": fresh, "updated": now}


def cached_vehicles():
    global _cache_until, _cached
    with _lock:
        if time.monotonic() >= _cache_until:
            _cached = fetch_vehicles()
            _cache_until = time.monotonic() + GPS_CACHE_SECONDS
        return _cached


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/transport"):
            self.send_response(302)
            self.send_header("Location", "/transport/")
            self.end_headers()
            return
        if path in ("/api/vehicles", "/transport/api/vehicles"):
            self.respond(json.dumps(cached_vehicles(), ensure_ascii=False).encode(), "application/json; charset=utf-8", "no-store")
            return
        if path in ("/api/health", "/transport/api/health"):
            self.respond(b'{"ok":true}', "application/json; charset=utf-8", "no-store")
            return
        # Local preview; in production Apache serves the same files directly.
        if path == "/transport/":
            filename = "index.html"
        elif path.startswith("/transport/"):
            filename = path[len("/transport/"):]
        else:
            self.send_error(404)
            return
        allowed = {"index.html", "styles.css", "app.js", "transit-core.js", "icon.svg", "network.json",
                   "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js"}
        allowed.update("vendor/leaflet/images/" + image for image in
                       ("layers.png", "layers-2x.png", "marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"))
        if filename not in allowed:
            self.send_error(404)
            return
        target = STATIC / filename
        if not target.is_file():
            self.send_error(404)
            return
        kind = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.respond(target.read_bytes(), kind + ("; charset=utf-8" if kind.startswith("text/") or kind == "application/json" else ""), "public, max-age=300")

    def respond(self, data, kind, cache):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
