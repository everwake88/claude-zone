'use client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';

export interface Pin { id: string; lat: number; lng: number; name: string; state: string; orders: number | null }

// each state's colour on the map (the same meanings as everywhere: green open, amber paused, red off)
const COLOR: Record<string, string> = { open: 'var(--color-positive)', busy: 'var(--color-caution)', not_accepting: 'var(--color-critical)',
  closed: 'var(--color-muted)', unknown: 'var(--color-muted)' };

function Pins({ pins, selected, onSelect }: { pins: Pin[]; selected: string | null; onSelect: (id: string) => void }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    const g = L.featureGroup().addTo(map);
    pins.forEach(p => {
      const on = p.id === selected, c = COLOR[p.state] || COLOR.unknown;
      // a round pin with today's orders inside it; the chosen one larger, ringed in ink
      const html = `<span style="display:flex;align-items:center;justify-content:center;width:${on ? 40 : 32}px;height:${on ? 40 : 32}px;border-radius:999px;
        background:${c};color:#fff;font:600 ${on ? 14 : 12}px/1 system-ui,sans-serif;box-shadow:0 0 0 ${on ? 4 : 3}px #fff,0 6px 14px -6px rgba(0,0,0,.5)${on ? ',0 0 0 6px rgba(0,0,0,.75)' : ''};
        transition:transform .15s">${p.orders ?? ''}</span>`;
      const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ html, className: '', iconSize: [on ? 40 : 32, on ? 40 : 32], iconAnchor: [on ? 20 : 16, on ? 20 : 16] }),
                                          keyboard: true, title: p.name, zIndexOffset: on ? 1000 : 0 });
      m.bindTooltip(p.name, { direction: 'top', offset: [0, on ? -22 : -18] });
      m.on('click', () => onSelect(p.id));
      g.addLayer(m);
    });
    if (!fitted.current && pins.length) {
      fitted.current = true;
      if (pins.length === 1) map.setView([pins[0].lat, pins[0].lng], 14);
      else map.fitBounds(L.latLngBounds(pins.map(p => [p.lat, p.lng] as [number, number])), { padding: [48, 48], maxZoom: 14 });
    }
    return () => { g.remove(); };
  }, [map, pins, selected, onSelect]);
  // choosing a branch in the list brings the map to it
  useEffect(() => {
    const p = pins.find(x => x.id === selected);
    if (p) map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  return null;
}

export default function BranchMap({ pins, selected, onSelect }: { pins: Pin[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="isolate h-full min-h-[420px] overflow-hidden rounded-[var(--ui-radius)]">
      <MapContainer center={[30.0444, 31.2357]} zoom={11} scrollWheelZoom className="h-full w-full">
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
        <Pins pins={pins} selected={selected} onSelect={onSelect} />
      </MapContainer>
    </div>
  );
}
