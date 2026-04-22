import { auth } from "@clerk/nextjs/server";
import {
  searchLocalStations,
  searchOpenAqStations,
  type StationSearchResult,
} from "../../../lib/airguard-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();

  if (query.length < 2) {
    return Response.json({ results: [] });
  }

  try {
    const [localResults, openAqResults] = await Promise.all([
      searchLocalStations(query),
      searchOpenAqStations(query),
    ]);
    const seen = new Set<number>();
    const results: StationSearchResult[] = [];

    for (const result of [...localResults, ...openAqResults]) {
      const stationId = result.station.openaq_location_id;
      if (seen.has(stationId)) continue;

      seen.add(stationId);
      results.push(result);
    }

    return Response.json({ results: results.slice(0, 10) });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Station search failed.",
      },
      { status: 500 },
    );
  }
}
