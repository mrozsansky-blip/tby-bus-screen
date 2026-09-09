# Airtable → Turso route sync notes

`POST /api/admin/sync-airtable-routes` (admin-secret protected; button on
`/setup.html`) reads the `Bus Routes` table in the `TBY School Management`
Airtable base (`appYCWLjqODndV4n2`) and upserts matching rows into Turso's
`routes` table. It only looks at routes linked to whichever `School Years`
record has `Is Current Year` checked. Re-running it is safe — it's an
upsert keyed by a slug of the route name, and any route that was previously
synced from Airtable but no longer appears in the current pull gets marked
inactive (routes added by hand via `/setup.html` are never touched by this).

Field mapping:

| Airtable (`Bus Routes`)             | Turso (`routes`)                          |
| ------------------------------------ | ------------------------------------------ |
| `Route Name`                         | `route_code`, and `id` (slugified)         |
| `Bus Color` (falls back to Route Name if blank) | `display_name` — what students see |
| `Bus Color`                          | `color`                                    |
| `Bus Company`                        | `company`                                  |
| record id                            | `airtable_record_id` (links nightly exports back to this record) |

Screen assignment (`workflow_type` / `active`):

| `AM / PM` | `Primary Dismissal`  | Result                                          |
| --------- | --------------------- | ------------------------------------------------ |
| `AM`      | (any)                  | `To School Arrival Only` (morning screen), active |
| `PM`      | `Regular dismissal`   | `From School Dismissal`, active                   |
| `PM`      | `Primary dismissal`   | `PRI Dismissal`, active                           |
| `PM`      | `Other`, `Early dismissal`, blank | imported **inactive**, flagged in the sync response |
| `Both` or anything unexpected        | imported **inactive**, flagged             |

Two things this sync deliberately does **not** do, both by explicit choice
when this was set up:

- **Friday dismissal** — Airtable has no field for this today, so every
  synced route gets `use_friday = false`. If some routes also run on the
  Friday early-dismissal screen, flip that per-route (via `/setup.html`'s
  JSON import, or the `/api/admin/import` endpoint) after syncing.
- **"Early dismissal"** — that choice exists on the `Primary Dismissal`
  field but isn't expected to be used by any real route. If a route ever
  gets flagged with it, that's a data-entry slip in Airtable worth fixing at
  the source, not a mapping this sync should guess at.

Parking spots have no Airtable table at all — they're entered once via
`/setup.html`'s JSON import.

# "Text Parents" notices

