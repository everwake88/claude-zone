'use client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';

type Pt = { lat: number; lng: number; area?: string };

// where the customers outside the delivery zones are: the next zone or branch
function Layer({ points, branches }: { points: Pt[]; branches: Pt[] }) {
  const map = useMap();
  useEffect(() => {
    const g = L.featureGroup().addTo(map);
    branches.forEach(b => g.addLayer(L.circleMarker([b.lat, b.lng], { radius: 9, color: '#0B222E', fillColor: '#B8913F', fillOpacity: 1, weight: 3 })
      .bindTooltip(b.area || '')));
    points.forEach(p => g.addLayer(L.circleMarker([p.lat, p.lng], { radius: 7, color: '#A33B32', fillColor: '#A33B32', fillOpacity: 0.55, weight: 1 })
      .bindTooltip(p.area || '')));
    const all = [...points, ...branches];
    if (all.length) map.fitBounds(L.latLngBounds(all.map(p => [p.lat, p.lng] as [number, number])), { padding: [30, 30], maxZoom: 13 });
    return () => { g.remove(); };
  }, [map, points, branches]);
  return null;
}

export default function DemandMap({ points, branches }: { points: Pt[]; branches: Pt[] }) {
  return (
    <div className="isolate h-80">
      <MapContainer center={[30.0444, 31.2357]} zoom={10} scrollWheelZoom={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
        <Layer points={points} branches={branches} />
      </MapContainer>
    </div>
  );
}
