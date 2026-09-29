/* Shared timetable logic. Times are local service-day seconds in Europe/Sofia. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransitCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400;
  const compact = date => date.replaceAll('-', '');
  function addDays(date, offset) {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  }
  function now(value = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, seconds: +p.hour * 3600 + +p.minute * 60 + +p.second, text: `${p.hour}:${p.minute}` };
  }
  function clock(seconds) {
    const t = ((seconds % DAY) + DAY) % DAY;
    return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`;
  }
  function serviceActive(network, service, date) {
    const key = compact(date), exception = network.exceptions?.[key]?.[service];
    if (exception != null) return exception === 1;
    const c = network.calendar[service];
    const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
    return Boolean(c && c.start <= key && c.end >= key && c.days[weekday]);
  }
  function distance(a, b) {
    const rad = Math.PI / 180, x = (b.lat - a.lat) * rad, y = (b.lon - a.lon) * rad;
    const h = Math.sin(x / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(y / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - Math.min(1, h)));
  }
  function create(network) {
    const routes = new Map(network.routes.map(x => [x.id, x]));
    const stops = new Map(network.stops.map(x => [x.id, x]));
    const trips = new Map(network.trips.map(x => [x.id, x]));
    let cachedDate = '', cachedBoard;
    function board(date) {
      if (date === cachedDate) return cachedBoard;
      const result = new Map();
      for (const offset of [-1, 0, 1]) {
        const serviceDate = addDays(date, offset), shift = offset * DAY;
        for (const trip of network.trips) {
          if (!serviceActive(network, trip.service, serviceDate)) continue;
          trip.times.forEach((point, index) => {
            if (index === trip.times.length - 1 || point[3] !== 0) return;
            const time = point[2] + shift;
            if (!result.has(point[0])) result.set(point[0], []);
            result.get(point[0]).push({ time, trip, index, shift, serviceDate });
          });
        }
      }
      for (const items of result.values()) items.sort((a, b) => a.time - b.time || a.trip.id.localeCompare(b.trip.id));
      cachedDate = date; cachedBoard = result;
      return result;
    }
    function departures(stop, date, seconds = 0, options = {}) {
      const { route, pattern, horizon = DAY - seconds, limit = 200 } = options;
      const items = board(date).get(stop) || [];
      let low = 0, high = items.length;
      while (low < high) { const mid = (low + high) >>> 1; if (items[mid].time < seconds) low = mid + 1; else high = mid; }
      const output = [], seen = new Set();
      for (let i = low; i < items.length && items[i].time < seconds + horizon && output.length < limit; i++) {
        const d = items[i];
        if ((route && d.trip.route !== route) || (pattern && d.trip.pattern !== pattern)) continue;
        const key = `${d.time}|${d.trip.route}|${d.trip.pattern}`;
        if (seen.has(key)) continue;
        seen.add(key); output.push(d);
      }
      return output;
    }
    const neighbours = new Map();
    function walkStops(id, maxDistance) {
      const key = `${id}/${maxDistance}`;
      if (!neighbours.has(key)) {
        const origin = stops.get(id);
        neighbours.set(key, network.stops.map(stop => ({ id: stop.id, metres: distance(origin, stop) })).filter(x => x.metres <= maxDistance));
      }
      return neighbours.get(key);
    }
    function leg(d, toIndex) {
      return { trip: d.trip.id, route: d.trip.route, pattern: d.trip.pattern, serviceDate: d.serviceDate,
        shift: d.shift, fromIndex: d.index, toIndex, from: d.trip.times[d.index][0], to: d.trip.times[toIndex][0],
        depart: d.time, arrive: d.trip.times[toIndex][1] + d.shift };
    }
    function plan(from, to, date, seconds, options = {}) {
      if (!stops.has(from) || !stops.has(to) || from === to) return [];
      const maxWalk = options.walk === false ? 0 : 200;
      const first = departures(from, date, seconds, { horizon: 3 * 3600, limit: 500 });
      const candidates = [], seen = new Set();
      function push(legs, walk = null) {
        const key = legs.map(x => `${x.trip}/${x.serviceDate}/${x.fromIndex}/${x.toIndex}`).join('|');
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ legs, walk, depart: legs[0].depart, arrive: legs.at(-1).arrive });
      }
      for (const d of first) {
        for (let j = d.index + 1; j < d.trip.times.length; j++) {
          const point = d.trip.times[j];
          if (point[4] !== 0) continue;
          const firstLeg = leg(d, j);
          if (point[0] === to) { push([firstLeg]); break; }
          if (options.transfers === false) continue;
          for (const nearby of walkStops(point[0], maxWalk)) {
            const walkSeconds = nearby.id === point[0] ? 0 : Math.ceil(nearby.metres / 1.1);
            const earliest = firstLeg.arrive + walkSeconds + 180;
            const changes = departures(nearby.id, date, earliest, { horizon: 3600, limit: 200 });
            for (const d2 of changes) {
              if (d2.trip.route === d.trip.route) continue;
              const k = d2.trip.times.findIndex((p, idx) => idx > d2.index && p[0] === to && p[4] === 0);
              if (k < 0) continue;
              push([firstLeg, leg(d2, k)], { from: point[0], to: nearby.id, metres: Math.round(nearby.metres), seconds: walkSeconds });
            }
          }
        }
      }
      // Rank by arrival; keep distinct useful departures instead of repeated transfer points.
      candidates.sort((a, b) => a.arrive - b.arrive || a.legs.length - b.legs.length || b.depart - a.depart || (a.walk?.metres || 0) - (b.walk?.metres || 0));
      const chosen = [], keys = new Set();
      for (const item of candidates) {
        const key = `${item.depart}|${item.arrive}|${item.legs.map(x => x.route).join('/')}`;
        if (keys.has(key)) continue;
        // A direct option arriving no later and departing no earlier dominates a transfer.
        if (item.legs.length > 1 && candidates.some(x => x.legs.length === 1 && x.arrive <= item.arrive && x.depart >= item.depart)) continue;
        keys.add(key); chosen.push(item);
        if (chosen.length === 8) break;
      }
      return chosen;
    }
    return { network, routes, stops, trips, departures, plan };
  }
  return { create, now, clock, addDays, serviceActive, distance, DAY };
});
