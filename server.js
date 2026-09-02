const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const OFFICE_PIN = process.env.OFFICE_PIN || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const SCHOOL_TIME_ZONE = process.env.SCHOOL_TIME_ZONE || 'America/New_York';
const CRON_SECRET = process.env.CRON_SECRET || '';

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || '';
const AIRTABLE_EVENT_LOG_TABLE_NAME = process.env.AIRTABLE_EVENT_LOG_TABLE_NAME || 'Bus Route Event Log';
const AIRTABLE_DAILY_STATUS_TABLE_NAME = process.env.AIRTABLE_DAILY_STATUS_TABLE_NAME || 'Bus Daily Status';
const AIRTABLE_SCHOOL_YEARS_TABLE_NAME = process.env.AIRTABLE_SCHOOL_YEARS_TABLE_NAME || 'School Years';
const AIRTABLE_BUS_ROUTES_TABLE_NAME = process.env.AIRTABLE_BUS_ROUTES_TABLE_NAME || 'Bus Routes';

const TEXTING_SYSTEM_URL = (process.env.TEXTING_SYSTEM_URL || '').replace(/\/+$/, '');
const TEXTING_MCP_AUTH_TOKEN = process.env.TEXTING_MCP_AUTH_TOKEN || '';

const STATUS_VALUES = ['Waiting', 'Arrived', 'Loading', 'Ready to Board', 'Departed', 'Delayed', 'Cancelled'];

let dbClient = null;
let schemaReady = null;
const sseClients = new Set();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
}

function getDb() {
  if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
    throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variable.');
  }
  if (!dbClient) {
    dbClient = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  }
  return dbClient;
}

