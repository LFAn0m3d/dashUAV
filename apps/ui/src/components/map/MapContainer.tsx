// src/components/map/MapContainer.tsx
import 'maplibre-gl/dist/maplibre-gl.css';
import Map, { Marker } from 'react-map-gl';
import maplibregl from 'maplibre-gl';

type Props = {
  center?: { lon: number; lat: number };
  zoom?: number;
  showMarkerAtCenter?: boolean;
  className?: string;
};

export default function MapContainer({
  center = { lon: 100.5018, lat: 13.7563 },
  zoom = 7,
  showMarkerAtCenter = true,
  className,
}: Props) {
  return (
    <div className={className ?? ''} style={{ width: '100%', height: '100%' }}>
      <Map
        /** ใช้ MapLibre แทน Mapbox */
        mapLib={maplibregl as any}
        initialViewState={{ longitude: center.lon, latitude: center.lat, zoom }}
        style={{ width: '100%', height: '100%' }}
        /** ใช้ OSM raster tiles (ไม่ต้องใช้ token) */
        mapStyle={{
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '© OpenStreetMap contributors',
            },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        }}
      >
        {showMarkerAtCenter && (
          <Marker longitude={center.lon} latitude={center.lat} />
        )}
      </Map>
    </div>
  );
}
