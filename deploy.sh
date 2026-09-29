#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  echo 'Run: sudo bash deploy.sh' >&2
  exit 1
fi

src="$(cd -- "$(dirname -- "$0")" && pwd)"
dest=/opt/stara-zagora-transit
web=/var/www/html/transport
apache_mode=managed
if [[ -f "$dest/apache-mode" ]]; then
  apache_mode="$(cat "$dest/apache-mode")"
fi
for arg in "$@"; do
  case "$arg" in
    --existing-apache) apache_mode=existing ;;
    --managed-apache) apache_mode=managed ;;
    *) echo "Unknown option: $arg. Use --existing-apache or --managed-apache." >&2; exit 1 ;;
  esac
done
if [[ "$apache_mode" != managed && "$apache_mode" != existing ]]; then
  echo 'Invalid saved Apache mode; specify --existing-apache or --managed-apache.' >&2
  exit 1
fi

if [[ ! -d /etc/apache2/conf-available || ! -d /var/www/html ]]; then
  echo 'Apache is not installed with the standard Debian layout.' >&2
  exit 1
fi
if [[ -e "$web" && ! -f "$web/index.html" ]]; then
  echo 'A different /transport directory already exists; review it before installing.' >&2
  exit 1
fi

for asset in index.html styles.css app.js transit-core.js icon.svg network.json vendor/leaflet/leaflet.css vendor/leaflet/leaflet.js vendor/leaflet/LICENSE; do
  if [[ ! -f "$src/static/$asset" ]]; then
    echo "Missing file: static/$asset. Extract the complete archive first." >&2
    exit 1
  fi
done

if [[ ! -f "$src/data/vehicle_models.json" ]]; then
  echo 'Missing file: data/vehicle_models.json. Extract the complete archive first.' >&2
  exit 1
fi

if [[ -f "$web/index.html" ]]; then
  backup="/var/backups/stara-zagora-transit/$(date +%Y%m%d-%H%M%S)-$$"
  install -d -m 0700 "$backup"
  cp -a "$web" "$backup/web"
  if [[ -d "$dest" ]]; then cp -a "$dest" "$backup/backend"; fi
  echo "Previous application saved to $backup"
fi

install -d -m 0755 "$dest/data" "$web/vendor/leaflet/images"
install -m 0644 "$src/server.py" "$src/build_data.py" "$src/refresh_data.py" "$dest/"
install -m 0644 "$src/data/trip_routes.json" "$src/data/official_route_aliases.json" "$src/data/gtfs-static_Trolleys-and-Busses-Stara-Zagora_20260928.zip" "$dest/data/"
install -m 0644 "$src/data/vehicle_models.json" "$dest/data/"
install -m 0644 "$src/static/styles.css" "$src/static/app.js" "$src/static/transit-core.js" "$src/static/icon.svg" "$src/static/network.json" "$web/"
install -m 0644 "$src/static/vendor/leaflet/leaflet.css" "$src/static/vendor/leaflet/leaflet.js" "$src/static/vendor/leaflet/LICENSE" "$web/vendor/leaflet/"
install -m 0644 "$src/static/vendor/leaflet/images/"*.png "$web/vendor/leaflet/images/"
install -m 0644 "$src/static/index.html" "$web/"
install -m 0644 "$src/stara-zagora-transit.service" "$src/stara-zagora-transit-refresh.service" "$src/stara-zagora-transit-refresh.timer" /etc/systemd/system/
if [[ "$apache_mode" == existing ]]; then
  # The existing VirtualHost owns ProxyPass. Replace the previous global
  # transport snippet with static compression only, avoiding duplicate rules.
  install -m 0644 "$src/apache-static.conf" /etc/apache2/conf-available/stara-zagora-transit.conf
else
  install -m 0644 "$src/apache.conf" /etc/apache2/conf-available/stara-zagora-transit.conf
fi
if [[ ! -e /etc/default/stara-zagora-transit ]]; then
  cat > /etc/default/stara-zagora-transit <<'ENV'
# Public GTFS-Realtime Vehicle Positions feed for Stara Zagora.
# Keep credentials (if using a different feed) only in this file, never in browser code.
GTFS_RT_URL=https://sipbg.gov.bg/bgnap/portal/api/catalog/subsets/2903167d-48d9-497e-b8ce-18efb07946bf/realtime-download
# The official national feed uses different route IDs than the timetable.
GTFS_RT_SOURCE=official
# GTFS_RT_HEADER=Authorization
# GTFS_RT_TOKEN="Bearer your-token"
ENV
  chmod 0600 /etc/default/stara-zagora-transit
fi

a2enmod proxy proxy_http deflate
a2enconf stara-zagora-transit
apache2ctl configtest
systemctl daemon-reload
systemctl enable stara-zagora-transit.service
systemctl restart stara-zagora-transit.service
systemctl enable --now stara-zagora-transit-refresh.timer
systemctl reload apache2
printf '%s\n' "$apache_mode" > "$dest/apache-mode"
chmod 0644 "$dest/apache-mode"
echo 'Map installed at /transport/ on your existing Apache site (HTTP or HTTPS).'
if [[ "$apache_mode" == existing ]]; then
  echo 'Using the /transport/api/ proxy rules from your existing VirtualHost.'
fi
echo 'GPS positions use the public Stara Zagora feed. Check: curl http://127.0.0.1:8765/api/vehicles'
