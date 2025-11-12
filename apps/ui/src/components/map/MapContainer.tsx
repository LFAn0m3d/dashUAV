import { useEffect, useRef } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';

type Props = {
  center?: { lon: number; lat: number };
  zoom?: number;
  showMarkerAtCenter?: boolean;
  className?: string;
};

const mapStyle: StyleSpecification = {
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
};

export default function MapContainer({
  center = { lon: 100.5018, lat: 13.7563 },
  zoom = 7,
  showMarkerAtCenter = true,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle,
      center: [center.lon, center.lat],
      zoom,
    });

    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    return () => {
      markerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [center.lat, center.lon, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    map.setCenter([center.lon, center.lat]);
    map.setZoom(zoom);
  }, [center.lat, center.lon, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (!showMarkerAtCenter) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const marker = markerRef.current ?? new maplibregl.Marker({ color: '#2563eb' });
    marker.setLngLat([center.lon, center.lat]).addTo(map);
    markerRef.current = marker;
  }, [center.lat, center.lon, showMarkerAtCenter]);

  return <div ref={containerRef} className={className ?? ''} style={{ width: '100%', height: '100%' }} />;
}
