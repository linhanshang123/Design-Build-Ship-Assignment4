"use client";

import dynamic from "next/dynamic";
import { UserButton, useAuth, useUser } from "@clerk/nextjs";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Heart,
  Loader2,
  MapPin,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AirGuardRegion,
  Station,
  StationReading,
  UserRegionFollow,
  UserRegionPreference,
  UserStationFollow,
  UserThreshold,
  WorkerRun,
} from "../lib/airguard";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_REGION_KEY,
  formatMeasuredAt,
  formatReadingValue,
  getAqiColor,
  getPrimaryReading,
  getRegionConfig,
  isOverThreshold,
  POLLUTANT_LABELS,
  thresholdFor,
  createAirGuardClient,
} from "../lib/airguard";

const AirQualityMap = dynamic(() => import("./air-quality-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[420px] items-center justify-center rounded-[24px] border border-white/10 bg-black/40 text-sm text-white/60">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading map
    </div>
  ),
});

type LoadState = "idle" | "loading" | "ready" | "error";

type StationSearchResult = {
  station: Station;
  reading: StationReading;
  source: "local" | "openaq";
  distanceMeters: number | null;
};

function titleCaseSearch(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function searchRegionKey(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug ? `search:${slug}` : "";
}

function isVisibleRegionFollow(follow: UserRegionFollow) {
  return follow.region_key === DEFAULT_REGION_KEY || follow.region_key.startsWith("search:");
}

function regionFromFollow(follow: UserRegionFollow): AirGuardRegion {
  if (follow.region_key === DEFAULT_REGION_KEY) {
    return getRegionConfig(DEFAULT_REGION_KEY);
  }

  return {
    key: follow.region_key,
    label: follow.label,
    shortLabel: follow.label,
    center: [follow.center_lat, follow.center_lng],
    zoom: follow.zoom,
  };
}

function groupReadings(readings: StationReading[]) {
  const map = new Map<number, StationReading[]>();

  for (const reading of readings) {
    const current = map.get(reading.station_id) || [];
    current.push(reading);
    map.set(reading.station_id, current);
  }

  return map;
}

function sortStationsByReading(
  stations: Station[],
  readingsByStation: Map<number, StationReading[]>,
) {
  return [...stations].sort((a, b) => {
    const aReading = getPrimaryReading(readingsByStation.get(a.openaq_location_id) || []);
    const bReading = getPrimaryReading(readingsByStation.get(b.openaq_location_id) || []);
    return (bReading?.aqi_estimate || bReading?.value || 0) - (aReading?.aqi_estimate || aReading?.value || 0);
  });
}

function averageCenter(stations: Station[]): [number, number] | null {
  if (stations.length === 0) return null;

  const totals = stations.reduce(
    (current, station) => {
      return {
        latitude: current.latitude + station.latitude,
        longitude: current.longitude + station.longitude,
      };
    },
    { latitude: 0, longitude: 0 },
  );

  return [
    totals.latitude / stations.length,
    totals.longitude / stations.length,
  ];
}

function getStatusCopy(run: WorkerRun | null) {
  if (!run) return "Waiting for first worker run";
  if (run.status === "ok") return `Live ${formatMeasuredAt(run.finished_at)}`;
  if (run.status === "running") return "Worker polling now";
  return "Worker needs attention";
}

function getConnectionMessage(message: string) {
  return `AirGuard data connection issue: ${message}. Your signed-in session is still active.`;
}

export default function Dashboard() {
  const { user } = useUser();
  const { getToken } = useAuth();
  const [stations, setStations] = useState<Station[]>([]);
  const [readings, setReadings] = useState<StationReading[]>([]);
  const [follows, setFollows] = useState<UserStationFollow[]>([]);
  const [regionFollows, setRegionFollows] = useState<UserRegionFollow[]>([]);
  const [thresholds, setThresholds] = useState<UserThreshold[]>([]);
  const [latestRun, setLatestRun] = useState<WorkerRun | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<number | null>(null);
  const [selectedRegion, setSelectedRegion] = useState(DEFAULT_REGION_KEY);
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [searchResults, setSearchResults] = useState<StationSearchResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [savingPollutant, setSavingPollutant] = useState<string | null>(null);
  const [importingStationId, setImportingStationId] = useState<number | null>(null);
  const [savingRegionKey, setSavingRegionKey] = useState<string | null>(null);

  const supabase = useMemo<SupabaseClient>(() => {
    return createAirGuardClient(() => getToken());
  }, [getToken]);

  const followedStationIds = useMemo(() => {
    return new Set(follows.map((follow) => follow.station_id));
  }, [follows]);

  const followedRegionKeys = useMemo(() => {
    return new Set(regionFollows.map((follow) => follow.region_key));
  }, [regionFollows]);

  const followedRegions = useMemo(() => {
    return regionFollows
      .filter(isVisibleRegionFollow)
      .map(regionFromFollow)
      .sort((a, b) => {
        if (a.key === DEFAULT_REGION_KEY) return -1;
        if (b.key === DEFAULT_REGION_KEY) return 1;
        return a.shortLabel.localeCompare(b.shortLabel);
      });
  }, [regionFollows]);

  const readingsByStation = useMemo(() => groupReadings(readings), [readings]);
  const activeRegion = getRegionConfig(selectedRegion);
  const normalizedQuery = query.trim();
  const isSearchMode = normalizedQuery.length >= 2;
  const currentSearchRegionKey = searchRegionKey(normalizedQuery);
  const currentSearchRegionLabel = titleCaseSearch(normalizedQuery);

  const regionStations = useMemo(() => {
    return stations.filter((station) => station.airguard_region === selectedRegion);
  }, [selectedRegion, stations]);

  const followedStations = useMemo(() => {
    return stations.filter((station) => followedStationIds.has(station.openaq_location_id));
  }, [followedStationIds, stations]);

  const mapStations = useMemo(() => {
    const stationMap = new Map<number, Station>();

    for (const station of regionStations) {
      stationMap.set(station.openaq_location_id, station);
    }

    for (const station of followedStations) {
      stationMap.set(station.openaq_location_id, station);
    }

    return Array.from(stationMap.values());
  }, [followedStations, regionStations]);

  const filteredStations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sorted = sortStationsByReading(mapStations, readingsByStation);

    if (!normalizedQuery) return sorted;

    return sorted.filter((station) => {
      return [station.name, station.locality, station.region, station.provider]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [query, mapStations, readingsByStation]);

  const visibleMapStations = useMemo(() => {
    return filteredStations.filter((station) => {
      return Boolean(getPrimaryReading(readingsByStation.get(station.openaq_location_id) || []));
    });
  }, [filteredStations, readingsByStation]);

  const searchStations = useMemo(() => {
    return searchResults.map((result) => result.station);
  }, [searchResults]);

  const searchReadingsByStation = useMemo(() => {
    return groupReadings(searchResults.map((result) => result.reading));
  }, [searchResults]);

  const searchMapStations = useMemo(() => {
    const stationMap = new Map<number, Station>();

    for (const station of searchStations) {
      stationMap.set(station.openaq_location_id, station);
    }

    for (const station of followedStations) {
      stationMap.set(station.openaq_location_id, station);
    }

    return Array.from(stationMap.values());
  }, [followedStations, searchStations]);

  const activeMapStations = isSearchMode ? searchMapStations : visibleMapStations;
  const activeReadingsByStation = isSearchMode
    ? searchReadingsByStation
    : readingsByStation;
  const searchCenter = averageCenter(searchStations);
  const mapCenter = isSearchMode && searchCenter ? searchCenter : activeRegion.center;
  const mapZoom = isSearchMode && searchStations.length > 0 ? 10 : activeRegion.zoom;
  const canFollowCurrentSearch =
    isSearchMode &&
    searchState === "ready" &&
    searchStations.length > 0 &&
    Boolean(searchCenter) &&
    Boolean(currentSearchRegionKey);
  const currentSearchRegionFollowed =
    canFollowCurrentSearch && followedRegionKeys.has(currentSearchRegionKey);
  const mapKey = isSearchMode
    ? `search-${normalizedQuery.toLowerCase()}-${activeMapStations
        .map((station) => station.openaq_location_id)
        .join("-")}`
    : `region-${selectedRegion}`;

  const selectedStation = useMemo(() => {
    return (
      stations.find((station) => station.openaq_location_id === selectedStationId) ||
      searchStations.find((station) => station.openaq_location_id === selectedStationId) ||
      activeMapStations[0] ||
      null
    );
  }, [activeMapStations, searchStations, selectedStationId, stations]);

  const selectedReadings = selectedStation
    ? activeReadingsByStation.get(selectedStation.openaq_location_id) ||
      readingsByStation.get(selectedStation.openaq_location_id) ||
      []
    : [];
  const selectedSearchResult = selectedStation
    ? searchResults.find(
        (result) =>
          result.station.openaq_location_id === selectedStation.openaq_location_id,
      ) || null
    : null;
  const alertCount = followedStations.filter((station) => {
    const primary = getPrimaryReading(readingsByStation.get(station.openaq_location_id) || []);
    return isOverThreshold(primary, thresholds);
  }).length;

  const loadDashboard = useCallback(async () => {
    if (!user) return;

    setLoadState("loading");
    setErrorMessage(null);

    const [
      stationsResult,
      readingsResult,
      followsResult,
      thresholdsResult,
      regionFollowsResult,
      regionPreferenceResult,
      runsResult,
    ] = await Promise.all([
      supabase
        .from("stations")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(500),
      supabase
        .from("station_readings")
        .select("station_id,pollutant,value,unit,measured_at,aqi_estimate,aqi_category,updated_at")
        .order("updated_at", { ascending: false }),
      supabase
        .from("user_station_follows")
        .select("*")
        .eq("clerk_user_id", user.id),
      supabase
        .from("user_thresholds")
        .select("*")
        .eq("clerk_user_id", user.id),
      supabase
        .from("user_region_follows")
        .select("*")
        .eq("clerk_user_id", user.id),
      supabase
        .from("user_region_preferences")
        .select("*")
        .eq("clerk_user_id", user.id)
        .maybeSingle(),
      supabase
        .from("worker_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1),
    ]);

    const firstError =
      stationsResult.error ||
      readingsResult.error ||
      followsResult.error ||
      thresholdsResult.error ||
      regionFollowsResult.error ||
      regionPreferenceResult.error ||
      runsResult.error;

    if (firstError) {
      setLoadState("ready");
      setErrorMessage(getConnectionMessage(firstError.message));
      return;
    }

    setStations((stationsResult.data || []) as Station[]);
    setReadings((readingsResult.data || []) as StationReading[]);
    setFollows((followsResult.data || []) as UserStationFollow[]);
    setThresholds((thresholdsResult.data || []) as UserThreshold[]);
    let nextRegionFollows = (
      (regionFollowsResult.data || []) as UserRegionFollow[]
    ).filter(isVisibleRegionFollow);
    if (nextRegionFollows.length === 0) {
      const defaultRegion = getRegionConfig(DEFAULT_REGION_KEY);
      const { data, error } = await supabase
        .from("user_region_follows")
        .upsert(
          {
            clerk_user_id: user.id,
            region_key: defaultRegion.key,
            label: defaultRegion.shortLabel,
            center_lat: defaultRegion.center[0],
            center_lng: defaultRegion.center[1],
            zoom: defaultRegion.zoom,
          },
          { onConflict: "clerk_user_id,region_key" },
        )
        .select("*")
        .single();

      if (error) {
        setLoadState("ready");
        setErrorMessage(getConnectionMessage(error.message));
        return;
      }

      nextRegionFollows = [data as UserRegionFollow];
    }
    setRegionFollows(nextRegionFollows);
    const preference = regionPreferenceResult.data as
      | UserRegionPreference
      | null;
    if (preference?.region_key) {
      setSelectedRegion(getRegionConfig(preference.region_key).key);
    }
    setLatestRun(((runsResult.data || [])[0] as WorkerRun | undefined) || null);
    setLoadState("ready");
  }, [supabase, user]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadDashboard();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadDashboard]);

  useEffect(() => {
    if (!user) return;

    const normalizedQuery = query.trim();

    if (normalizedQuery.length < 2) {
      const resetTimeout = window.setTimeout(() => {
        setSearchState("idle");
        setSearchResults([]);
        setSearchMessage(null);
        setSelectedRegion((current) =>
          current.startsWith("search:") ? DEFAULT_REGION_KEY : current,
        );
      }, 0);

      return () => window.clearTimeout(resetTimeout);
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearchState("loading");
      setSearchResults([]);
      setSearchMessage(null);
      setSelectedStationId(null);

      try {
        const response = await fetch(
          `/api/stations/search?q=${encodeURIComponent(normalizedQuery)}`,
          {
            signal: controller.signal,
          },
        );
        const payload = (await response.json()) as {
          results?: StationSearchResult[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error || "Station search failed.");
        }

        setSearchResults(payload.results || []);
        setSearchState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;

        setSearchState("error");
        setSearchResults([]);
        setSearchMessage(
          error instanceof Error ? error.message : "Station search failed.",
        );
      }
    }, 400);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [query, user]);

  useEffect(() => {
    const channel = supabase
      .channel("airguard-dashboard")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "station_readings",
        },
        (payload) => {
          if (payload.eventType === "DELETE") return;

          const nextReading = payload.new as StationReading;
          setReadings((current) => {
            const withoutCurrent = current.filter(
              (reading) =>
                !(
                  reading.station_id === nextReading.station_id &&
                  reading.pollutant === nextReading.pollutant
                ),
            );

            return [nextReading, ...withoutCurrent];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "worker_runs",
        },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          setLatestRun(payload.new as WorkerRun);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setErrorMessage(null);
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setErrorMessage("Realtime connection paused. Existing dashboard data is still available.");
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  function mergeStation(station: Station) {
    setStations((current) => {
      const withoutStation = current.filter(
        (item) => item.openaq_location_id !== station.openaq_location_id,
      );
      return [station, ...withoutStation];
    });
  }

  function mergeReadings(nextReadings: StationReading[]) {
    setReadings((current) => {
      const next = [...current];

      for (const reading of nextReadings) {
        const index = next.findIndex(
          (item) =>
            item.station_id === reading.station_id &&
            item.pollutant === reading.pollutant,
        );

        if (index >= 0) {
          next[index] = reading;
        } else {
          next.unshift(reading);
        }
      }

      return next;
    });
  }

  async function followStation(stationId: number) {
    if (!user || followedStationIds.has(stationId)) return;

    const { data, error } = await supabase
      .from("user_station_follows")
      .insert({
        clerk_user_id: user.id,
        station_id: stationId,
      })
      .select("*")
      .single();

    if (error) {
      setErrorMessage(getConnectionMessage(error.message));
      throw error;
    }

    setErrorMessage(null);
    setFollows((current) => [data as UserStationFollow, ...current]);
  }

  async function unfollowStation(stationId: number) {
    if (!user) return;

    const { error } = await supabase
      .from("user_station_follows")
      .delete()
      .eq("clerk_user_id", user.id)
      .eq("station_id", stationId);

    if (error) {
      setErrorMessage(getConnectionMessage(error.message));
      return;
    }

    setErrorMessage(null);
    setFollows((current) => current.filter((follow) => follow.station_id !== stationId));
  }

  async function toggleFollow(stationId: number) {
    if (followedStationIds.has(stationId)) {
      await unfollowStation(stationId);
      return;
    }

    await followStation(stationId);
  }

  async function followSearchResult(result: StationSearchResult) {
    const stationId = result.station.openaq_location_id;

    try {
      setImportingStationId(stationId);
      setSearchMessage(null);

      const knownStation = stations.some(
        (station) => station.openaq_location_id === stationId,
      );

      if (!knownStation || result.source === "openaq") {
        const response = await fetch("/api/stations/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ locationId: stationId }),
        });
        const payload = (await response.json()) as {
          station?: Station;
          readings?: StationReading[];
          error?: string;
        };

        if (!response.ok || !payload.station) {
          throw new Error(payload.error || "Station import failed.");
        }

        mergeStation(payload.station);
        mergeReadings(payload.readings || []);
      }

      await followStation(stationId);
      setSelectedStationId(stationId);
    } catch (error) {
      setSearchMessage(
        error instanceof Error
          ? error.message
          : "Station could not be followed.",
      );
    } finally {
      setImportingStationId(null);
    }
  }

  async function saveThreshold(pollutant: string, value: number) {
    if (!user || Number.isNaN(value)) return;

    setSavingPollutant(pollutant);
    const { data, error } = await supabase
      .from("user_thresholds")
      .upsert(
        {
          clerk_user_id: user.id,
          pollutant,
          threshold_value: value,
          enabled: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "clerk_user_id,pollutant" },
      )
      .select("*")
      .single();

    setSavingPollutant(null);

    if (error) {
      setErrorMessage(getConnectionMessage(error.message));
      return;
    }

    setErrorMessage(null);
    setThresholds((current) => {
      const others = current.filter((threshold) => threshold.pollutant !== pollutant);
      return [data as UserThreshold, ...others];
    });
  }

  async function changeRegion(regionKey: string) {
    if (!user) return;

    const region = getRegionConfig(regionKey);
    setSelectedRegion(region.key);
    setSelectedStationId(null);
    setQuery("");

    const { error } = await supabase.from("user_region_preferences").upsert(
      {
        clerk_user_id: user.id,
        region_key: region.key,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "clerk_user_id" },
    );

    if (error) {
      setErrorMessage(getConnectionMessage(error.message));
      return;
    }

    setErrorMessage(null);
  }

  async function saveRegionFollow(region: AirGuardRegion) {
    if (!user || followedRegionKeys.has(region.key)) return;

    setSavingRegionKey(region.key);

    const { data, error } = await supabase
      .from("user_region_follows")
      .upsert(
        {
          clerk_user_id: user.id,
          region_key: region.key,
          label: region.shortLabel,
          center_lat: region.center[0],
          center_lng: region.center[1],
          zoom: region.zoom,
        },
        { onConflict: "clerk_user_id,region_key" },
      )
      .select("*")
      .single();

    setSavingRegionKey(null);

    if (error) {
      setErrorMessage(getConnectionMessage(error.message));
      return;
    }

    setErrorMessage(null);
    setRegionFollows((current) => {
      if (current.some((follow) => follow.region_key === region.key)) {
        return current;
      }

      return [data as UserRegionFollow, ...current];
    });
  }

  async function unfollowRegion(regionKey: string) {
    if (!user) return;

    setSavingRegionKey(regionKey);

    const { error } = await supabase
      .from("user_region_follows")
      .delete()
      .eq("clerk_user_id", user.id)
      .eq("region_key", regionKey);

    setSavingRegionKey(null);

    if (error) {
      setErrorMessage(getConnectionMessage(error.message));
      return;
    }

    setErrorMessage(null);
    setRegionFollows((current) =>
      current.filter((follow) => follow.region_key !== regionKey),
    );
  }

  async function toggleRegionFollow(region: AirGuardRegion) {
    if (followedRegionKeys.has(region.key)) {
      await unfollowRegion(region.key);
      return;
    }

    await saveRegionFollow(region);
  }

  function selectFollowedRegion(region: AirGuardRegion) {
    setSelectedStationId(null);

    if (region.key.startsWith("search:")) {
      setSelectedRegion(region.key);
      setQuery(region.shortLabel);
      return;
    }

    void changeRegion(region.key);
  }

  async function toggleCurrentSearchRegionFollow() {
    if (!canFollowCurrentSearch || !searchCenter) return;

    const region: AirGuardRegion = {
      key: currentSearchRegionKey,
      label: currentSearchRegionLabel,
      shortLabel: currentSearchRegionLabel,
      center: searchCenter,
      zoom: mapZoom,
    };

    await toggleRegionFollow(region);
  }

  function isFollowedRegionSelected(region: AirGuardRegion) {
    if (region.key.startsWith("search:")) {
      return isSearchMode && currentSearchRegionKey === region.key;
    }

    return selectedRegion === region.key && !isSearchMode;
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#020205] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(206,68,255,0.22),transparent_28%),radial-gradient(circle_at_84%_52%,rgba(34,211,238,0.10),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_38%)]" />
      <div className="pointer-events-none fixed inset-0 starfield opacity-70" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1680px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="mb-4 flex flex-col gap-4 rounded-[28px] border border-white/10 bg-white/[0.035] px-4 py-4 shadow-[0_0_80px_rgba(190,60,255,0.10)] backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-full border border-fuchsia-300/30 bg-fuchsia-400/10 shadow-[0_0_34px_rgba(217,70,239,0.55)]">
              <Radio className="h-5 w-5 text-fuchsia-200" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.5em] text-white/45">
                AirGuard
              </div>
              <h1 className="text-2xl font-medium tracking-wide text-white sm:text-[1.7rem]">
                Air Quality Monitor
              </h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-emerald-100">
              <Activity className="h-4 w-4" />
              {getStatusCopy(latestRun)}
            </div>
            <button
              type="button"
              onClick={loadDashboard}
              className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 text-xs font-semibold uppercase tracking-[0.2em] text-white/75 transition hover:border-fuchsia-300/40 hover:text-white"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <UserButton />
          </div>
        </header>

        <section className="mb-4 grid gap-3 md:grid-cols-4">
          <MetricCard
            icon={<Heart className="h-4 w-4" />}
            label="Followed Stations"
            value={followedStations.length.toString()}
          />
          <MetricCard
            icon={<MapPin className="h-4 w-4" />}
            label={isSearchMode ? `${currentSearchRegionLabel} Stations` : `${activeRegion.shortLabel} Stations`}
            value={
              isSearchMode
                ? searchResults.length.toString()
                : visibleMapStations.length.toString()
            }
          />
          <MetricCard
            icon={<BellRing className="h-4 w-4" />}
            label="Threshold Alerts"
            value={alertCount.toString()}
            tone={alertCount > 0 ? "alert" : "normal"}
          />
          <MetricCard
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Realtime"
            value={latestRun?.status === "ok" ? "Online" : "Pending"}
          />
        </section>

        {errorMessage ? (
          <section className="mb-4 flex items-start gap-3 rounded-[22px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100 backdrop-blur">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </section>
        ) : null}

        <section className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_360px]">
          <aside className="order-2 flex min-h-0 flex-col gap-4 xl:order-1">
            <Panel title="Followed Air" icon={<Sparkles className="h-4 w-4" />}>
              {loadState === "loading" ? (
                <LoadingLine label="Loading followed stations" />
              ) : followedStations.length === 0 ? (
                <EmptyState
                  title="No followed stations yet"
                  body="Select a station on the map and follow it to make this homepage personal."
                />
              ) : (
                <div className="space-y-3">
                  {followedStations.slice(0, 8).map((station) => (
                    <StationRow
                      key={station.openaq_location_id}
                      station={station}
                      readings={readingsByStation.get(station.openaq_location_id) || []}
                      thresholds={thresholds}
                      selected={selectedStationId === station.openaq_location_id}
                      onSelect={() => setSelectedStationId(station.openaq_location_id)}
                    />
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Followed Region" icon={<MapPin className="h-4 w-4" />}>
              {loadState === "loading" ? (
                <LoadingLine label="Loading followed regions" />
              ) : followedRegions.length === 0 ? (
                <div className="space-y-3">
                  <EmptyState
                    title="No followed regions"
                    body="Follow Chicago to keep the default monitoring region pinned here."
                  />
                  <RegionRow
                    region={getRegionConfig(DEFAULT_REGION_KEY)}
                    followed={false}
                    selected={selectedRegion === DEFAULT_REGION_KEY && !isSearchMode}
                    saving={savingRegionKey === DEFAULT_REGION_KEY}
                    onSelect={() => void changeRegion(DEFAULT_REGION_KEY)}
                    onToggleFollow={() => void saveRegionFollow(getRegionConfig(DEFAULT_REGION_KEY))}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  {followedRegions.map((region) => (
                    <RegionRow
                      key={region.key}
                      region={region}
                      followed={followedRegionKeys.has(region.key)}
                      selected={isFollowedRegionSelected(region)}
                      saving={savingRegionKey === region.key}
                      onSelect={() => selectFollowedRegion(region)}
                      onToggleFollow={() => void toggleRegionFollow(region)}
                    />
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Thresholds" icon={<Settings2 className="h-4 w-4" />}>
              <div className="space-y-3">
                {Object.entries(DEFAULT_THRESHOLDS).map(([pollutant, fallbackValue]) => {
                  const savedValue = thresholdFor(pollutant, thresholds) ?? fallbackValue;

                  return (
                    <ThresholdControl
                      key={`${pollutant}-${savedValue}`}
                      pollutant={pollutant}
                      defaultValue={savedValue}
                      saving={savingPollutant === pollutant}
                      onSave={saveThreshold}
                    />
                  );
                })}
              </div>
            </Panel>
          </aside>

          <section className="order-1 min-h-[520px] overflow-hidden rounded-[30px] border border-white/10 bg-black/30 p-2 shadow-[0_0_120px_rgba(97,24,179,0.24)] xl:order-2">
            <div className="relative h-full">
              {activeMapStations.length === 0 && loadState !== "loading" ? (
                <div className="flex h-full min-h-[520px] items-center justify-center rounded-[24px] border border-white/10 bg-black/40 text-center">
                  <EmptyState
                    title={
                      isSearchMode
                        ? "No fresh PM2.5 search points"
                        : "No fresh PM2.5 map points"
                    }
                    body={
                      isSearchMode
                        ? "Try a different US city or broaden the spelling."
                        : "Search a US city and follow a fresh PM2.5 station, or wait for the worker to refresh this region."
                    }
                  />
                </div>
              ) : (
                <AirQualityMap
                  key={mapKey}
                  stations={activeMapStations}
                  readingsByStation={activeReadingsByStation}
                  followedStationIds={followedStationIds}
                  thresholds={thresholds}
                  selectedStationId={selectedStationId}
                  center={mapCenter}
                  zoom={mapZoom}
                  onSelectStation={setSelectedStationId}
                />
              )}

              <div className="pointer-events-none absolute left-4 top-4 rounded-full border border-white/10 bg-black/60 px-4 py-2 text-xs uppercase tracking-[0.22em] text-white/60 backdrop-blur">
                {isSearchMode ? `${normalizedQuery} Search` : `${activeRegion.shortLabel} Discovery`}
              </div>
            </div>
          </section>

          <aside className="order-3 flex min-h-0 flex-col gap-4">
            <Panel title="Station Search" icon={<Search className="h-4 w-4" />}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search any US city"
                  className="h-11 w-full rounded-full border border-white/10 bg-white/[0.06] pl-10 pr-4 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-fuchsia-300/50"
                />
              </div>

              <div className="mt-3 space-y-2">
                {query.trim().length < 2 ? (
                  <p className="text-xs leading-5 text-white/35">
                    Search any US city to find fresh PM2.5 stations.
                  </p>
                ) : searchState === "loading" ? (
                  <LoadingLine label="Searching PM2.5 stations" />
                ) : searchMessage ? (
                  <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">
                    {searchMessage}
                  </div>
                ) : searchResults.length === 0 && searchState === "ready" ? (
                  <p className="text-xs leading-5 text-white/35">
                    No fresh PM2.5 stations found within 25 km.
                  </p>
                ) : (
                  <div className="rounded-2xl border border-cyan-200/15 bg-cyan-300/10 px-3 py-2 text-xs leading-5 text-cyan-100">
                    {searchResults.length} fresh PM2.5 stations on map
                  </div>
                )}

                {canFollowCurrentSearch ? (
                  <button
                    type="button"
                    onClick={() => void toggleCurrentSearchRegionFollow()}
                    disabled={savingRegionKey === currentSearchRegionKey}
                    className={`flex h-11 w-full items-center justify-center gap-2 rounded-full border text-sm font-semibold uppercase tracking-[0.18em] transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      currentSearchRegionFollowed
                        ? "border-fuchsia-300/35 bg-fuchsia-300/15 text-fuchsia-100"
                        : "border-white/10 bg-white/[0.04] text-white/70 hover:border-fuchsia-300/40 hover:text-fuchsia-100"
                    }`}
                  >
                    {savingRegionKey === currentSearchRegionKey ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Heart className={`h-4 w-4 ${currentSearchRegionFollowed ? "fill-current" : ""}`} />
                    )}
                    {currentSearchRegionFollowed
                      ? `Following ${currentSearchRegionLabel}`
                      : `Follow ${currentSearchRegionLabel}`}
                  </button>
                ) : null}
              </div>
            </Panel>

            <Panel title="Selected Station" icon={<MapPin className="h-4 w-4" />}>
              {selectedStation ? (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-medium tracking-wide text-white">
                      {selectedStation.name}
                    </h2>
                    <p className="mt-1 text-sm text-white/45">
                      {[selectedStation.locality, selectedStation.region, selectedStation.provider]
                        .filter(Boolean)
                        .join(" | ") || "OpenAQ monitoring station"}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (
                        selectedSearchResult &&
                        !followedStationIds.has(selectedStation.openaq_location_id)
                      ) {
                        void followSearchResult(selectedSearchResult);
                        return;
                      }

                      void toggleFollow(selectedStation.openaq_location_id);
                    }}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-fuchsia-300/30 bg-fuchsia-300/10 text-sm font-semibold uppercase tracking-[0.2em] text-fuchsia-100 transition hover:bg-fuchsia-300/20"
                  >
                    {importingStationId === selectedStation.openaq_location_id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Heart className="h-4 w-4" />
                    )}
                    {importingStationId === selectedStation.openaq_location_id
                      ? "Following"
                      : followedStationIds.has(selectedStation.openaq_location_id)
                      ? "Following"
                      : "Follow Station"}
                  </button>

                  <div className="grid grid-cols-2 gap-3">
                    {selectedReadings.length === 0 ? (
                      <EmptyState
                        title="No recent readings"
                        body="The next worker poll will refresh this station."
                      />
                    ) : (
                      selectedReadings.slice(0, 6).map((reading) => (
                        <ReadingTile
                          key={`${reading.station_id}-${reading.pollutant}`}
                          reading={reading}
                          alert={isOverThreshold(reading, thresholds)}
                        />
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <EmptyState
                  title="Select a station"
                  body="Click any marker to inspect current pollutant readings."
                />
              )}
            </Panel>
          </aside>
        </section>
      </div>
    </main>
  );
}

function MetricCard({
  icon,
  label,
  value,
  tone = "normal",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "normal" | "alert";
}) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/[0.045] p-4 backdrop-blur">
      <div className="flex items-center justify-between text-white/45">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-[0.24em]">
          {label}
        </span>
      </div>
      <div
        className={`mt-3 text-3xl font-light tracking-wide ${
          tone === "alert" ? "text-rose-200" : "text-white"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.045] p-4 backdrop-blur">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-white/55">
          {icon}
          {title}
        </div>
      </div>
      {children}
    </section>
  );
}

function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-white/50">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-6 text-center">
      <div className="text-sm font-medium text-white/80">{title}</div>
      <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-white/42">{body}</p>
    </div>
  );
}

function RegionRow({
  region,
  followed,
  selected,
  saving,
  onSelect,
  onToggleFollow,
}: {
  region: AirGuardRegion;
  followed: boolean;
  selected: boolean;
  saving: boolean;
  onSelect: () => void;
  onToggleFollow: () => void;
}) {
  return (
    <div
      className={`flex min-h-14 items-center gap-2 rounded-2xl border p-2 transition ${
        selected
          ? "border-fuchsia-300/40 bg-fuchsia-300/10"
          : "border-white/10 bg-black/20 hover:border-white/20"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 px-2 py-1 text-left"
      >
        <div className="truncate text-sm font-medium text-white">
          {region.shortLabel}
        </div>
        <div className="mt-1 truncate text-xs text-white/38">
          {selected ? "Viewing" : region.label}
        </div>
      </button>
      <button
        type="button"
        aria-label={followed ? `Unfollow ${region.shortLabel}` : `Follow ${region.shortLabel}`}
        onClick={onToggleFollow}
        disabled={saving}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-60 ${
          followed
            ? "border-fuchsia-300/35 bg-fuchsia-300/15 text-fuchsia-100"
            : "border-white/10 bg-white/[0.03] text-white/38 hover:border-fuchsia-300/35 hover:text-fuchsia-100"
        }`}
      >
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Heart className={`h-4 w-4 ${followed ? "fill-current" : ""}`} />
        )}
      </button>
    </div>
  );
}

function StationRow({
  station,
  readings,
  thresholds,
  selected,
  onSelect,
}: {
  station: Station;
  readings: StationReading[];
  thresholds: UserThreshold[];
  selected: boolean;
  onSelect: () => void;
}) {
  const primary = getPrimaryReading(readings);
  const alert = isOverThreshold(primary, thresholds);
  const color = getAqiColor(primary?.aqi_category);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border p-3 text-left transition ${
        selected
          ? "border-fuchsia-300/40 bg-fuchsia-300/10"
          : "border-white/10 bg-black/20 hover:border-white/20"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">{station.name}</div>
          <div className="mt-1 truncate text-xs text-white/40">
            {station.provider || station.locality || "OpenAQ"}
          </div>
        </div>
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-black"
          style={{ backgroundColor: color }}
        >
          {primary?.aqi_estimate ?? formatReadingValue(primary)}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-white/45">
        <span>{primary ? primary.aqi_category : "No data"}</span>
        {alert ? (
          <span className="flex items-center gap-1 text-rose-200">
            <AlertTriangle className="h-3 w-3" />
            Alert
          </span>
        ) : null}
      </div>
    </button>
  );
}

function ReadingTile({
  reading,
  alert,
}: {
  reading: StationReading;
  alert: boolean;
}) {
  const color = getAqiColor(reading.aqi_category);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
          {POLLUTANT_LABELS[reading.pollutant] || reading.pollutant}
        </span>
        {alert ? <AlertTriangle className="h-4 w-4 text-rose-200" /> : null}
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-light" style={{ color }}>
          {formatReadingValue(reading)}
        </span>
        <span className="pb-1 text-xs text-white/45">{reading.unit}</span>
      </div>
      <div className="mt-2 text-xs text-white/35">
        {formatMeasuredAt(reading.measured_at)}
      </div>
    </div>
  );
}

function ThresholdControl({
  pollutant,
  defaultValue,
  saving,
  onSave,
}: {
  pollutant: string;
  defaultValue: number;
  saving: boolean;
  onSave: (pollutant: string, value: number) => void;
}) {
  const [value, setValue] = useState(defaultValue.toString());

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.22em] text-white/55">
          {pollutant === "pm25"
            ? `${POLLUTANT_LABELS[pollutant]} AQI`
            : POLLUTANT_LABELS[pollutant] || pollutant}
        </span>
        <span className="text-xs text-white/35">Alert score</span>
      </div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="decimal"
          className="h-10 min-w-0 flex-1 rounded-full border border-white/10 bg-white/[0.06] px-3 text-sm text-white outline-none focus:border-fuchsia-300/50"
        />
        <button
          type="button"
          onClick={() => onSave(pollutant, Number(value))}
          className="flex h-10 w-20 items-center justify-center rounded-full bg-white text-xs font-bold uppercase tracking-[0.16em] text-black transition hover:bg-fuchsia-100"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </button>
      </div>
    </div>
  );
}
