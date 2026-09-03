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
PM routes, a route code like `TBY1` for AM routes) and `{time}` (formatted
in `SCHOOL_TIME_ZONE` at the moment staff click the template - frozen into
the message right there via `renderTemplate()`, so what's shown in the
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
template name, the exact rendered message, and recipient/failure counts -
which backs two things on the office grid: the button turns green
("texted") once any template has been sent to that route today, and a "View
all" link opens that route's full day of sent texts
(`GET /api/office/route/:id/text-log`). Editing or deleting a template never
touches this history, since the log copies the rendered name and message in
directly rather than referencing the template row.

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
