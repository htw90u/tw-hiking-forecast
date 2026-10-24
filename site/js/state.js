// Shared application state.
export const S = {
  settings: null,
  manifest: null,
  map: null,
  online: navigator.onLine,
  stations: [],
  stationsTime: null,
  spots: [],
  spotCats: [],
  peaks: [],     // OSM named peaks {k, n, lat, lon, ele} (not CWA forecast spots)
  quakes: [],
  typhoon: null,
  warnings: null,
  sat: [],
  towns: [],     // GeoJSON features with bbox
  counties: [],  // GeoJSON features
  grids: new Map(),   // meta path -> Promise<grid>
  metas: new Map(),   // meta path -> Promise<meta>
  layer: { id: null, overlay: null, frame: 0, period: 0, timer: null, qpfMode: '12' },
  overlays: {},
  focus: null,   // L.LayerGroup for point / quake highlight
};
