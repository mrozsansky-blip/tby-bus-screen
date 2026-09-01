# TBY Bus Screen

Custom student bus display for Tiferes Bais Yaakov.

## How it works

The live student screens and office control panel read and write a **Turso**
(SQLite) database — that's the source of truth for the school day. Airtable
is used two ways:

- **Route roster** — the `Bus Routes` table (in the `TBY School Management`
  base) is the source of truth for which routes exist. Use the "Sync routes
  from Airtable" button on `/setup.html` (or `POST
  /api/admin/sync-airtable-routes`) to pull the current school year's routes
  into Turso. Re-run it any time the roster changes; it's safe to run
  repeatedly. See `SETUP-NOTES.md` for exactly how Airtable fields map to
  routes.
- **Nightly history export** — once a day, a cron job copies the day's
  status events out of Turso into two Airtable tables, `Bus Route Event Log`
  and `Bus Daily Status`, so the office has a permanent, searchable record.
  This is one-way (Turso → Airtable); editing those tables does not affect
  the live screens.

Parking spots have no Airtable source — they're entered once via
`/setup.html`.

## Pages

- `/from-school` - regular From School dismissal routes
- `/pri-dismissal` - PRI dismissal routes
- `/friday-dismissal` - Friday dismissal routes
- `/current` - automatically picks the right screen based on the day/time
- `/office/from-school`, `/office/pri-dismissal`, `/office/morning`,
  `/office/friday-dismissal` - office control panels (PIN-protected)
- `/setup.html` - one-time/occasional admin tools: import routes & parking
  spots directly, or sync routes from Airtable (admin-secret protected)

## Deploying (Vercel)

This repo deploys as a single Vercel serverless function (`api/index.js`
wraps the Express app in `server.js`); `vercel.json` rewrites every request
to it and defines the nightly export cron. Import the GitHub repo into a new
Vercel project — no build step is required.

## Environment variables

Set these in the Vercel project settings (Project → Settings →
Environment Variables), not in GitHub:

```text
TURSO_DATABASE_URL=your Turso database URL
TURSO_AUTH_TOKEN=your Turso auth token
OFFICE_PIN=PIN for the office control panel
ADMIN_SECRET=secret for /api/admin/* routes (setup.html, sync, import)
CRON_SECRET=secret the nightly export cron authenticates with
AIRTABLE_TOKEN=your Airtable personal access token
AIRTABLE_BASE_ID=appYCWLjqODndV4n2
```

Optional environment variables:

```text
SCHOOL_TIME_ZONE=America/New_York
AIRTABLE_SCHOOL_YEARS_TABLE_NAME=School Years
AIRTABLE_BUS_ROUTES_TABLE_NAME=Bus Routes
AIRTABLE_EVENT_LOG_TABLE_NAME=Bus Route Event Log
AIRTABLE_DAILY_STATUS_TABLE_NAME=Bus Daily Status
```

All of the above are required once the app runs in production (`VERCEL=1`);
locally, missing secrets just relax auth checks instead of failing closed.

## Status colors

- Waiting: gray
- Arrived: yellow
- Loading: blue
- Ready to Board: green
- Departed: dark gray
- Delayed: orange
- Cancelled: red

## Local development

```bash
npm install
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm start
```

Then open:

```text
http://localhost:3000/current
```
