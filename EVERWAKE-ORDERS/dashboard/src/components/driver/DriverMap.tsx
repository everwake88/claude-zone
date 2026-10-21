'use client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';

type P = [number, number];
const pin = (emoji: string, bg: string) => L.divIcon({
  className: '', iconSize: [34, 34], iconAnchor: [17, 17],
  html: `<div style="width:34px;height:34px;border-radius:50%;background:${bg};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:17px">${emoji}</div>`
});

// the driver, where they pick up and where they deliver; fits all three
function Points({ me, to, from }: { me: P | null; to: P | null; from: P | null }) {
  const map = useMap();
  const group = useRef(L.featureGroup());
  const fitted = useRef('');
  useEffect(() => {
    const g = group.current;
    g.clearLayers().addTo(map);
    if (from) g.addLayer(L.marker(from, { icon: pin('🏪', '#0B222E') }));
    if (to) g.addLayer(L.marker(to, { icon: pin('🏠', '#B8913F') }));
    if (me) g.addLayer(L.marker(me, { icon: pin('🛵', '#2E7D5B') }));
    if (me && to) g.addLayer(L.polyline([me, to], { color: '#2E7D5B', weight: 3, dashArray: '6 8' }));
    // re-fit only when the set of points changes, not on every move
    const key = [!!me, to?.join(), from?.join()].join('|');
    const pts = [me, to, from].filter(Boolean) as P[];
    if (pts.length && key !== fitted.current) {
      fitted.current = key;
      if (pts.length === 1) map.setView(pts[0], 15); else map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 16 });
    }
  }, [map, me, to, from]);
  return null;
}

export default function DriverMap({ me, to, from }: { me: P | null; to: P | null; from: P | null }) {
  const start = to || from || me || [30.0444, 31.2357];
  return (
    <div className="isolate h-56">
      <MapContainer center={start} zoom={14} zoomControl={false} attributionControl={false} style={{ borderRadius: 0 }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Points me={me} to={to} from={from} />
      </MapContainer>
    </div>
  );
}