async function run(sql, args = []) {
  return getDb().execute({ sql, args });
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = createSchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      route_code TEXT,
      display_name TEXT NOT NULL,
      color TEXT,
      company TEXT,
      workflow_type TEXT NOT NULL DEFAULT 'From School Dismissal',
      use_friday INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 9999,
      active INTEGER NOT NULL DEFAULT 1,
      airtable_record_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS parking_spots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 9999,
      active INTEGER NOT NULL DEFAULT 1,
      airtable_record_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daily_status (
      id TEXT PRIMARY KEY,
      service_date TEXT NOT NULL,
      screen TEXT NOT NULL,
      route_id TEXT NOT NULL,
      current_status TEXT NOT NULL DEFAULT 'Waiting',
      parking_spot_id TEXT,
      arrival_time TEXT,
      loading_time TEXT,
      departure_time TEXT,
      last_event_time TEXT,
      student_display_message TEXT,
      show_on_student_screen INTEGER NOT NULL DEFAULT 1,
      exported_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(service_date, screen, route_id),
      FOREIGN KEY(route_id) REFERENCES routes(id),
      FOREIGN KEY(parking_spot_id) REFERENCES parking_spots(id)
    )`,
    `CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      service_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      route_id TEXT NOT NULL,
      screen TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status_after TEXT,
      parking_spot_id TEXT,
      note TEXT,
      exported_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(route_id) REFERENCES routes(id),
      FOREIGN KEY(parking_spot_id) REFERENCES parking_spots(id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_routes_screen ON routes(workflow_type, use_friday, active, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_status_lookup ON daily_status(service_date, screen, route_id)`,
    `CREATE INDEX IF NOT EXISTS idx_event_log_export ON event_log(exported_at, service_date)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_status_export ON daily_status(exported_at, service_date)`
  ];

  for (const statement of statements) {
    await run(statement);
  }
}

function requireConfiguredSecret(secretValue, name, res) {
  if (secretValue) return true;
  if (!isProductionRuntime()) return true;
  res.status(500).json({ error: `${name} is not configured.` });
  return false;
}

function getOfficePin(req) {
  return req.headers['x-office-pin'] || req.body?.pin || '';
}

function validateOfficePin(req, res) {
  if (!requireConfiguredSecret(OFFICE_PIN, 'OFFICE_PIN', res)) return false;
  if (!OFFICE_PIN && !isProductionRuntime()) return true;
  if (getOfficePin(req) === OFFICE_PIN) return true;
  res.status(401).json({ error: 'Invalid office PIN' });
  return false;
}

function getAdminSecret(req) {
  return req.headers['x-admin-secret'] || req.body?.adminSecret || '';
}

function validateAdminSecret(req, res) {
  if (!requireConfiguredSecret(ADMIN_SECRET, 'ADMIN_SECRET', res)) return false;
  if (!ADMIN_SECRET && !isProductionRuntime()) return true;
  if (getAdminSecret(req) === ADMIN_SECRET) return true;
  res.status(401).json({ error: 'Invalid admin secret' });
  return false;
}

function getCronSecret(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-cron-secret'] || req.query.secret || '';
}

function validateCronSecret(req, res) {
  if (!requireConfiguredSecret(CRON_SECRET, 'CRON_SECRET', res)) return false;
  if (!CRON_SECRET && !isProductionRuntime()) return true;
  if (getCronSecret(req) === CRON_SECRET) return true;
  res.status(401).json({ error: 'Invalid cron secret' });
  return false;
}

function notifyDisplays() {
  const payload = `data: ${JSON.stringify({ type: 'refresh', at: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || randomUUID();
}

function toBoolInt(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue ? 1 : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  return ['true', 'yes', 'y', '1', 'checked', 'active'].includes(String(value).toLowerCase()) ? 1 : 0;
}

function getSchoolNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHOOL_TIME_ZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return { weekday: value('weekday'), hour: Number(value('hour')), minute: Number(value('minute')) };
}

const OVERRIDABLE_SCREENS = ['from-school', 'pri-dismissal', 'friday-dismissal'];
const CURRENT_SCREEN_OVERRIDE_KEY = 'current_screen_override';

async function getSetting(key) {
  const result = await run(`SELECT value FROM settings WHERE key = ?`, [key]);
  return result.rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

// The office can force /current to a specific screen for the rest of the school day (schedule
// changes, early dismissal, etc). The override is stamped with the school-date it was set on, so
// it stops applying on its own once that date has passed - no separate cleanup job needed.
async function getScreenOverride() {
  const raw = await getSetting(CURRENT_SCREEN_OVERRIDE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.serviceDate === toSchoolDateString() && OVERRIDABLE_SCREENS.includes(parsed.screen)) {
      return parsed.screen;
    }
  } catch (error) {
    // malformed/legacy value - treat as no override
  }
  return null;
}

async function setScreenOverride(screen) {
  if (!screen || screen === 'auto') {
    await setSetting(CURRENT_SCREEN_OVERRIDE_KEY, '');
    return null;
  }
  if (!OVERRIDABLE_SCREENS.includes(screen)) throw new Error('Invalid screen override.');
  await setSetting(CURRENT_SCREEN_OVERRIDE_KEY, JSON.stringify({ screen, serviceDate: toSchoolDateString() }));
  return screen;
}

function computeScheduledScreen() {
  const { weekday, hour, minute } = getSchoolNowParts();
  if (weekday === 'Fri') return 'friday-dismissal';
  const minutes = hour * 60 + minute;
  const regularDismissal = 15 * 60 + 30;
  return minutes < regularDismissal ? 'pri-dismissal' : 'from-school';
}

async function chooseCurrentScreen() {
  await ensureSchema();
  const override = await getScreenOverride();
  return override || computeScheduledScreen();
}

async function normalizeScreen(screen) {
  return screen === 'current' ? await chooseCurrentScreen() : screen;
}

function toSchoolDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHOOL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function screenFilter(screen) {
  if (screen === 'morning') return { sql: "workflow_type = ?", args: ['To School Arrival Only'] };
  if (screen === 'from-school') return { sql: "workflow_type = ?", args: ['From School Dismissal'] };
  if (screen === 'pri-dismissal') return { sql: "workflow_type = ?", args: ['PRI Dismissal'] };
  if (screen === 'friday-dismissal') return { sql: "use_friday = 1 OR workflow_type = ? OR workflow_type = ?", args: ['Friday Dismissal', 'To School Arrival Only'] };
  return { sql: "1 = 0", args: [] };
}

function getNextStatus(currentStatus) {
  if (!currentStatus || currentStatus === 'Waiting' || currentStatus === 'Departed') return 'Arrived';
  if (currentStatus === 'Arrived') return 'Loading';
  if (currentStatus === 'Loading' || currentStatus === 'Ready to Board') return 'Departed';
  return 'Arrived';
}

function dailyStatusId(serviceDate, screen, routeId) {
  return `${serviceDate}_${screen}_${routeId}`;
}

async function validateRouteForScreen(routeId, screen) {
  const filter = screenFilter(screen);
  const result = await run(
    `SELECT * FROM routes WHERE id = ? AND active = 1 AND (${filter.sql}) LIMIT 1`,
    [routeId, ...filter.args]
  );
  if (result.rows.length) return result.rows[0];

  const anyRoute = await run(`SELECT id, active FROM routes WHERE id = ? LIMIT 1`, [routeId]);
  if (!anyRoute.rows.length) throw new Error('Route does not exist.');
  if (!anyRoute.rows[0].active) throw new Error('Route is inactive.');
  throw new Error('Route is not valid for this screen.');
}

async function validateSpot(spotId) {
  if (!spotId) return null;
  const result = await run(`SELECT id FROM parking_spots WHERE id = ? AND active = 1 LIMIT 1`, [spotId]);
  if (!result.rows.length) throw new Error('Parking spot does not exist or is inactive.');
  return result.rows[0];
}

async function ensureDailyStatus(routeId, screen, serviceDate = toSchoolDateString()) {
  const id = dailyStatusId(serviceDate, screen, routeId);
  await run(
    `INSERT OR IGNORE INTO daily_status (id, service_date, screen, route_id, current_status, last_event_time)
     VALUES (?, ?, ?, ?, 'Waiting', ?)`,
    [id, serviceDate, screen, routeId, new Date().toISOString()]
  );
  return id;
}

function mapRouteRow(row, office = false) {
  return {
    id: row.route_id,
    name: row.display_name || row.route_code || 'Bus',
    status: row.current_status || 'Waiting',
    spot: row.spot_name || '',
    spotId: row.parking_spot_id || '',
    order: Number(row.sort_order || 9999),
    workflow: row.workflow_type || '',
    lastArrival: row.arrival_time || '',
    lastDeparture: row.departure_time || '',
    lastEvent: row.last_event_time || '',
    morningArrived: office ? row.current_status === 'Arrived' : undefined,
  };
}

async function listSpots() {
  const result = await run(
    `SELECT id, name FROM parking_spots WHERE active = 1 ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name }));
}

async function fetchRoutesForScreen(screen, options = {}) {
  await ensureSchema();
  const resolvedScreen = await normalizeScreen(screen);
  const serviceDate = toSchoolDateString();
  const filter = screenFilter(resolvedScreen);

  const routes = await run(
    `SELECT id FROM routes WHERE active = 1 AND (${filter.sql}) ORDER BY sort_order ASC, display_name COLLATE NOCASE ASC`,
    filter.args
  );

  for (const route of routes.rows) {
    await ensureDailyStatus(route.id, resolvedScreen, serviceDate);
  }

  const result = await run(
    `SELECT
      routes.id AS route_id,
      routes.route_code,
      routes.display_name,
      routes.workflow_type,
      routes.sort_order,
      daily_status.current_status,
      daily_status.parking_spot_id,
      daily_status.arrival_time,
      daily_status.loading_time,
      daily_status.departure_time,
      daily_status.last_event_time,
      parking_spots.name AS spot_name
     FROM routes
     JOIN daily_status
       ON daily_status.route_id = routes.id
      AND daily_status.service_date = ?
      AND daily_status.screen = ?
     LEFT JOIN parking_spots ON parking_spots.id = daily_status.parking_spot_id
     WHERE routes.active = 1 AND (${filter.sql}) AND daily_status.show_on_student_screen = 1
     ORDER BY routes.sort_order ASC, routes.display_name COLLATE NOCASE ASC`,
    [serviceDate, resolvedScreen, ...filter.args]
  );

  const spots = options.office ? await listSpots() : [];
  return { screen: resolvedScreen, routes: result.rows.map((row) => mapRouteRow(row, options.office)), spots };
}

async function fetchStatus(routeId, screen) {
  const serviceDate = toSchoolDateString();
  await ensureDailyStatus(routeId, screen, serviceDate);
  const result = await run(
    `SELECT daily_status.*, routes.workflow_type
     FROM daily_status
     JOIN routes ON routes.id = daily_status.route_id
     WHERE daily_status.service_date = ? AND daily_status.screen = ? AND daily_status.route_id = ?`,
    [serviceDate, screen, routeId]
  );
  return result.rows[0];
}

async function createEventLog({ routeId, screen, eventType, statusAfter, spotId, note, now = new Date() }) {
  await run(
    `INSERT INTO event_log (id, service_date, event_time, route_id, screen, event_type, status_after, parking_spot_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?)`,
    [randomUUID(), toSchoolDateString(now), now.toISOString(), routeId, screen, eventType, statusAfter || '', spotId || '', note || '']
  );
}

async function setRouteStatus({ routeId, screen, status, spotId, note }) {
  if (!STATUS_VALUES.includes(status)) throw new Error('Invalid status');
  const resolvedScreen = await normalizeScreen(screen);
  await validateRouteForScreen(routeId, resolvedScreen);
  await validateSpot(spotId || '');
  const current = await fetchStatus(routeId, resolvedScreen);
  if (!current) throw new Error('Route status not found.');

  if (resolvedScreen !== 'morning' && status === 'Arrived' && !spotId && !current.parking_spot_id) {
    throw new Error('Choose a parking spot before marking this bus arrived.');
  }

  const now = new Date();
  const update = {
    currentStatus: status,
    parkingSpotId: spotId || current.parking_spot_id || '',
    arrivalTime: current.arrival_time || '',
    loadingTime: current.loading_time || '',
    departureTime: current.departure_time || '',
  };

  if (status === 'Waiting') {
    update.parkingSpotId = '';
  }
  if (status === 'Arrived') {
    update.arrivalTime = now.toISOString();
    if (resolvedScreen === 'morning') update.parkingSpotId = '';
  }
  if (status === 'Loading' || status === 'Ready to Board') {
    update.loadingTime = now.toISOString();
  }
  if (status === 'Departed') {
    update.departureTime = now.toISOString();
    update.parkingSpotId = '';
  }

  await run(
    `UPDATE daily_status
     SET current_status = ?, parking_spot_id = NULLIF(?, ''), arrival_time = NULLIF(?, ''),
         loading_time = NULLIF(?, ''), departure_time = NULLIF(?, ''), last_event_time = ?, updated_at = CURRENT_TIMESTAMP,
         exported_at = NULL
     WHERE service_date = ? AND screen = ? AND route_id = ?`,
    [
      update.currentStatus,
      update.parkingSpotId,
      update.arrivalTime,
      update.loadingTime,
      update.departureTime,
      now.toISOString(),
      toSchoolDateString(now),
      resolvedScreen,
      routeId,
    ]
  );

  await createEventLog({ routeId, screen: resolvedScreen, eventType: status, statusAfter: status, spotId: update.parkingSpotId, note, now });
  notifyDisplays();
  return { ok: true, status };
}

async function setRouteSpot(routeId, screen, spotId) {
  const resolvedScreen = await normalizeScreen(screen || 'from-school');
  await validateRouteForScreen(routeId, resolvedScreen);
  await validateSpot(spotId || '');
  const now = new Date();
  await ensureDailyStatus(routeId, resolvedScreen, toSchoolDateString(now));
  await run(
    `UPDATE daily_status
     SET parking_spot_id = NULLIF(?, ''), last_event_time = ?, updated_at = CURRENT_TIMESTAMP, exported_at = NULL
     WHERE service_date = ? AND screen = ? AND route_id = ?`,
    [spotId || '', now.toISOString(), toSchoolDateString(now), resolvedScreen, routeId]
  );
  await createEventLog({ routeId, screen: resolvedScreen, eventType: 'Spot Updated', statusAfter: '', spotId, note: 'Office spot dropdown', now });
  notifyDisplays();
  return { ok: true };
}

function normalizeRouteInput(route, index) {
  const routeCode = route.routeCode || route.route_code || route.code || route.RouteCode || route['Route Code'] || '';
  const displayName = route.displayName || route.display_name || route.name || route.Name || route.color || route.Color || routeCode || `Bus ${index + 1}`;
  return {
    id: route.id || route.routeId || route.RouteKey || route.routeKey || slugify(routeCode || displayName),
    routeCode,
    displayName,
    color: route.color || route.Color || '',
    company: route.company || route.Company || '',
    workflowType: route.workflowType || route.workflow_type || route.workflow || route.Workflow || route['Route Workflow Type'] || 'From School Dismissal',
    useFriday: toBoolInt(route.useFriday ?? route.use_friday ?? route.friday ?? route['Use for Friday Dismissal'], false),
    sortOrder: Number(route.sortOrder ?? route.sort_order ?? route.order ?? route.Sort ?? index + 1),
    active: toBoolInt(route.active, true),
    airtableRecordId: route.airtableRecordId || route.airtable_record_id || '',
  };
}

function normalizeSpotInput(spot, index) {
  const name = spot.name || spot.Name || spot.spotName || spot['Spot Name'] || `Spot ${index + 1}`;
  return {
    id: spot.id || spot.spotId || slugify(name),
    name,
    sortOrder: Number(spot.sortOrder ?? spot.sort_order ?? spot.order ?? index + 1),
    active: toBoolInt(spot.active, true),
    airtableRecordId: spot.airtableRecordId || spot.airtable_record_id || '',
  };
}

async function importData({ routes = [], spots = [] }) {
  await ensureSchema();
  for (const [index, spotInput] of spots.entries()) {
    const spot = normalizeSpotInput(spotInput, index);
    await run(
      `INSERT INTO parking_spots (id, name, sort_order, active, airtable_record_id, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         sort_order = excluded.sort_order,
         active = excluded.active,
         airtable_record_id = excluded.airtable_record_id,
         updated_at = CURRENT_TIMESTAMP`,
      [spot.id, spot.name, spot.sortOrder, spot.active, spot.airtableRecordId]
    );
  }

  for (const [index, routeInput] of routes.entries()) {
    const route = normalizeRouteInput(routeInput, index);
    await run(
      `INSERT INTO routes (id, route_code, display_name, color, company, workflow_type, use_friday, sort_order, active, airtable_record_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         route_code = excluded.route_code,
         display_name = excluded.display_name,
         color = excluded.color,
         company = excluded.company,
         workflow_type = excluded.workflow_type,
         use_friday = excluded.use_friday,
         sort_order = excluded.sort_order,
         active = excluded.active,
         airtable_record_id = excluded.airtable_record_id,
         updated_at = CURRENT_TIMESTAMP`,
      [route.id, route.routeCode, route.displayName, route.color, route.company, route.workflowType, route.useFriday, route.sortOrder, route.active, route.airtableRecordId]
    );
  }

  return { ok: true, importedRoutes: routes.length, importedSpots: spots.length };
}

async function airtableListRecords(tableName, { fields, filterByFormula } = {}) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) throw new Error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID environment variable.');
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`);
    url.searchParams.set('pageSize', '100');
    if (fields) fields.forEach((field) => url.searchParams.append('fields[]', field));
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
    if (offset) url.searchParams.set('offset', offset);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!response.ok) throw new Error(`Airtable fetch of "${tableName}" failed ${response.status}: ${await response.text()}`);
    const data = await response.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

async function findCurrentSchoolYearRecordId() {
  const records = await airtableListRecords(AIRTABLE_SCHOOL_YEARS_TABLE_NAME, { fields: ['Is Current Year'] });
  const current = records.find((record) => record.fields && record.fields['Is Current Year']);
  if (!current) throw new Error(`No record in the "${AIRTABLE_SCHOOL_YEARS_TABLE_NAME}" table has "Is Current Year" checked.`);
  return current.id;
}

// Maps a Bus Routes record to the shape normalizeRouteInput expects. Business-rule notes:
// - AM / PM = "AM" -> the morning arrival screen (workflow "To School Arrival Only").
// - PM + "Regular dismissal" -> From School Dismissal screen.
// - PM + "Primary dismissal" -> PRI Dismissal screen.
// - Anything else (Other, Early dismissal, Both, blank) imports inactive (hidden from every
//   screen) and gets flagged so the office can review and fix it in Airtable or Turso by hand.
// - Airtable has no concept of Friday dismissal today, so useFriday is always false here.
function mapAirtableRouteRecord(record) {
  const fields = record.fields || {};
  const routeName = fields['Route Name'] || record.id;
  const ampm = fields['AM / PM'] || '';
  const dismissal = fields['Primary Dismissal'] || '';
  const color = fields['Bus Color'] || '';
  const company = fields['Bus Company'] || '';

  let workflowType = 'From School Dismissal';
  let active = true;

  if (ampm === 'AM') {
    workflowType = 'To School Arrival Only';
  } else if (ampm === 'PM') {
    if (dismissal === 'Regular dismissal') {
      workflowType = 'From School Dismissal';
    } else if (dismissal === 'Primary dismissal') {
      workflowType = 'PRI Dismissal';
    } else {
      active = false; // Other / Early dismissal / blank - needs manual review
    }
  } else {
    active = false; // "Both" or an unexpected AM/PM value - needs manual review
  }

  return {
    id: slugify(routeName),
    routeCode: routeName,
    displayName: color || routeName,
    color,
    company,
    workflowType,
    useFriday: false,
    active,
    airtableRecordId: record.id,
    ampmRaw: ampm,
    dismissalRaw: dismissal,
  };
}

async function syncRoutesFromAirtable() {
  const currentYearId = await findCurrentSchoolYearRecordId();
  const busRouteRecords = await airtableListRecords(AIRTABLE_BUS_ROUTES_TABLE_NAME, {
    fields: ['Route Name', 'School Year', 'AM / PM', 'Primary Dismissal', 'Bus Company', 'Bus Color'],
  });
  const currentYearRecords = busRouteRecords.filter((record) => {
    const years = record.fields?.['School Year'];
    return Array.isArray(years) && years.includes(currentYearId);
  });

  const flagged = [];
  const mappedRoutes = currentYearRecords.map((record) => {
    const mapped = mapAirtableRouteRecord(record);
    if (!mapped.active) {
      flagged.push({ routeCode: mapped.routeCode, ampm: mapped.ampmRaw, dismissal: mapped.dismissalRaw });
    }
    return mapped;
  });
  mappedRoutes.sort((a, b) => a.workflowType.localeCompare(b.workflowType) || a.displayName.localeCompare(b.displayName));

  const result = await importData({ routes: mappedRoutes });

  const syncedAirtableIds = mappedRoutes.map((route) => route.airtableRecordId);
  if (syncedAirtableIds.length) {
    await run(
      `UPDATE routes SET active = 0, updated_at = CURRENT_TIMESTAMP
       WHERE airtable_record_id IS NOT NULL AND airtable_record_id != ''
       AND airtable_record_id NOT IN (${syncedAirtableIds.map(() => '?').join(',')})`,
      syncedAirtableIds
    );
  }

  return { ok: true, importedRoutes: result.importedRoutes, flagged };
}

// Builds the name of the contact group in the texting app (tby-texting-system) that corresponds
// to this route. This mirrors formatBusRouteOptionLabel() in that repo's lib/campaignPreview.ts
// exactly - same Airtable-sourced fields (Route Name -> route_code, Bus Color -> color, AM / PM +
// Primary Dismissal -> workflow_type), same "AM · <route code> · <color>" / "<3:45|Primary> –
// <color>" shape - since that's the label staff see there and named their bussing contact groups
// after.
function busDepartureGroupName(route) {
  const routeCode = route.route_code || '';
  const color = route.color || '';
  if (route.workflow_type === 'PRI Dismissal') return `Primary – ${color || 'Color not set'}`;
  if (route.workflow_type === 'From School Dismissal') return `3:45 – ${color || 'Color not set'}`;
  return ['AM', routeCode, color].filter(Boolean).join(' · ');
}

function busDepartureMessage(displayName) {
  return `The ${displayName} bus has left. — Tiferes Bais Yaakov`;
}

async function textgridMcpCall(name, args) {
  if (!TEXTING_SYSTEM_URL || !TEXTING_MCP_AUTH_TOKEN) throw new Error('Texting is not configured (missing TEXTING_SYSTEM_URL or TEXTING_MCP_AUTH_TOKEN).');
  const response = await fetch(`${TEXTING_SYSTEM_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEXTING_MCP_AUTH_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Texting system request failed (${response.status}).`);
  return data.result?.structuredContent;
}

async function busDepartureRouteInfo(routeId) {
  const routeRow = await run(`SELECT display_name, route_code, color, workflow_type FROM routes WHERE id = ?`, [routeId]);
  const route = routeRow.rows[0];
  if (!route) throw new Error('Route not found.');
  return { displayName: route.display_name || route.route_code || 'Bus', routeCode: route.route_code || '', groupName: busDepartureGroupName(route) };
}

async function previewBusDeparture(routeId) {
  const { displayName, routeCode, groupName } = await busDepartureRouteInfo(routeId);
  const message = busDepartureMessage(displayName);
  const result = await textgridMcpCall('preview_group_sms_send', { message, groupName });
  return { message, routeCode, groupName, count: result.uniqueValidRecipients, confirmationToken: result.confirmationToken, expiresInSeconds: result.expiresInSeconds, sandbox: result.sandboxMode };
}

async function sendBusDeparture(routeId, message, confirmationToken) {
  const { groupName } = await busDepartureRouteInfo(routeId);
  if (!confirmationToken) throw new Error('Missing confirmationToken from the preview step.');
  const result = await textgridMcpCall('send_group_sms', { message, groupName, confirmationToken });
  return { texted: result.successful?.length || 0, failed: result.failed?.length || 0, sandbox: result.sandboxMode };
}

async function airtableCreateRecords(tableName, records) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !records.length) return { skipped: true, count: 0 };
  let count = 0;
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typecast: true, records: batch.map((fields) => ({ fields })) }),
    });
    if (!response.ok) throw new Error(`Airtable export failed ${response.status}: ${await response.text()}`);
    count += batch.length;
  }
  return { skipped: false, count };
}

