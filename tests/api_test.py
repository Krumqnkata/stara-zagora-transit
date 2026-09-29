"""Backend tests run against localhost and synthetic feed bytes; no external requests."""
import io
import json
from pathlib import Path
import struct
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class VehicleModelTests(unittest.TestCase):
    def test_plate_normalization_and_exact_match(self):
        self.assertEqual(server.normalize_plate('СТ 7719 ВР'), 'CT7719BP')
        self.assertEqual(server.vehicle_model({'license_plate': 'СТ 7719 ВР'})['model'], 'Solaris Urbino 12')
        self.assertEqual(server.vehicle_model({'license_plate': 'CT7907BP'})['model'], 'SOR NB 18')
        self.assertEqual(server.vehicle_model({'license_plate': '1038'})['type'], 'trolley')
        # A line/label that happens to look similar must not invent a match.
        self.assertEqual(server.vehicle_model({'license_plate': 'EA2241AA', 'label': '105', 'route': '20'}), {})

    def test_protobuf_descriptor_preserves_plate(self):
        def string_field(tag, value):
            encoded = value.encode()
            return bytes([tag, len(encoded)]) + encoded
        descriptor = string_field(10, '82') + string_field(18, '105') + string_field(26, 'CT7907BP')
        vehicle = server.parse_vehicle(bytes([66, len(descriptor)]) + descriptor, 'entity', 1)
        self.assertEqual((vehicle['id'], vehicle['label'], vehicle['license_plate']), ('82', '105', 'CT7907BP'))

    def test_json_api_enriches_with_model_and_provenance(self):
        for plate_key in ['licensePlate', 'license_plate']:
            payload = {'entity': [{'id': 'entity', 'vehicle': {
                'timestamp': int(time.time()), 'position': {'latitude': 42.425, 'longitude': 25.633},
                'vehicle': {'id': '82', 'label': '105', plate_key: 'CT7907BP'}}}]}
            with patch.object(server, 'urlopen', return_value=io.BytesIO(json.dumps(payload).encode())):
                vehicle = server.fetch_vehicles()['vehicles'][0]
            self.assertEqual(vehicle['model'], 'SOR NB 18')
            self.assertEqual(vehicle['vehicle_type'], 'articulated_bus')
            self.assertIn('2016', vehicle['model_source_note'])
            self.assertTrue(vehicle['model_source'].startswith('https://www.szprevozi.com/'))


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join()

    def test_static_assets_and_redirect(self):
        for path, kind in [('transit-core.js', 'javascript'), ('icon.svg', 'image/svg+xml'),
                           ('vendor/leaflet/leaflet.css', 'text/css'), ('network.json', 'application/json')]:
            with urlopen(self.base + '/transport/' + path) as result:
                self.assertEqual(result.status, 200)
                self.assertIn(kind, result.headers['Content-Type'])
                self.assertGreater(len(result.read()), 0)
        with urlopen(self.base + '/transport') as result:
            self.assertTrue(result.url.endswith('/transport/'))

    def test_private_and_traversal_paths_not_served(self):
        for path in ['/transport/server.py', '/transport/vendor/leaflet/images/../../server.py',
                     '/transport/vendor/leaflet/images/../marker-icon.png']:
            with self.assertRaises(HTTPError) as error:
                urlopen(self.base + path)
            self.assertEqual(error.exception.code, 404)

    def test_protobuf_optional_speed_presence(self):
        # Position field 2 (length-delimited), containing fixed32 latitude, longitude, speed.
        position = b'\x0d' + struct.pack('<f', 42.42) + b'\x15' + struct.pack('<f', 25.63)
        without = server.parse_vehicle(b'\x12' + bytes([len(position)]) + position, 'bus', 1)
        self.assertIsNone(without['speed'])
        position += b'\x2d' + struct.pack('<f', 12.5)
        with_speed = server.parse_vehicle(b'\x12' + bytes([len(position)]) + position, 'bus', 1)
        self.assertEqual(with_speed['speed'], 12.5)

    def test_freshness_speed_conversion_and_missing_values(self):
        stamp = int(time.time())
        def entity(identifier, seconds, speed=None):
            pos = {'latitude': 42.425, 'longitude': 25.633}
            if speed is not None:
                pos['speed'] = speed
            return {'id': identifier, 'vehicle': {'position': pos, 'timestamp': seconds,
                    'trip': {'routeId': '20'}}}
        payload = {'entity': [entity('fresh', stamp, 12.5), entity('unknown-speed', stamp),
                              entity('old', stamp - 181), entity('invalid-speed', stamp, float('nan'))]}
        with patch.object(server, 'urlopen', return_value=io.BytesIO(json.dumps(payload).encode())):
            data = server.fetch_vehicles()
        self.assertEqual(data['status'], 'live')
        vehicles = {v['id']: v for v in data['vehicles']}
        self.assertEqual(vehicles['fresh']['speed'], 45.0)
        self.assertIsNone(vehicles['unknown-speed']['speed'])
        self.assertIsNone(vehicles['invalid-speed']['speed'])
        self.assertNotIn('old', vehicles)
        json.dumps(data, allow_nan=False)


if __name__ == '__main__':
    unittest.main()
