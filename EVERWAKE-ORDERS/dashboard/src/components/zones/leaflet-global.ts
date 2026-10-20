// The drawing plugin (Geoman) looks for Leaflet on window.L, so Leaflet is
// put there before the plugin loads (this module is imported first).
import L from 'leaflet';

if (typeof window !== 'undefined') (window as unknown as { L: typeof L }).L = L;

export default L;