async function exportToAirtable() {
  await ensureSchema();
  const eventRows = await run(
    `SELECT event_log.*, routes.display_name, routes.workflow_type, routes.airtable_record_id AS route_airtable_id,
            parking_spots.name AS spot_name, parking_spots.airtable_record_id AS spot_airtable_id
     FROM event_log
     JOIN routes ON routes.id = event_log.route_id
     LEFT JOIN parking_spots ON parking_spots.id = event_log.parking_spot_id
     WHERE event_log.exported_at IS NULL
     ORDER BY event_log.event_time ASC
     LIMIT 200`
  );

  const eventRecords = eventRows.rows.map((row) => {
    const fields = {
      'Event Name': `${row.display_name || row.route_id} - ${row.event_type} - ${row.event_time}`,
      'Event Date': row.service_date,
      'Route Direction': row.screen,
      'Event Type': row.event_type,
      'Event Time': row.event_time,
      'Student Screen Status After Event': row.status_after || row.event_type,
      'Notes': [row.note, row.spot_name ? `Spot: ${row.spot_name}` : '', `Turso route: ${row.route_id}`].filter(Boolean).join('\n'),
    };
    if (row.route_airtable_id) fields['Bus Route'] = [row.route_airtable_id];
    if (row.spot_airtable_id) fields['Parking Spot'] = [row.spot_airtable_id];
    return fields;
  });

  const statusRows = await run(
    `SELECT daily_status.*, routes.display_name, routes.airtable_record_id AS route_airtable_id,
            parking_spots.name AS spot_name, parking_spots.airtable_record_id AS spot_airtable_id
     FROM daily_status
     JOIN routes ON routes.id = daily_status.route_id
     LEFT JOIN parking_spots ON parking_spots.id = daily_status.parking_spot_id
     WHERE daily_status.exported_at IS NULL
     ORDER BY daily_status.service_date ASC, daily_status.screen ASC
     LIMIT 200`
  );

  const statusRecords = statusRows.rows.map((row) => {
    const fields = {
      'Status Name': `${row.service_date} - ${row.screen} - ${row.display_name || row.route_id}`,
      'Service Date': row.service_date,
      'Route Timeframe': row.screen,
      'Current Status': row.current_status,
      'Student Display Message': row.student_display_message || '',
      'Show on Student Screen': Boolean(row.show_on_student_screen),
    };
    if (row.arrival_time) fields['Arrival Time'] = row.arrival_time;
    if (row.departure_time) fields['Departure Time'] = row.departure_time;
    if (row.route_airtable_id) fields['Bus Route'] = [row.route_airtable_id];
    if (row.spot_airtable_id) fields['Parking Spot'] = [row.spot_airtable_id];
    return fields;
  });

  const eventExport = await airtableCreateRecords(AIRTABLE_EVENT_LOG_TABLE_NAME, eventRecords);
  const statusExport = await airtableCreateRecords(AIRTABLE_DAILY_STATUS_TABLE_NAME, statusRecords);
  const now = new Date().toISOString();

  if (!eventExport.skipped && eventRows.rows.length) {
    const ids = eventRows.rows.map((row) => row.id);
    await run(`UPDATE event_log SET exported_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids]);
  }
  if (!statusExport.skipped && statusRows.rows.length) {
    const ids = statusRows.rows.map((row) => row.id);
    await run(`UPDATE daily_status SET exported_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids]);
  }

  return { ok: true, events: eventExport, dailyStatuses: statusExport };
}

