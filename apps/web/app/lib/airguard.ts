import { createClient } from "@supabase/supabase-js";

export type Station = {
  openaq_location_id: number;
  name: string;
  locality: string | null;
  region: string | null;
  airguard_region: string;
  country_code: string;
  provider: string | null;
  latitude: number;
  longitude: number;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StationReading = {
  station_id: number;
  pollutant: string;
  value: number;
  unit: string;
  measured_at: string;
  aqi_estimate: number | null;
  aqi_category: string;
  updated_at: string;
};

export type UserStationFollow = {
  id: string;
  clerk_user_id: string;
  station_id: number;
  created_at: string;
};

export type UserThreshold = {
  id: string;
  clerk_user_id: string;
  pollutant: string;
  threshold_value: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type UserRegionPreference = {
  clerk_user_id: string;
  region_key: string;
  created_at: string;
  updated_at: string;
};

export type UserRegionFollow = {
  id: string;
  clerk_user_id: string;
  region_key: string;
  label: string;
  center_lat: number;
  center_lng: number;
  zoom: number;
  created_at: string;
};

export type WorkerRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  stations_seen: number;
  readings_seen: number;
  error_message: string | null;
};

export type StationSummary = {
  station: Station;
  readings: StationReading[];
  primaryReading: StationReading | null;
};

export type AirGuardRegion = {
  key: string;
  label: string;
  shortLabel: string;
  center: [number, number];
  zoom: number;
};

export const AIRGUARD_REGIONS: AirGuardRegion[] = [
  {
    key: "chicago",
    label: "Chicago Metro",
    shortLabel: "Chicago",
    center: [41.8781, -87.6298],
    zoom: 9,
  },
];

export const DEFAULT_REGION_KEY = "chicago";

export function getRegionConfig(regionKey: string) {
  return (
    AIRGUARD_REGIONS.find((region) => region.key === regionKey) ||
    AIRGUARD_REGIONS[0]
  );
}

export const POLLUTANT_LABELS: Record<string, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  o3: "Ozone",
  no2: "NO2",
  so2: "SO2",
  co: "CO",
};

export const DEFAULT_THRESHOLDS: Record<string, number> = {
  pm25: 100,
};

export const FRESH_READING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createAirGuardClient(
  getToken?: () => Promise<string | null>,
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase frontend environment variables.");
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    accessToken: getToken,
  });
}

export function readingScore(reading: StationReading | null) {
  if (!reading) return -1;
  return reading.aqi_estimate ?? reading.value;
}

export function isFreshReading(
  reading: StationReading | null,
  nowMs = Date.now(),
) {
  if (!reading) return false;

  const measuredAt = new Date(reading.measured_at).getTime();
  return Number.isFinite(measuredAt) && nowMs - measuredAt <= FRESH_READING_WINDOW_MS;
}

export function isFreshPm25Reading(
  reading: StationReading | null,
  nowMs = Date.now(),
) {
  return (
    reading?.pollutant === "pm25" &&
    reading.aqi_estimate !== null &&
    isFreshReading(reading, nowMs)
  );
}

export function getPrimaryReading(readings: StationReading[]) {
  if (readings.length === 0) return null;

  return readings.find((reading) => isFreshPm25Reading(reading)) ?? null;
}

export function getAqiColor(category: string | null | undefined) {
  switch (category) {
    case "Good":
      return "#9ee65f";
    case "Moderate":
      return "#ffd34d";
    case "Unhealthy for Sensitive Groups":
      return "#ff9a4d";
    case "Unhealthy":
      return "#f45b69";
    case "Very Unhealthy":
      return "#b06adf";
    case "Hazardous":
      return "#8f3a5e";
    default:
      return "#7dd3fc";
  }
}

export function formatReadingValue(reading: StationReading | null) {
  if (!reading) return "No data";

  if (Math.abs(reading.value) < 1) {
    return reading.value.toFixed(3);
  }

  return reading.value.toFixed(1);
}

export function formatMeasuredAt(value: string | null | undefined) {
  if (!value) return "Unknown";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function thresholdFor(
  pollutant: string,
  thresholds: UserThreshold[],
) {
  if (!(pollutant in DEFAULT_THRESHOLDS)) {
    return null;
  }

  const saved = thresholds.find(
    (threshold) => threshold.pollutant === pollutant && threshold.enabled,
  );

  return saved?.threshold_value ?? DEFAULT_THRESHOLDS[pollutant] ?? null;
}

export function isOverThreshold(
  reading: StationReading | null,
  thresholds: UserThreshold[],
) {
  if (!reading) return false;

  const threshold = thresholdFor(reading.pollutant, thresholds);
  const score = reading.aqi_estimate ?? reading.value;
  return threshold !== null && score >= threshold;
}
