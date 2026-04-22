# AGENTS.md

## Product

AirGuard is a personalized realtime air quality monitor.

Users sign in, follow air quality monitoring stations, set pollutant thresholds, and watch station readings update live as a Railway worker polls OpenAQ and writes to Supabase.

## Architecture

AirGuard must satisfy the assignment architecture:

- `apps/web`: Next.js + Tailwind frontend on Vercel.
- `apps/worker`: Node.js polling worker on Railway.
- OpenAQ is the external live data source.
- Supabase stores stations, readings, favorites, thresholds, and worker status.
- Supabase Realtime powers live frontend updates.
- Clerk handles authentication.
- User personalization is stored in Supabase and protected with RLS through the native Clerk/Supabase third-party auth integration.
- The dashboard defaults to Chicago; users can search other US cities, follow searched cities as regions, and follow individual stations without trying to render the entire United States.

## Design Direction

The UI should feel close to the Sansara reference: dark, premium, quiet, atmospheric, and precise.

Use:

- Near-black surfaces.
- Violet, magenta, cyan, and air-quality status colors as accents.
- Sparse typography.
- Soft glows and subtle motion where they support the product.
- A polished operational dashboard, not a generic landing page.

The map should take inspiration from dense AQI dashboards:

- Large interactive map as the main surface.
- Colored circular station markers.
- AQI or pollutant values inside markers when useful.
- Chicago as the default monitoring region, with city search for discovering and following regions elsewhere.
- A compact side panel for selected station details.
- Favorites, thresholds, and realtime status visible without clutter.

Do not overbuild decorative sections. The first screen should be the product.

## Implementation Preferences

Prefer simple, robust choices:

- Use `react-leaflet` or a similar proven map library.
- Use Supabase client subscriptions for realtime station reading updates.
- Keep the worker resilient: log errors, continue polling, and upsert normalized data.
- Keep UI state understandable and easy to test.
- Avoid service role keys in frontend code.

For Next.js work:

- This project uses a recent Next.js version. Check local docs in `node_modules/next/dist/docs/` when using APIs that may have changed.
- Prefer client components only where interactivity or browser APIs are required.
- Keep data access and realtime client code separated into small reusable helpers.

## Environment Variables

Frontend:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

Worker:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAQ_API_KEY`

Never commit real secrets.

## Quality Bar

Before completion, verify:

- Clerk sign-in works.
- The worker writes OpenAQ data into Supabase.
- Realtime updates appear in the frontend without refresh.
- Users can save stations and thresholds.
- User-specific data is protected by RLS.
- Vercel and Railway deployments work end to end.
