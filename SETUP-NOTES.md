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
