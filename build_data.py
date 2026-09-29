#!/usr/bin/env python3
"""Build compact, ordered GTFS data for the map, timetables and journey search."""
import csv
import io
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
OFFICIAL_FEED = ROOT / 'data' / 'gtfs-static_Trolleys-and-Busses-Stara-Zagora_20260928.zip'


def read_table(archive, name):
    if name not in archive.namelist():
        return []
    with archive.open(name) as source:
        return list(csv.DictReader(io.TextIOWrapper(source, encoding='utf-8-sig')))


def seconds(value):
    h, m, s = map(int, value.split(':'))
    if h < 0 or not 0 <= m < 60 or not 0 <= s < 60:
        raise ValueError('Invalid GTFS time')
    return h * 3600 + m * 60 + s


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as out:
        json.dump(value, out, ensure_ascii=False, separators=(',', ':'))
        temp = out.name
    os.chmod(temp, 0o644)
    os.replace(temp, path)


def write_realtime_route_aliases(routes, path):
    if not OFFICIAL_FEED.is_file():
        return
    with zipfile.ZipFile(OFFICIAL_FEED) as archive:
        official = read_table(archive, 'routes.txt')
    normalize = lambda value: value.strip().rstrip('.').strip()
    by_name = defaultdict(list)
    for route in routes.values():
        by_name[normalize(route['name'])].append(route['id'])
    aliases = {}
    for row in official:
        matches = by_name[normalize(row.get('route_short_name', ''))]
        if len(matches) == 1:
            aliases[row['route_id']] = matches[0]
    write_json(path, aliases)


def convert(source, public_path=None, lookup_path=None):
    public_path = public_path or ROOT / 'static' / 'network.json'
    lookup_path = lookup_path or ROOT / 'data' / 'trip_routes.json'
    with zipfile.ZipFile(source) as archive:
        required = {'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'}
        if not required.issubset(archive.namelist()):
            raise ValueError('GTFS archive is missing required tables')
        tables = {name: read_table(archive, name + '.txt') for name in
                  ('routes', 'stops', 'trips', 'stop_times', 'shapes', 'calendar', 'calendar_dates', 'feed_info', 'agency')}
    routes = {r['route_id']: {'id': r['route_id'], 'name': r.get('route_short_name') or r['route_id'],
              'long_name': r.get('route_long_name', ''), 'type': int(r.get('route_type') or 3),
              'patterns': [], 'stop_count': 0} for r in tables['routes']}
    stops = {s['stop_id']: {'id': s['stop_id'], 'name': s['stop_name'], 'code': s.get('stop_code', ''),
             'lat': float(s['stop_lat']), 'lon': float(s['stop_lon']), 'routes': [],
             'wheelchair': int(s.get('wheelchair_boarding') or 0)} for s in tables['stops']
             if s.get('stop_lat') and s.get('stop_lon') and s.get('location_type', '0') in ('', '0')}
    shapes = defaultdict(list)
    for s in tables['shapes']:
        shapes[s['shape_id']].append((int(s['shape_pt_sequence']),
                                    [round(float(s['shape_pt_lat']), 6), round(float(s['shape_pt_lon']), 6)]))
    shapes = {sid: [p for _, p in sorted(points)] for sid, points in shapes.items()}
    times = defaultdict(list)
    for row in tables['stop_times']:
        if row['stop_id'] not in stops:
            continue
        try:
            arrival = seconds(row.get('arrival_time') or row.get('departure_time', ''))
            departure = seconds(row.get('departure_time') or row.get('arrival_time', ''))
            pickup = int(row.get('pickup_type') or 0)
            dropoff = int(row.get('drop_off_type') or 0)
            times[row['trip_id']].append((int(row['stop_sequence']), [row['stop_id'], arrival, departure, pickup, dropoff]))
        except (ValueError, KeyError):
            continue
    patterns, pattern_keys, trips = {}, {}, []
    route_stops = defaultdict(set)
    for raw in tables['trips']:
        rid, tid = raw['route_id'], raw['trip_id']
        sequence = [point for _, point in sorted(times.get(tid, []))]
        if rid not in routes or len(sequence) < 2:
            continue
        if any(b[1] < a[2] for a, b in zip(sequence, sequence[1:])) or any(x[2] < x[1] for x in sequence):
            continue
        # Include the stop order and shape: same headsign may have short/long variants.
        key = (rid, raw.get('direction_id', ''), raw.get('trip_headsign', ''),
               raw.get('shape_id', ''), tuple(p[0] for p in sequence))
        if key not in pattern_keys:
            pid = 'p' + str(len(patterns))
            pattern_keys[key] = pid
            patterns[pid] = {'id': pid, 'route': rid, 'direction': raw.get('direction_id', ''),
                             'head': raw.get('trip_headsign') or stops[sequence[-1][0]]['name'],
                             'shape': raw.get('shape_id', ''), 'stops': [p[0] for p in sequence], 'trip_count': 0}
            routes[rid]['patterns'].append(pid)
        pid = pattern_keys[key]
        patterns[pid]['trip_count'] += 1
        trips.append({'id': tid, 'route': rid, 'service': raw['service_id'], 'pattern': pid, 'times': sequence})
        route_stops[rid].update(p[0] for p in sequence)
    for rid, route in routes.items():
        route['stop_count'] = len(route_stops[rid])
        route['patterns'].sort(key=lambda pid: (-patterns[pid]['trip_count'], patterns[pid]['head']))
    for rid, ids in route_stops.items():
        for sid in ids:
            stops[sid]['routes'].append(rid)
    calendar = {c['service_id']: {'start': c['start_date'], 'end': c['end_date'],
                'days': [c[d] == '1' for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]}
                for c in tables['calendar']}
    exceptions = defaultdict(dict)
    for item in tables['calendar_dates']:
        exceptions[item['date']][item['service_id']] = int(item['exception_type'])
    info = tables['feed_info'][0] if tables['feed_info'] else {}
    public = {'schema': 2, 'source': 'livetransport.eu / Transitous', 'timezone': 'Europe/Sofia',
              'feed_version': info.get('feed_version', ''), 'feed_start': info.get('feed_start_date', ''),
              'feed_end': info.get('feed_end_date', ''), 'built_at': datetime.now(timezone.utc).isoformat(),
              'calendar': calendar, 'exceptions': dict(exceptions), 'routes': list(routes.values()),
              'stops': list(stops.values()), 'patterns': patterns, 'shapes': shapes, 'trips': trips}
    if len(routes) < 5 or len(stops) < 50 or not trips:
        raise ValueError('GTFS archive has too few routes, stops or valid trips')
    write_json(public_path, public)
    write_json(lookup_path, {t['id']: t['route'] for t in trips})
    write_realtime_route_aliases(routes, lookup_path.with_name('official_route_aliases.json'))
    print(f'Loaded {len(routes)} routes, {len(stops)} stops, {len(patterns)} patterns, {len(trips)} trips')


if __name__ == '__main__':
    convert(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'data' / 'stara-zagora-20260928.zip')
