# AirGuard Architecture

## Product

AirGuard is a personalized realtime air quality monitor. Users sign in with Clerk, follow OpenAQ monitoring stations, set pollutant thresholds, and see live readings update on a dark interactive map.

## System Architecture

The system follows the assignment architecture:

1. OpenAQ provides external air quality station and measurement data.
2. The Railway worker in `apps/worker` polls OpenAQ on a fixed interval.
3. The worker normalizes station metadata and latest pollutant readings.
4. Supabase stores stations, readings, user follows, user thresholds, and worker run status.
5. Supabase Realtime publishes changes from `station_readings` and `worker_runs`.
6. The Vercel frontend in `apps/web` renders the Clerk-protected dashboard and subscribes to realtime updates.

## Data Model

- `stations`: OpenAQ location metadata, coordinates, provider, country, and active status.
- `station_readings`: latest normalized pollutant readings per station and pollutant, including measured time, estimated AQI, and AQI category.
- `user_station_follows`: Clerk user IDs mapped to followed stations.
- `user_region_follows`: Clerk user IDs mapped to followed regions, including Chicago and cities saved from station search.
- `user_region_preferences`: Clerk user IDs mapped to the currently selected dashboard region.
- `user_thresholds`: Clerk user IDs mapped to pollutant threshold preferences.
- `worker_runs`: poll status, timestamps, counts, and error messages.

## Security

The frontend uses only public Supabase configuration. The Supabase service role key is only used by the worker.

Row Level Security is enabled on all public tables:

- Authenticated users can read public station and reading data.
- Users can only read and mutate their own follows and thresholds.
- The worker writes through the service role key and bypasses RLS.

Clerk user identity is expected in Supabase JWT claims through the native Clerk/Supabase third-party auth integration. RLS policies compare `auth.jwt()->>'sub'` to the stored Clerk user ID.

## Worker

The worker reads:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAQ_API_KEY`

It polls a capped Chicago station set, prioritizes user-followed stations from any searched city, upserts station metadata, upserts latest readings, and records each run in `worker_runs`.

## Frontend

The frontend reads:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

The homepage is the product experience:

- Signed-out users see a dark AirGuard sign-in screen.
- Signed-in users see their followed stations, threshold alerts, realtime worker status, station search, selected-station details, and a large map.
- Chicago is the default followed region. Users can follow searched cities as regions and follow individual stations from those cities.
- The map uses AQI-colored circular station markers and updates as Supabase Realtime events arrive.

## Deployment

- Deploy `apps/web` to Vercel.
- Deploy `apps/worker` to Railway.
- Copy the same required environment variables into each platform dashboard.
- Run the worker after deployment to seed station data before classmates test the app.
