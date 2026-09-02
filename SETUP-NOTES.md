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

# "Text Parents: Bus Left" texting groups

The office dismissal screens' "Text Parents: Bus Left" button does **not**
resolve parent phone numbers itself. It calls the `tby-texting-system` app's
`/api/mcp` endpoint (`TEXTING_SYSTEM_URL` / `TEXTING_MCP_AUTH_TOKEN`) and
asks it to text a **contact group already set up in that app**, by name —
see `preview_group_sms_send` / `send_group_sms` in that repo's
`docs-chatgpt-mcp.md`.

The group name for a route is computed from the same synced `routes` row
used everywhere else (`route_code`, `color`, `workflow_type`), built to
match `formatBusRouteOptionLabel()` in `tby-texting-system`'s
`lib/campaignPreview.ts` exactly (`busDepartureGroupName()` in `server.js`
here is a copy of that logic against Turso column names):

| Route                                  | Group name                          |
| --------------------------------------- | ------------------------------------ |
| AM (`To School Arrival Only`)           | `AM · <route_code> · <color>` (omits a blank piece, e.g. `AM · TBY1` if `color` is blank) |
| Regular PM (`From School Dismissal`)    | `3:45 – <color>` (`Color not set` if blank) |
| Primary PM (`PRI Dismissal`)            | `Primary – <color>` (`Color not set` if blank) |

If a route's computed name doesn't match an existing group exactly, the
preview call fails with an error listing the actual group names — rename
the group (or fix the route's `route_code`/`color`) to match; the office
screen shows that error directly. Group-name matching on the texting-app
side ignores case, spacing, and dash/middot punctuation differences, but
not the words themselves.