Clicking "Text Parents" on a route (every dismissal screen - from-school,
PRI, Friday; **not** shown on `/office/morning`, which is waiting for buses
to arrive rather than dismissing them) opens a picker of message templates
and sends whichever one staff choose. There's no fixed set of messages in
code - templates are rows in the `text_templates` table, managed on
`/setup.html`'s "Text templates" section (add/edit/delete, an active
checkbox to hide one from the picker without losing it). A template's
`body` can reference `{name}` (the route's `display_name` - a bus color for
PM routes, a route code like `TBY1` for AM routes) and `{time}` (the route's
recorded `daily_status.departure_time` for that screen/service-date,
formatted in `SCHOOL_TIME_ZONE` - not the moment staff click the template,
so it still reads right if the button gets pressed a few minutes late; falls
back to the current time when the bus hasn't been marked Departed yet, e.g.
for the "Not Here Yet" template. Resolved in `previewBusNotice()` and frozen
into the message right there via `renderTemplate()`, so what's shown in the
confirm dialog is exactly what sends). Two templates seed automatically the
first time the app runs (`seedDefaultTextTemplates()`, a one-time check —
deleting them on purpose doesn't bring them back):

- **Bus Left**: `TBY {name}: {name} left school at {time}.`
- **Not Here Yet**: `TBY {name}: Your bus has not yet arrived at school. We
  will text you when it departs.` For a delayed dismissal bus that hasn't
  shown up at school yet to pick up students.

`previewBusNotice()`/`sendBusNotice()` (behind `GET /api/office/templates`
for the picker list and `/api/office/route/:id/notify/preview` +
`/notify/send`) take a `templateId` instead of a fixed message. Every actual
send (not preview) is logged to `text_log` - service date, screen, route,
template name, the exact rendered message, and recipient/failure counts.
That log backs two on-page things only: the button turns green ("texted")
once any template has been sent to that route today (with a note showing
the last message and recipient count), and the template picker warns
("⚠ Already sent to this bus today at ...") if the *same* template was
already sent today for that route, via `GET
/api/office/route/:id/sent-templates-today` - a duplicate-send guard, not a
history browser. Editing or deleting a template never affects past
`text_log` rows, since the log copies the rendered name and message in
directly rather than referencing the template row.

The picker also has a "custom message" box below the template list, for the
one-off case that doesn't deserve a saved template - it goes through the
same preview → confirm → send flow and the same `{name}`/`{time}`
substitution, just with `customMessage` in place of `templateId`
(`previewBusNotice()`'s third argument). It isn't covered by the
duplicate-send guard (there's no template id to check against) and logs to
`text_log` with `template_id = NULL`, `template_name = 'Custom message'`.

There's deliberately no "view all sent texts" page here - the office
tablets run in kiosk mode with no way back to a different page, and the
real, authoritative send history already lives in `tby-texting-system`
itself: every send is a genuine campaign there (`message_campaigns`, not
just an SMS API call), named recognizably (e.g. "TBY Red: Bus Left" - see
`sendBusNotice()`'s `label`) so staff can look it up in that app's own
`/campaigns` or `/broadcasts` pages, with real delivery status per
recipient.

Neither the picker nor the send itself resolves parent phone numbers - it
calls the `tby-texting-system` app's
`/api/mcp` endpoint (`TEXTING_SYSTEM_URL` / `TEXTING_MCP_AUTH_TOKEN`) and
asks it to text that route's assigned families. Who a route targets is
resolved in `busDepartureRouteInfo()`, in this order:

1. **By Airtable Bus Routes record id (the normal case)** — `routes.airtable_record_id`
   is passed to the texting app's `preview_bus_route_sms_send` /
   `send_bus_route_sms` MCP tools, which resolve it against **its own**
   synced `bus_routes` / `student_transportation` tables (populated by that
   app's Transportation sync at `/sync` — Families sync, then Students sync,
   then Transportation sync, in that order) and text everyone currently
   assigned to that route. Both apps sync the same Airtable `Bus Routes`
   table and store its record id, so this needs no name-matching at all —
   it just works once a route is synced here (`/api/admin/sync-airtable-routes`)
   **and** Transportation sync has been run over there. If the texting app
   reports "No synced bus route matches...", that's the sync to check.
2. **`routes.texting_group_name`, if pinned** — an explicit override to a
   named contact group instead, set via `/setup.html`'s "Match routes to
   texting groups" table (`GET /api/admin/texting-groups` reads the real
   group names live from `tby-texting-system`'s `list_contact_groups` MCP
   tool; `POST /api/admin/route/:id/texting-group`, body `{ groupName }`,
   sets or clears the pin — a plain column, untouched by Airtable sync or
   JSON import). Use this only for the odd route that has no Airtable link,
   or that should go to a hand-picked contact group instead of its assigned
   families. When a pin is set it takes priority over the Airtable match.

Earlier revisions of this feature tried to match by a *computed* contact-group
name (`"AM · TBY1"`, `"3:45 – Maroon"`, etc.) — that turned out to target the
wrong thing: those strings are labels the texting app's own "Bus routes"
campaign-builder audience type computes on the fly, not real `contact_groups`
rows, so the match always failed. Bus-route texting now goes through the
Airtable-record-id path above instead; `texting_group_name` still exists, but
only as the manual per-route override in case 2.

# Office view fixes (arrival/departure times, screen overflow, public-screen override)

Three unrelated `/office/*` bugs, fixed together:

- **Arrival/departure times looked blank on Arrived/Loading/Departed cards.**
  The data was always there (`daily_status.arrival_time`/`departure_time`) -
  it just rendered invisibly, because `.route-card.arrived/.loading/.departed`
  paint the whole card a solid status color with white text, but the Arr/Dep
  time boxes (`.time-grid`) kept their light-gray background and default
  text color: white-on-near-white. Fixed in `office.css` by giving those
  boxes a translucent-white background and explicit white text under each
  status class, matching the pattern already used for `.spot-row span`.
- **Route cards clipped off the right edge of the screen**, office view only.
  `.route-grid` normally uses `repeat(auto-fit, minmax(270px, 1fr))`, which
  never overflows - but a `@media (min-width: 1500px)` rule forced exactly
  6 columns (`repeat(6, minmax(270px, 1fr))`), which needs ~1690px of real
  width to fit without overflowing. Any screen between 1500-1690px wide
  (common for office monitors, especially scaled displays) got cards wider
  than the viewport, silently clipped by `overflow-x: hidden` on `body`.
  Removed the override; `auto-fit` already adds columns as space allows.
- **The public-screen override was too easy to hit by mistake.** Its four
  buttons (Auto/From School/PRI/Friday) look almost identical to the office
  tabs at the top of the page, but do something very different - they
  override what the *public* dismissal screen in the hallway shows everyone,
  until midnight, not just this tablet's view. Now collapsed behind a
  "Change public screen…" toggle (closed by default) and a `window.confirm`
  naming exactly what's about to change before it applies.

- **`/office/morning` only offers Waiting/Arrived**, not the full
  Waiting/Arrived/Loading/Departed set - a bus either hasn't shown up to
  drop off students or it has, there's no loading/departing on that screen.
  Enforced in both places: `renderStatusButtons()` picks `MORNING_STATUS_ORDER`
  instead of `STATUS_ORDER` when `currentScreen === 'morning'`, and
  `setRouteStatus()` rejects any other status server-side for that screen
  (so a stale cached page, or a direct API call, can't set one either).
- **Marking a dismissal bus Arrived no longer requires a parking spot
  first.** `setRouteStatus()` used to throw ("Choose a parking spot before
  marking this bus arrived.") unless a spot was already picked - staff can
  now mark Arrived right away and assign the spot after, via the same spot
  dropdown (`setRouteSpot()`, unaffected by status).

# Custom text messages

The "Text Parents" picker has a free-text box below the template list for a
one-off message that doesn't need a saved template - see the "Text Parents"
notices section above.

# Bulletin screen

`/bulletin` shows one uploaded image or PDF full-screen (announcements, a
lunch menu, a flyer, etc) instead of the bus grid. It's managed from
`/office/bulletin` - PIN-protected like the other office pages, but
deliberately not on `/setup.html`, so any staff member with the office PIN
can update it, not just whoever holds the admin secret. That page shows
what's currently live and lets staff upload a replacement (image or PDF, up
to 4MB) or remove it entirely. Only one file is ever live at a time -
uploading a new one replaces it.

**Display schedule** (`computeScheduledScreen()` in `server.js`, times in
`SCHOOL_TIME_ZONE`):

| Day | Bulletin | Then |
| --- | --- | --- |
| Mon-Thu | until 2:15 PM | PRI Dismissal until 3:30 PM, then From School Dismissal |
| Fri | until 11:00 AM | Friday Dismissal |

This runs on `/current` automatically, the same as the from-school/PRI/Friday
switch already did. The office can also force the public screen to Bulletin
at any other time via the "Change public screen…" override on any
`/office/*` page (it's `bulletin` alongside the existing Auto/From
School/PRI/Friday choices there) - same as forcing any other screen, it
resets at midnight.

**Storage.** The file itself lives in Vercel Blob storage, not Turso - only
a pointer (URL + metadata) is stored here (`bulletin_screen` table: URL,
pathname, filename, mime type, size, upload time).

- **Upload** - `POST /api/office/bulletin/upload` (PIN-protected via
  `x-office-pin`) takes the raw file bytes as its request body
  (`express.raw()`, `Content-Type` = the file's real MIME type,
  `x-filename` = the original filename, URI-encoded) and PUTs them to Blob
  storage itself, server-side, via `put()`. `office-bulletin.html` sends the
  file with `XMLHttpRequest` (used specifically for its upload-progress
  events, which `fetch` doesn't expose) rather than any Blob SDK on the
  client - the browser talks only to this app's own domain, never to
  Vercel's infrastructure directly.

  This wasn't the original design. Two earlier attempts had the office
  browser PUT the file straight to Vercel Blob storage instead (first
  `@vercel/blob`'s client-token flow, then its OIDC-compatible presigned-URL
  flow), which would have allowed a 25MB limit instead of today's 4MB. Both
  failed identically on the school's network: `net::ERR_ALPN_NEGOTIATION_
  FAILED` against `vercel.com` (both flows' browser-to-storage `PUT`, it
  turns out, actually routes through `vercel.com`'s control API regardless
  of auth method - `@vercel/blob`'s `requestApi()` always targets
  `defaultVercelBlobApiUrl = "https://vercel.com/api/blob"` unless
  overridden via `VERCEL_BLOB_API_URL`). That's a TLS-level failure that
  persisted even after `vercel.com` was allow-listed on the school's
  network, consistent with the network doing HTTPS/SSL inspection that
  specifically breaks ALPN negotiation for that host - not something fixable
  from this app's code, and not something a plain website allow-list
  resolves (that needs a specific SSL/TLS-decryption bypass for the host,
  a separate setting in most content-filtering products). Routing the
  upload through this server instead sidesteps the whole problem: the
  browser only ever talks to this app's own domain (already known to work),
  and this server's own outbound call to Vercel's API is unaffected by the
  school's network entirely. The trade-off is `BULLETIN_MAX_BYTES` - Vercel
  Functions hard-cap request bodies at 4.5MB, so the limit is set to 4MB to
  leave headroom for HTTP overhead on top of the raw file bytes.

  A small middleware checks the PIN *before* `express.raw()` runs, so a
  request with a bad PIN is rejected before its body is even read, rather
  than after buffering up to `BULLETIN_MAX_BYTES` of a request nobody's
  going to use. `express.raw()`'s own `limit` throws if a request turns out
  larger than that regardless of the PIN check; a small error-handling
  middleware at the bottom of `server.js` turns that into the same JSON
  error shape as every other endpoint, instead of Express's default HTML
  error page.

  Uploading a new file deletes the previous one from Blob storage (`del()`),
  since only one is ever live.
- **Display** - the public `/bulletin` page (and `/current`, when it
  resolves to bulletin) reads the pointer from `GET /api/bulletin` (no PIN -
  it's the same public endpoint the office page's "current file" panel
  reads, and the Blob URL it returns is already a public CDN link with
  nothing sensitive in it) and points an `<img>`/`<embed>` straight at that
  URL - Vercel's CDN serves it directly, not this app.

Both `put()` and `del()` go through `@vercel/blob`'s `resolveBlobAuth()`,
which works with either an OIDC-connected store (`BLOB_STORE_ID` - what
connecting a store adds by default now) or a static `BLOB_READ_WRITE_TOKEN`,
since both are calls this *server* makes, not the browser.

# Morning arrival report

`/office/morning-report` shows every AM ("To School Arrival Only") route for
a service day, split into buses that have arrived (earliest first, with
their arrival time and bus company) and ones still Waiting. It's a plain
read-only view - `fetchMorningArrivalReport(serviceDate)` in `server.js`
calls the shared `fetchRouteTimeReport(screen, serviceDate, timeColumn)`
helper (also used by the afternoon report below) which reuses the same
`daily_status` rows the live `/office/morning` board writes, it doesn't add
any new tracking. Defaults to today; pass `?date=YYYY-MM-DD` (the page's own
date picker does this) to see a past day instead - for a past date it only
reads what's already in `daily_status`, it doesn't backfill Waiting rows the
way today's report does via `ensureDailyStatus`.

Two JSON endpoints share that same function:

- `GET /api/office/morning-report` - PIN-protected (`x-office-pin`), used by
  the page above.
- `GET /api/reports/morning-arrivals` - protected instead by
  `MORNING_REPORT_SECRET` (checked the same way `CRON_SECRET` is: an
  `Authorization: Bearer <secret>` header, an `x-report-secret` header, or a
  `?secret=` query param). Optional, general-purpose - a way to pull the
  report from outside the office UI (a spreadsheet, another script) without
  the office PIN. Not required for the daily email below, which calls
  `fetchMorningArrivalReport()` directly rather than going over HTTP.

# Afternoon dismissal report

`/office/afternoon-report` is the PM counterpart - one section per dismissal
screen that actually ran that service day, each split into routes that have
departed (earliest first, with departure time and company) and ones still
Waiting. Which screens run is `isFridayServiceDate(serviceDate)` in
`server.js`: **PRI Dismissal + From School Dismissal** on Mon-Thu (both
genuinely run that day - see the display schedule under "Bulletin screen"
above), or just **Friday Dismissal** on a Friday. `serviceDate` is parsed as
a plain calendar date (`${date}T00:00:00Z`), not routed through
`SCHOOL_TIME_ZONE`, since a date string's weekday doesn't depend on timezone.

Same two-endpoint pattern as the morning report:

- `GET /api/office/afternoon-report` - PIN-protected, used by the page.
- `GET /api/reports/afternoon-dismissals` - `MORNING_REPORT_SECRET`-protected,
  optional/general-purpose (see above).

## Daily report emails

Once each school morning and afternoon (`vercel.json` crons: `30 14 * * 1-5`
= 10:30 AM and `0 21 * * 1-5` = 5:00 PM, both Eastern **Daylight** Time,
weekdays only), `GET /api/cron/morning-report` and
`GET /api/cron/afternoon-report` (both `CRON_SECRET`-protected, same as the
nightly Airtable export) build that report and email it via
[Resend](https://resend.com)'s HTTP API - `sendReportEmailViaResend()` in
`server.js`, a plain `fetch` call to `api.resend.com` shared by both report
emails (no SDK dependency added). Requires three env vars, all in the
"Environment variables" table in `README.md` - despite the `MORNING_` prefix
(kept for compatibility with what was configured first), all three are
shared by both the morning and afternoon emails:

- `RESEND_API_KEY` - from the Resend dashboard (Settings → API Keys).
- `MORNING_REPORT_FROM` - e.g. `TBY Bus Report <report@reports.tiferes.net>`.
  Resend requires a verified sending domain to deliver to arbitrary
  recipients (its shared `onboarding@resend.dev` sender only delivers to the
  Resend account's own email).
- `MORNING_REPORT_RECIPIENTS` - comma-separated recipient list, e.g.
  `mrozsansky@tiferes.net,liba@tiferes.net,office@tiferes.net`.

**Sending domain: `reports.tiferes.net`**, verified in Resend (DKIM, the
`send.reports` MAIL FROM subdomain's MX, and its SPF TXT record are all
green). Deliberately a subdomain, not the bare `tiferes.net` - that's the
school's real mail domain (Google Workspace, where the recipients above
live), so keeping this isolated under `reports.tiferes.net` means nothing
here can collide with the school's existing SPF/DKIM/MX no matter what
Resend or GoDaddy do to it. `MORNING_REPORT_FROM` must be an address at
`reports.tiferes.net` (any local part works, e.g. `report@reports.tiferes.net`)
- GoDaddy's own "SPF management" feature initially rewrote the `send.reports`
SPF TXT record into its own indirect `_spfm.` format, which didn't match
what Resend's checker expected; re-adding it as the literal
`v=spf1 include:amazonses.com ~all` fixed it.

Any of the three missing makes either cron fail loudly (500, logged) rather
than silently skip sending - check the Vercel cron's run log
(Project → Cron Jobs) if a report email doesn't arrive.

**DST note:** both cron schedules are fixed UTC times (`14:30`, `21:00`),
which line up with 10:30 AM/5:00 PM only while Eastern Daylight Time is in
effect (mid-March to early November). After the fall-back to Eastern
Standard Time they'll fire an hour earlier local (9:30 AM/4:00 PM) - update
the schedules (`30 15 * * 1-5`, `0 22 * * 1-5`) around the clock change, and
back again in spring, or move to UTC times that are acceptable either way.

**Vercel cron limits:** this project now defines three crons (nightly
Airtable export + the two report emails). Vercel's Hobby plan caps a
project at 2 cron jobs - if the account is on Hobby, either upgrade to Pro
or drop one of these crons before deploying, or the deployment/cron
registration will be rejected.
