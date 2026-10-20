// =====================================================================
// EVERWAKE — Main · NODE: Resolve Location
// A GPS pin → a real address (street, district, city, governorate).
// Google (the Apps Script reverse geocoder) first; OpenStreetMap when
// Google returns nothing. One clean shape either way, then save_pin()
// matches it against the restaurant's delivery zones.
// =====================================================================
// @include shared/basics.js

const intake = row($('Intake').first().json);
const claim = row($('Claim Debounce Window').first().json);
const loc = obj(parseJson(claim.location, {}));

let g = null, o = null;
try { g = $('Reverse Geocode (Google)').first().json; } catch (e) { g = null; }
try { o = $('Reverse Geocode (OSM)').first().json; } catch (e) { o = null; }

const clean = (s) => str(s).replace(/\s*،\s*(مصر|المملكة العربية السعودية|الإمارات العربية المتحدة|قطر)$/, '')
  .replace(/,\s*(Egypt|Saudi Arabia|United Arab Emirates|Qatar)$/i, '');
let geo = null;

if (g && (g.ok === true || g.formatted || g.street || g.city)) {
  geo = {
    street: str(g.street), district: str(g.district || g.neighborhood || g.area),
    city: str(g.city), governorate: str(g.governorate || g.state),
    formatted: clean(g.formatted), source: 'google'
  };
}
if ((!geo || (!geo.street && !geo.district && !geo.city)) && o && (o.address || o.display_name)) {
  const a = o.address || {};
  geo = {
    street: str([a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(' ')),
    district: str(a.neighbourhood || a.suburb || a.quarter || a.city_district || a.residential),
    city: str(a.city || a.town || a.village || a.municipality || a.county),
    governorate: str(a.state || a.province),
    formatted: clean(o.display_name), source: 'osm'
  };
}

const lat = Number(loc.lat), lng = Number(loc.lng);
const mapsUrl = loc.maps_url || loc.url || `https://www.google.com/maps?q=${lat},${lng}`;
const resolved = geo || { street: '', district: '', city: '', governorate: '', formatted: '', source: 'none' };
resolved.ok = !!(resolved.street || resolved.district || resolved.city || resolved.governorate);
resolved.pin_name = str(loc.name) || null;
resolved.pin_address = str(loc.address) || null;

return [{
  json: {
    lat, lng, maps_url: mapsUrl, geo: resolved,
    b64_pin: b64({ tenant_id: intake.tenant_id, wa_id: intake.wa_id, lat, lng, maps_url: mapsUrl, geo: resolved })
  }
}];
