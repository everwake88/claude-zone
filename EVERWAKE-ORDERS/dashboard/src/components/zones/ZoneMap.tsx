'use client';
import L from './leaflet-global';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { Branch, Zone } from '@/lib/types';

export type Shape = { kind: 'polygon'; polygon: [number, number][] } | { kind: 'radius'; center_lat: number; center_lng: number; radius_km: number };

const PALETTE = ['#B8913F', '#2E7D5B', '#3B6FA0', '#A33B32', '#7A4FA0', '#9A6B1E', '#16384A'];
export const branchColor = (branches: Branch[], id: string) => PALETTE[Math.max(0, branches.findIndex(b => b.id === id)) % PALETTE.length];

function shapeOf(layer: L.Layer): Shape | null {
  if (layer instanceof L.Circle) {
    const c = layer.getLatLng();
    return { kind: 'radius', center_lat: c.lat, center_lng: c.lng, radius_km: Math.round(layer.getRadius() / 10) / 100 };
  }
  if (layer instanceof L.Polygon) {
    const ring = (layer.getLatLngs()[0] as L.LatLng[]).map(p => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6] as [number, number]);
    return { kind: 'polygon', polygon: ring };
  }
  return null;
}

interface Props {
  branches: Branch[]; zones: Zone[]; selected: string | null; draft: Shape | null; testPoint: [number, number] | null;
  editable: boolean; testing: boolean;
  onSelect: (id: string | null) => void; onDraw: (s: Shape) => void; onEdit: (id: string, s: Shape) => void; onTest: (lat: number, lng: number) => void;
}

function Layers(p: Props) {
  const map = useMap();
  const group = useRef<L.FeatureGroup>(L.featureGroup());
  const cb = useRef(p);
  cb.current = p;

  // drawing tools
  useEffect(() => {
    group.current.addTo(map);
    if (p.editable) {
      map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawText: false,
                           drawPolygon: true, drawRectangle: true, drawCircle: true, editMode: false, dragMode: false,
                           cutPolygon: false, removalMode: false, rotateMode: false });
    }
    const created = (e: { layer: L.Layer }) => {
      const s = shapeOf(e.layer);
      map.removeLayer(e.layer);
      if (s) cb.current.onDraw(s);
    };
    const click = (e: L.LeafletMouseEvent) => { if (cb.current.testing) cb.current.onTest(e.latlng.lat, e.latlng.lng); };
    map.on('pm:create', created);
    map.on('click', click);
    return () => { map.off('pm:create', created); map.off('click', click); if (p.editable) map.pm.removeControls(); };
  }, [map, p.editable]);

  // zones, branches, the draft and the test pin
  useEffect(() => {
    const g = group.current;
    g.clearLayers();
    for (const z of p.zones) {
      const color = branchColor(p.branches, z.branch_id);
      const style = { color, weight: z.id === p.selected ? 3 : 1.5, fillOpacity: z.is_active ? (z.id === p.selected ? 0.3 : 0.15) : 0.04,
                      dashArray: z.is_active ? undefined : '6 6' };
      const layer = z.kind === 'radius' && z.center_lat != null && z.center_lng != null
        ? L.circle([z.center_lat, z.center_lng], { radius: Number(z.radius_km || 0) * 1000, ...style })
        : z.polygon ? L.polygon(z.polygon, style) : null;
      if (!layer) continue;
      layer.bindTooltip(z.name_ar, { direction: 'center', className: 'ar' });
      layer.on('click', (e) => { if (!cb.current.testing) { L.DomEvent.stopPropagation(e); cb.current.onSelect(z.id); } });
      g.addLayer(layer);
      if (z.id === p.selected && p.editable) {
        layer.pm.enable({ allowSelfIntersection: false });
        layer.on('pm:edit', () => { const s = shapeOf(layer); if (s) cb.current.onEdit(z.id, s); });
      }
    }
    for (const b of p.branches) {
      if (b.lat == null || b.lng == null) continue;
      const icon = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14],
        html: `<div style="width:28px;height:28px;border-radius:50%;background:#0B222E;border:3px solid ${branchColor(p.branches, b.id)};box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>` });
      g.addLayer(L.marker([b.lat, b.lng], { icon }).bindTooltip(b.name_en || b.name_ar));
    }
    if (p.draft) {
      const d = p.draft;
      g.addLayer(d.kind === 'radius' ? L.circle([d.center_lat, d.center_lng], { radius: d.radius_km * 1000, color: '#0B222E', dashArray: '4 4' })
                                     : L.polygon(d.polygon, { color: '#0B222E', dashArray: '4 4' }));
    }
    if (p.testPoint) g.addLayer(L.circleMarker(p.testPoint, { radius: 8, color: '#A33B32', fillColor: '#A33B32', fillOpacity: 0.9 }));
  }, [p.zones, p.branches, p.selected, p.draft, p.testPoint, p.editable]);

  return null;
}

export default function ZoneMap(p: Props) {
  const withPin = p.branches.find(b => b.lat != null && b.lng != null);
  const center: [number, number] = withPin ? [withPin.lat!, withPin.lng!] : [30.0444, 31.2357];
  return (
    <MapContainer center={center} zoom={13} scrollWheelZoom className={p.testing ? 'cursor-crosshair' : ''}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
      <Layers {...p} />
    </MapContainer>
  );
}
