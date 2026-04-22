import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Station, StationReading } from "./airguard";
import { FRESH_READING_WINDOW_MS, isFreshPm25Reading } from "./airguard";

const OPENAQ_BASE_URL = "https://api.openaq.org/v3";
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";
const PM25_PARAMETER_ID = "2";
const SEARCH_RADIUS_METERS = 25000;
const SEARCH_LIMIT = 8;

export type StationSearchResult = {
  station: Station;
  reading: StationReading;
  source: "local" | "openaq";
  distanceMeters: number | null;
};

type OpenAqLocation = {
  id: number;
  name?: string | null;
  locality?: string | null;
  coordinates?: {
    latitude?: number;
    longitude?: number;
  } | null;
  provider?: { name?: string | null } | null;
  owner?: { name?: string | null } | null;
  country?: { code?: string | null; name?: string | null } | null;
  datetimeLast?: { utc?: string | null } | null;
  datetimeFirst?: { utc?: string | null } | null;
  sensors?: Array<{
    id: number;
    parameter?: {
      name?: string | null;
      units?: string | null;
    } | null;
  }> | null;
  distance?: number | null;
};

type OpenAqLatestReading = {
  sensorsId?: number;
  value?: number;
  datetime?: { utc?: string | null } | null;
};

type GeocodeResult = {
  lat: string;
  lon: string;
};

