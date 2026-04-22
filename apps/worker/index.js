require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const OPENAQ_BASE_URL = "https://api.openaq.org/v3";
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DISCOVERY_LIMIT = Number(process.env.OPENAQ_DISCOVERY_LIMIT || 80);
const POLL_LIMIT = Number(process.env.OPENAQ_POLL_LIMIT || 60);
const POLL_INTERVAL_MS = Number(
  process.env.WORKER_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS,
);

const TARGET_PARAMETER_IDS = ["2", "1", "10", "7", "8", "9"];
const POLLUTANT_LABELS = {
  pm25: "PM2.5",
  pm10: "PM10",
  o3: "Ozone",
  no2: "NO2",
  so2: "SO2",
  co: "CO",
};

const SUPPORTED_REGIONS = {
  chicago: {
    label: "Chicago",
    bbox: "-88.35,41.55,-87.15,42.15",
  },
  new_york: {
    label: "New York",
    bbox: "-74.30,40.45,-73.65,41.05",
  },
  los_angeles: {
    label: "Los Angeles",
    bbox: "-118.75,33.65,-117.75,34.35",
  },
  bay_area: {
    label: "Bay Area",
    bbox: "-122.75,37.20,-121.70,38.15",
  },
  houston: {
    label: "Houston",
    bbox: "-95.90,29.00,-94.90,30.30",
  },
};

