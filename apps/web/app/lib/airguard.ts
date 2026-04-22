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
  {
    key: "new_york",
    label: "New York Metro",
    shortLabel: "New York",
    center: [40.7128, -74.006],
    zoom: 9,
  },
  {
    key: "los_angeles",
    label: "Los Angeles Basin",
    shortLabel: "Los Angeles",
    center: [34.0522, -118.2437],
    zoom: 9,
  },
  {
    key: "bay_area",
    label: "Bay Area",
    shortLabel: "Bay Area",
    center: [37.7749, -122.4194],
    zoom: 9,
  },
  {
    key: "houston",
    label: "Houston Metro",
    shortLabel: "Houston",
    center: [29.7604, -95.3698],
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
  pm25: 35,
  pm10: 100,
  o3: 0.07,
  no2: 100,
};

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

export function getPrimaryReading(readings: StationReading[]) {
  if (readings.length === 0) return null;

  const pm25 = readings.find((reading) => reading.pollutant === "pm25");
  if (pm25) return pm25;

  return [...readings].sort((a, b) => readingScore(b) - readingScore(a))[0];
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

  if (Math.abs(reading.value) < 10) {
    return reading.value.toFixed(1);
  }

  return Math.round(reading.value).toString();
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
  return threshold !== null && reading.value >= threshold;
}