function requiredEnv(name: string, fallbackName?: string) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : "");

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function createServiceClient() {
  return createClient(
    requiredEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

function normalizePollutant(value: string | null | undefined) {
  return String(value || "")
    .toLowerCase()
    .replace(".", "")
    .replace(/\s+/g, "");
}

function formatStationName(location: OpenAqLocation) {
  if (location.name && location.locality) {
    return `${location.name}, ${location.locality}`;
  }

  return location.name || location.locality || `OpenAQ Station ${location.id}`;
}

function categoryFromAqi(aqi: number | null) {
  if (aqi === null) return "Unknown";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

function linearAqi(value: number, breakpoints: Array<[number, number, number, number]>) {
  for (const [clow, chigh, ilow, ihigh] of breakpoints) {
    if (value >= clow && value <= chigh) {
      return Math.round(((ihigh - ilow) / (chigh - clow)) * (value - clow) + ilow);
    }
  }

  return value > breakpoints[breakpoints.length - 1][1] ? 500 : null;
}

function estimatePm25Aqi(value: number) {
  return linearAqi(value, [
    [0, 9, 0, 50],
    [9.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200],
    [125.5, 225.4, 201, 300],
    [225.5, 500.4, 301, 500],
  ]);
}

function toStationRow(location: OpenAqLocation): Station | null {
  const latitude = location.coordinates?.latitude;
  const longitude = location.coordinates?.longitude;

  if (
    typeof location.id !== "number" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number"
  ) {
    return null;
  }

  const now = new Date().toISOString();

  return {
    openaq_location_id: location.id,
    name: formatStationName(location),
    locality: location.locality || null,
    region: location.country?.name || "United States",
    airguard_region: "custom",
    country_code: location.country?.code || "US",
    provider: location.provider?.name || location.owner?.name || null,
    latitude,
    longitude,
    is_active: true,
    last_seen_at: location.datetimeLast?.utc || location.datetimeFirst?.utc || now,
    created_at: now,
    updated_at: now,
  };
}

function pm25ReadingForLocation(
  location: OpenAqLocation,
  latestResults: OpenAqLatestReading[],
) {
  const sensorsById = new Map(
    (location.sensors || []).map((sensor) => [sensor.id, sensor]),
  );

  for (const latest of latestResults) {
    const sensor = latest.sensorsId ? sensorsById.get(latest.sensorsId) : null;
    const pollutant = normalizePollutant(sensor?.parameter?.name);

    if (pollutant !== "pm25" || typeof latest.value !== "number") {
      continue;
    }

    const aqiEstimate = estimatePm25Aqi(latest.value);
    const reading: StationReading = {
      station_id: location.id,
      pollutant: "pm25",
      value: latest.value,
      unit: sensor?.parameter?.units || "µg/m³",
      measured_at: latest.datetime?.utc || new Date().toISOString(),
      aqi_estimate: aqiEstimate,
      aqi_category: categoryFromAqi(aqiEstimate),
      updated_at: new Date().toISOString(),
    };

    if (isFreshPm25Reading(reading)) {
      return reading;
    }
  }

  return null;
}

async function openAqGet(path: string, params: Record<string, string | number | boolean>) {
  const url = new URL(`${OPENAQ_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      "X-API-Key": requiredEnv("OPENAQ_API_KEY"),
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAQ ${response.status} for ${url.pathname}: ${body}`);
  }

  return response.json();
}

async function geocodeUsQuery(query: string) {
  const url = new URL(NOMINATIM_BASE_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "AirGuard assignment app contact: local-development",
    },
  });

  if (!response.ok) {
    throw new Error(`Geocoding ${response.status}: ${await response.text()}`);
  }

  const results = (await response.json()) as GeocodeResult[];
  const first = results[0];
  const latitude = Number(first?.lat);
  const longitude = Number(first?.lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

async function latestPm25ForLocation(location: OpenAqLocation) {
  const latest = await openAqGet(`/locations/${location.id}/latest`, {
    limit: 100,
  });

  return pm25ReadingForLocation(location, latest.results || []);
}

export async function searchLocalStations(query: string): Promise<StationSearchResult[]> {
  const supabase = createServiceClient();
  const safeQuery = query.replace(/[%_,]/g, " ").trim();

  if (safeQuery.length < 2) return [];

  const { data: stations, error } = await supabase
    .from("stations")
    .select("*")
    .eq("is_active", true)
    .or(
      `name.ilike.%${safeQuery}%,locality.ilike.%${safeQuery}%,region.ilike.%${safeQuery}%,provider.ilike.%${safeQuery}%`,
    )
    .limit(12);

  if (error) throw error;

  const stationRows = (stations || []) as Station[];
  const stationIds = stationRows.map((station) => station.openaq_location_id);

  if (stationIds.length === 0) return [];

  const cutoff = new Date(Date.now() - FRESH_READING_WINDOW_MS).toISOString();
  const { data: readings, error: readingsError } = await supabase
    .from("station_readings")
    .select("station_id,pollutant,value,unit,measured_at,aqi_estimate,aqi_category,updated_at")
    .eq("pollutant", "pm25")
    .gte("measured_at", cutoff)
    .in("station_id", stationIds);

  if (readingsError) throw readingsError;

  const readingsByStation = new Map(
    ((readings || []) as StationReading[])
      .filter((reading) => isFreshPm25Reading(reading))
      .map((reading) => [reading.station_id, reading]),
  );

  const results: StationSearchResult[] = [];

  for (const station of stationRows) {
    const reading = readingsByStation.get(station.openaq_location_id);
    if (!reading) continue;

    results.push({
      station,
      reading,
      source: "local",
      distanceMeters: null,
    });
  }

  return results;
}

export async function searchOpenAqStations(query: string): Promise<StationSearchResult[]> {
  const geocoded = await geocodeUsQuery(query);

  if (!geocoded) return [];

  const data = await openAqGet("/locations", {
    iso: "US",
    coordinates: `${geocoded.latitude},${geocoded.longitude}`,
    radius: SEARCH_RADIUS_METERS,
    monitor: true,
    mobile: false,
    parameters_id: PM25_PARAMETER_ID,
    limit: 20,
    page: 1,
    order_by: "id",
    sort_order: "asc",
  });

  const locations = ((data.results || []) as OpenAqLocation[]).filter(
    (location) => typeof location.id === "number",
  );
  const results: StationSearchResult[] = [];

  for (const location of locations) {
    if (results.length >= SEARCH_LIMIT) break;

    const station = toStationRow(location);
    if (!station) continue;

    try {
      const reading = await latestPm25ForLocation(location);
      if (!reading) continue;

      results.push({
        station,
        reading,
        source: "openaq",
        distanceMeters: location.distance ?? null,
      });
    } catch {
      continue;
    }
  }

  return results;
}

export async function loadOpenAqStationWithPm25(locationId: number) {
  const data = await openAqGet(`/locations/${locationId}`, {});
  const location = (data.results || [])[0] as OpenAqLocation | undefined;

  if (!location) {
    throw new Error("OpenAQ station was not found.");
  }

  const station = toStationRow(location);
  if (!station) {
    throw new Error("OpenAQ station is missing coordinates.");
  }

  const reading = await latestPm25ForLocation(location);
  if (!reading) {
    throw new Error("OpenAQ station does not have fresh PM2.5 data.");
  }

  return { station, readings: [reading] };
}
