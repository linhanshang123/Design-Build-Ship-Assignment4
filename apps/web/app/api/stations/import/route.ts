import { auth } from "@clerk/nextjs/server";
import {
  createServiceClient,
  loadOpenAqStationWithPm25,
} from "../../../lib/airguard-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    locationId?: unknown;
  } | null;
  const locationId = Number(body?.locationId);

  if (!Number.isFinite(locationId)) {
    return Response.json({ error: "Invalid station id." }, { status: 400 });
  }

  try {
    const { station, readings } = await loadOpenAqStationWithPm25(locationId);
    const supabase = createServiceClient();

    const { error: stationError } = await supabase
      .from("stations")
      .upsert(station, { onConflict: "openaq_location_id" });

    if (stationError) throw stationError;

    const { error: readingsError } = await supabase
      .from("station_readings")
      .upsert(
        readings.map((reading) => ({
          ...reading,
          source_payload: {},
        })),
        { onConflict: "station_id,pollutant" },
      );

    if (readingsError) throw readingsError;

    return Response.json({ station, readings });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Station import failed.",
      },
      { status: 500 },
    );
  }
}