const DEFAULT_REGION_KEYS = (
  process.env.OPENAQ_REGION_KEYS || Object.keys(SUPPORTED_REGIONS).join(",")
)
  .split(",")
  .map((region) => region.trim())
  .filter((region) => region in SUPPORTED_REGIONS);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const supabase = createClient(
  requiredEnv("SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

const openAqKey = requiredEnv("OPENAQ_API_KEY");

function checkOnly() {
  requiredEnv("SUPABASE_URL");
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  requiredEnv("OPENAQ_API_KEY");
  console.log("Worker configuration is present.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePollutant(value) {
  return String(value || "")
    .toLowerCase()
    .replace(".", "")
    .replace(/\s+/g, "");
}

function formatStationName(location) {
  if (location.name && location.locality) {
    return `${location.name}, ${location.locality}`;
  }

  return location.name || location.locality || `OpenAQ Station ${location.id}`;
}

async function openAqGet(path, params = {}) {
  const url = new URL(`${OPENAQ_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : value);
  }

  const response = await fetch(url, {
    headers: {
      "X-API-Key": openAqKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAQ ${response.status} for ${url.pathname}: ${body}`);
  }

  return response.json();
}

function toStationRow(location, airguardRegion = "chicago") {
  const latitude = location.coordinates?.latitude;
  const longitude = location.coordinates?.longitude;

  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }

  return {
    openaq_location_id: location.id,
    name: formatStationName(location),
    locality: location.locality || null,
    region: SUPPORTED_REGIONS[airguardRegion]?.label || location.country?.name || null,
    airguard_region: airguardRegion,
    country_code: location.country?.code || "US",
    provider: location.provider?.name || location.owner?.name || null,
    latitude,
    longitude,
    is_active: true,
    last_seen_at:
      location.datetimeLast?.utc ||
      location.datetimeFirst?.utc ||
      new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function categoryFromAqi(aqi) {
  if (aqi === null || aqi === undefined) return "Unknown";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

function linearAqi(value, breakpoints) {
  for (const point of breakpoints) {
    const [clow, chigh, ilow, ihigh] = point;
    if (value >= clow && value <= chigh) {
      return Math.round(((ihigh - ilow) / (chigh - clow)) * (value - clow) + ilow);
    }
  }

  return value > breakpoints[breakpoints.length - 1][1] ? 500 : null;
}

function estimateAqi(pollutant, value, unit) {
  const normalizedUnit = String(unit || "").toLowerCase();

  if (pollutant === "pm25") {
    return linearAqi(value, [
      [0, 9, 0, 50],
      [9.1, 35.4, 51, 100],
      [35.5, 55.4, 101, 150],
      [55.5, 125.4, 151, 200],
      [125.5, 225.4, 201, 300],
      [225.5, 500.4, 301, 500],
    ]);
  }

  if (pollutant === "pm10") {
    return linearAqi(value, [
      [0, 54, 0, 50],
      [55, 154, 51, 100],
      [155, 254, 101, 150],
      [255, 354, 151, 200],
      [355, 424, 201, 300],
      [425, 604, 301, 500],
    ]);
  }

  if (pollutant === "o3" && normalizedUnit.includes("ppm")) {
    return linearAqi(value, [
      [0, 0.054, 0, 50],
      [0.055, 0.07, 51, 100],
      [0.071, 0.085, 101, 150],
      [0.086, 0.105, 151, 200],
      [0.106, 0.2, 201, 300],
    ]);
  }

  return null;
}

function readingRowsForLocation(location, latestResults) {
  const sensorsById = new Map(
    (location.sensors || []).map((sensor) => [sensor.id, sensor]),
  );

  return latestResults
    .map((reading) => {
      const sensor = sensorsById.get(reading.sensorsId);
      const pollutant = normalizePollutant(sensor?.parameter?.name);

      if (!pollutant || typeof reading.value !== "number") {
        return null;
      }

      const unit = sensor?.parameter?.units || "unknown";
      const aqiEstimate = estimateAqi(pollutant, reading.value, unit);

      return {
        station_id: location.id,
        pollutant,
        value: reading.value,
        unit,
        measured_at: reading.datetime?.utc || new Date().toISOString(),
        aqi_estimate: aqiEstimate,
        aqi_category: categoryFromAqi(aqiEstimate),
        source_payload: reading,
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function balancedPollLocations(locationsById) {
  const byRegion = new Map();

  for (const location of locationsById.values()) {
    const region = location.airguardRegion || "followed";
    const current = byRegion.get(region) || [];
    current.push(location);
    byRegion.set(region, current);
  }

  for (const regionLocations of byRegion.values()) {
    regionLocations.sort((a, b) => a.id - b.id);
  }

  const selected = [];
  const regionKeys = DEFAULT_REGION_KEYS.filter((region) => byRegion.has(region));
  const chicagoLimit = Math.min(24, POLL_LIMIT);
  const otherRegionLimit =
    regionKeys.length > 1
      ? Math.max(1, Math.floor((POLL_LIMIT - chicagoLimit) / (regionKeys.length - 1)))
      : 0;

  const chicago = byRegion.get("chicago") || [];
  selected.push(...chicago.slice(0, chicagoLimit));

  for (const regionKey of regionKeys) {
    if (regionKey === "chicago") continue;
    const regionLocations = byRegion.get(regionKey) || [];
    selected.push(...regionLocations.slice(0, otherRegionLimit));
  }

  if (selected.length < POLL_LIMIT) {
    const selectedIds = new Set(selected.map((location) => location.id));
    const remaining = Array.from(locationsById.values())
      .filter((location) => !selectedIds.has(location.id))
      .sort((a, b) => a.id - b.id);
    selected.push(...remaining.slice(0, POLL_LIMIT - selected.length));
  }

  return selected.slice(0, POLL_LIMIT);
}

async function getFollowedStationIds() {
  const { data, error } = await supabase
    .from("user_station_follows")
    .select("station_id");

  if (error) {
    throw error;
  }

  return [...new Set((data || []).map((row) => row.station_id))];
}

async function getKnownStationsByIds(ids) {
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("stations")
    .select("*")
    .in("openaq_location_id", ids);

  if (error) {
    throw error;
  }

  return data || [];
}

async function discoverStationsForRegion(regionKey) {
  const region = SUPPORTED_REGIONS[regionKey];
  if (!region) {
    return [];
  }

  const data = await openAqGet("/locations", {
    iso: "US",
    bbox: region.bbox,
    monitor: true,
    mobile: false,
    parameters_id: TARGET_PARAMETER_IDS,
    limit: DISCOVERY_LIMIT,
    page: 1,
    order_by: "id",
    sort_order: "asc",
  });

  return (data.results || [])
    .filter((location) => {
      return (
        typeof location.id === "number" &&
        typeof location.coordinates?.latitude === "number" &&
        typeof location.coordinates?.longitude === "number"
      );
    })
    .map((location) => ({
      ...location,
      airguardRegion: regionKey,
    }));
}

async function discoverStations() {
  const discovered = [];

  for (const regionKey of DEFAULT_REGION_KEYS) {
    try {
      const locations = await discoverStationsForRegion(regionKey);
      discovered.push(...locations);
      console.log(
        `Discovered ${locations.length} ${SUPPORTED_REGIONS[regionKey].label} stations.`,
      );
      await sleep(150);
    } catch (error) {
      console.error(`Failed to discover ${regionKey}`, error);
    }
  }

  return discovered;
}

async function loadLocation(locationId) {
  const data = await openAqGet(`/locations/${locationId}`);
  return data.results?.[0] || null;
}

async function getPollLocations() {
  const followedIds = await getFollowedStationIds();
  const knownFollowed = await getKnownStationsByIds(followedIds);
  const discovery = await discoverStations();

  const locationsById = new Map();

  for (const location of discovery) {
    locationsById.set(location.id, location);
  }

  for (const known of knownFollowed) {
    if (locationsById.has(known.openaq_location_id)) {
      continue;
    }

    try {
      const location = await loadLocation(known.openaq_location_id);
      if (location) {
        locationsById.set(location.id, {
          ...location,
          airguardRegion: known.airguard_region || "chicago",
        });
      }
    } catch (error) {
      console.error(`Failed to reload followed station ${known.openaq_location_id}`, error);
    }
  }

  return balancedPollLocations(locationsById);
}

async function createRun() {
  const { data, error } = await supabase
    .from("worker_runs")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  return data.id;
}

async function finishRun(id, payload) {
  const { error } = await supabase
    .from("worker_runs")
    .update({
      finished_at: new Date().toISOString(),
      ...payload,
    })
    .eq("id", id);

  if (error) {
    throw error;
  }
}

async function pollOnce() {
  const runId = await createRun();
  let stationsSeen = 0;
  let readingsSeen = 0;

  try {
    const locations = await getPollLocations();
    const stationRows = locations
      .map((location) => toStationRow(location, location.airguardRegion))
      .filter(Boolean);

    if (stationRows.length > 0) {
      const { error } = await supabase
        .from("stations")
        .upsert(stationRows, { onConflict: "openaq_location_id" });

      if (error) {
        throw error;
      }
    }

    stationsSeen = stationRows.length;

    for (const location of locations) {
      try {
        const latest = await openAqGet(`/locations/${location.id}/latest`, {
          limit: 100,
        });
        const readingRows = readingRowsForLocation(location, latest.results || []);

        if (readingRows.length > 0) {
          const { error } = await supabase
            .from("station_readings")
            .upsert(readingRows, { onConflict: "station_id,pollutant" });

          if (error) {
            throw error;
          }

          readingsSeen += readingRows.length;
        }

        await sleep(125);
      } catch (error) {
        console.error(`Failed to poll station ${location.id}`, error);
      }
    }

    await finishRun(runId, {
      status: "ok",
      stations_seen: stationsSeen,
      readings_seen: readingsSeen,
      error_message: null,
    });

    console.log(
      `Poll complete: ${stationsSeen} stations, ${readingsSeen} readings.`,
    );
  } catch (error) {
    await finishRun(runId, {
      status: "error",
      stations_seen: stationsSeen,
      readings_seen: readingsSeen,
      error_message: error.message,
    });
    throw error;
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    checkOnly();
    return;
  }

  await pollOnce();

  if (process.argv.includes("--once")) {
    return;
  }

  setInterval(() => {
    pollOnce().catch((error) => {
      console.error("Scheduled poll failed", error);
    });
  }, POLL_INTERVAL_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