app.get('/health', async (req, res) => {
  try {
    await ensureSchema();
    res.json({ ok: true, database: 'turso' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/routes/:screen', async (req, res) => {
  const screen = req.params.screen;
  if (!['current', 'from-school', 'pri-dismissal', 'friday-dismissal'].includes(screen)) return res.status(404).json({ error: 'Unknown screen' });
  try {
    const result = await fetchRoutesForScreen(screen);
    res.json({ screen: result.screen, requestedScreen: screen, updatedAt: new Date().toISOString(), routes: result.routes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Registered before the /api/office/:screen wildcard below - Express matches routes in
// registration order, and a wildcard segment (:screen) would otherwise swallow this literal path
// (:screen = "screen-override") before it ever reached this handler.
app.get('/api/office/screen-override', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    await ensureSchema();
    const override = await getScreenOverride();
    res.json({ override, scheduledScreen: computeScheduledScreen() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/screen-override', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    await ensureSchema();
    const override = await setScreenOverride(req.body?.screen || 'auto');
    notifyDisplays();
    res.json({ override, scheduledScreen: computeScheduledScreen() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/office/:screen', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  const screen = req.params.screen;
  if (!['morning', 'current', 'from-school', 'pri-dismissal', 'friday-dismissal'].includes(screen)) return res.status(404).json({ error: 'Unknown office screen' });
  try {
    const result = await fetchRoutesForScreen(screen, { office: true });
    res.json({ ...result, requestedScreen: screen, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/spot', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    const screen = req.body?.screen || 'from-school';
    const result = await setRouteSpot(req.params.recordId, screen, req.body?.spotId || '');
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/status', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    const result = await setRouteStatus({
      routeId: req.params.recordId,
      screen: req.body?.screen || 'from-school',
      status: req.body?.status,
      spotId: req.body?.spotId || '',
      note: req.body?.note || '',
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/next', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    const screen = await normalizeScreen(req.body?.screen || 'from-school');
    await validateRouteForScreen(req.params.recordId, screen);
    const current = await fetchStatus(req.params.recordId, screen);
    const targetStatus = screen === 'morning' ? 'Arrived' : getNextStatus(current?.current_status || 'Waiting');
    const result = await setRouteStatus({
      routeId: req.params.recordId,
      screen,
      status: targetStatus,
      spotId: req.body?.spotId || current?.parking_spot_id || '',
      note: req.body?.note || '',
    });
    res.json({ ...result, from: current?.current_status || 'Waiting', to: targetStatus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/notify-departure/preview', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    res.json(await previewBusDeparture(req.params.recordId));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/notify-departure/send', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    res.json(await sendBusDeparture(req.params.recordId, req.body?.message || '', req.body?.confirmationToken || ''));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/import', async (req, res) => {
  if (!validateAdminSecret(req, res)) return;
  try {
    const result = await importData({ routes: req.body?.routes || [], spots: req.body?.spots || [] });
    notifyDisplays();
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/sync-airtable-routes', async (req, res) => {
  if (!validateAdminSecret(req, res)) return;
  try {
    const result = await syncRoutesFromAirtable();
    notifyDisplays();
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/data', async (req, res) => {
  if (!validateAdminSecret(req, res)) return;
  try {
    await ensureSchema();
    const routes = await run(`SELECT * FROM routes ORDER BY sort_order ASC, display_name COLLATE NOCASE ASC`);
    const spots = await run(`SELECT * FROM parking_spots ORDER BY sort_order ASC, name COLLATE NOCASE ASC`);
    res.json({ routes: routes.rows, spots: spots.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/export-airtable', async (req, res) => {
  if (!validateAdminSecret(req, res)) return;
  try {
    res.json(await exportToAirtable());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cron/export-airtable', async (req, res) => {
  if (!validateCronSecret(req, res)) return;
  try {
    res.json(await exportToAirtable());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get(['/office', '/office/morning', '/office/from-school', '/office/pri-dismissal', '/office/friday-dismissal'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'office.html'));
});

app.get(['/current', '/from-school', '/pri-dismissal', '/friday-dismissal'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/', (req, res) => {
  res.redirect('/current');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Bus screen running on port ${PORT}`);
  });
}

module.exports = app;
