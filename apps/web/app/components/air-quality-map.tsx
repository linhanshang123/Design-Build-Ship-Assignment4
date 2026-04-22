"use client";

import L from "leaflet";
import { useEffect } from "react";
import { MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import type { Station, StationReading } from "../lib/airguard";
import {
  formatReadingValue,
  getAqiColor,
  getPrimaryReading,
} from "../lib/airguard";

type AirQualityMapProps = {
  stations: Station[];
  readingsByStation: Map<number, StationReading[]>;
  followedStationIds: Set<number>;
  selectedStationId: number | null;
  center: [number, number];
  zoom: number;
  onSelectStation: (stationId: number) => void;
};

function SelectedStationFlyTo({
  station,
}: {
  station: Station | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!station) return;

    map.setView([station.latitude, station.longitude], Math.max(map.getZoom(), 7), {
      animate: true,
      duration: 0.35,
    });
  }, [map, station]);

  return null;
}

function createStationIcon({
  reading,
  isFollowed,
  isSelected,
}: {
  reading: StationReading | null;
  isFollowed: boolean;
  isSelected: boolean;
}) {
  const color = getAqiColor(reading?.aqi_category);
  const value = reading?.aqi_estimate ?? formatReadingValue(reading);
  const size = isSelected ? 48 : isFollowed ? 42 : 34;

  return L.divIcon({
    className: "airguard-marker",
    html: `
      <div
        class="airguard-marker-core ${isSelected ? "is-selected" : ""} ${isFollowed ? "is-followed" : ""}"
        style="--marker-color:${color}; width:${size}px; height:${size}px;"
      >
        <span>${value}</span>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function AirQualityMap({
  stations,
  readingsByStation,
  followedStationIds,
  selectedStationId,
  center,
  zoom,
  onSelectStation,
}: AirQualityMapProps) {
  const selectedStation =
    stations.find((station) => station.openaq_location_id === selectedStationId) ||
    null;

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      minZoom={3}
      maxZoom={12}
      scrollWheelZoom
      className="h-full min-h-[420px] w-full overflow-hidden rounded-[24px]"
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />

      <SelectedStationFlyTo station={selectedStation} />

      {stations.map((station) => {
        const readings = readingsByStation.get(station.openaq_location_id) || [];
        const primaryReading = getPrimaryReading(readings);
        const isFollowed = followedStationIds.has(station.openaq_location_id);
        const isSelected = selectedStationId === station.openaq_location_id;

        return (
          <Marker
            key={station.openaq_location_id}
            position={[station.latitude, station.longitude]}
            icon={createStationIcon({
              reading: primaryReading,
              isFollowed,
              isSelected,
            })}
            title={station.name}
            eventHandlers={{
              click: () => onSelectStation(station.openaq_location_id),
            }}
          />
        );
      })}
    </MapContainer>
  );
}
