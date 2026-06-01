const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appEoktGjwEeUP9GX';
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Bus routes';
const AIRTABLE_SPOTS_TABLE_NAME = process.env.AIRTABLE_SPOTS_TABLE_NAME || 'Bus Parking Spots';
const AIRTABLE_SPOT_NAME_FIELD = process.env.AIRTABLE_SPOT_NAME_FIELD || 'Spot Name';
const AIRTABLE_EVENT_LOG_TABLE_NAME = process.env.AIRTABLE_EVENT_LOG_TABLE_NAME || 'Bus Route Event Log';
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const OFFICE_PIN = process.env.OFFICE_PIN || '';
const SCHOOL_TIME_ZONE = process.env.SCHOOL_TIME_ZONE || 'America/New_York';

const FIELD_NAMES = {
  name: process.env.FIELD_NAME_BUS_NAME || 'Student Bus Screen Name',
  status: process.env.FIELD_NAME_STATUS || 'Current Student Screen Status',
  spot: process.env.FIELD_NAME_SPOT || 'Current Parking Spot',
  order: process.env.FIELD_NAME_ORDER || 'Student Bus Screen Order',
  workflow: process.env.FIELD_NAME_WORKFLOW || 'Route Workflow Type',
  friday: process.env.FIELD_NAME_FRIDAY || 'Use for Friday Dismissal',
  lastArrival: process.env.FIELD_NAME_LAST_ARRIVAL || 'Last Arrival Time',
  lastDeparture: process.env.FIELD_NAME_LAST_DEPARTURE || 'Last Departure Time',
  lastEvent: process.env.FIELD_NAME_LAST_EVENT || 'Last Bus Event Time',
  morningArrived: process.env.FIELD_NAME_MORNING_ARRIVED || 'Morning Bus Arrived',
};

const EVENT_LOG_FIELD_NAMES = {
  route: process.env.EVENT_LOG_FIELD_ROUTE || 'Bus Route',
  eventDate: process.env.EVENT_LOG_FIELD_DATE || 'Event Date',
  eventType: process.env.EVENT_LOG_FIELD_TYPE || 'Event Type',
  eventTime: process.env.EVENT_LOG_FIELD_TIME || 'Event Time',
  statusAfter: process.env.EVENT_LOG_FIELD_STATUS_AFTER || 'Student Screen Status After Event',
  routeDirection: process.env.EVENT_LOG_FIELD_DIRECTION || 'Route Direction',
  spot: process.env.EVENT_LOG_FIELD_SPOT || 'Parking Spot',
  note: process.env.EVENT_LOG_FIELD_NOTE || 'Note',
};

let cache = {
  recordsByScreen: {},
  spotNameMap: null,
  spotList: null,
  spotNameMapFetchedAt: 0,
};

const sseClients = new Set();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function clearCache() {
  cache = {
    recordsByScreen: {},
    spotNameMap: null,
    spotList: null,
    spotNameMapFetchedAt: 0,
  };
}

function notifyDisplays() {
  const payload = `data: ${JSON.stringify({ type: 'refresh', at: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function assertAirtableReady() {
  if (!AIRTABLE_TOKEN) {
    throw new Error('Missing AIRTABLE_TOKEN environment variable in Render.');
  }
}

function airtableTableUrl(tableNameOrId) {
  return `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableNameOrId)}`;
}

async function airtableRequest(url, options = {}) {
  assertAirtableReady();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable error ${response.status}: ${text}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

function getOfficePin(req) {
  return req.query.pin || req.headers['x-office-pin'] || req.body?.pin || '';
}

function validateOfficePin(req, res) {
  if (!OFFICE_PIN) return true;
  if (getOfficePin(req) === OFFICE_PIN) return true;
  res.status(401).json({ error: 'Invalid office PIN' });
  return false;
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

function chooseCurrentScreen() {
  const { weekday, hour, minute } = getSchoolNowParts();
  const minutes = hour * 60 + minute;
  const priDismissal = 14 * 60 + 30;
  const regularDismissal = 15 * 60 + 30;
  if (weekday === 'Fri') return 'friday-dismissal';
  if (minutes < priDismissal) return 'pri-dismissal';
  if (minutes < regularDismissal) return 'pri-dismissal';
  return 'from-school';
}

function normalizeScreen(screen) {
  return screen === 'current' ? chooseCurrentScreen() : screen;
}

function buildFormula(screen) {
  const resolvedScreen = normalizeScreen(screen);
  if (resolvedScreen === 'morning') return `{${FIELD_NAMES.workflow}} = 'To School Arrival Only'`;
  if (resolvedScreen === 'from-school') return `{${FIELD_NAMES.workflow}} = 'From School Dismissal'`;
  if (resolvedScreen === 'pri-dismissal') return `{${FIELD_NAMES.workflow}} = 'PRI Dismissal'`;
  if (resolvedScreen === 'friday-dismissal') return `{${FIELD_NAMES.friday}} = 1`;
  return '';
}

function normalizeSingleSelect(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.name) return value.name;
  return String(value);
}

function looksLikeAirtableRecordId(value) {
  return typeof value === 'string' && /^rec[A-Za-z0-9]{14}$/.test(value);
}

function getLinkedRecordIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && item.id) return item.id;
      return '';
    }).filter(Boolean);
  }
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value.id) return [value.id];
  return [];
}

function normalizeLinkedSpot(value, spotNameMap) {
  if (!value) return '';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return spotNameMap[item] || (looksLikeAirtableRecordId(item) ? '' : item);
      if (item && item.id && spotNameMap[item.id]) return spotNameMap[item.id];
      if (item && item.name) return item.name;
      return '';
    }).filter(Boolean).join(', ');
  }
  if (typeof value === 'string') return spotNameMap[value] || (looksLikeAirtableRecordId(value) ? '' : value);
  if (typeof value === 'object' && value.id && spotNameMap[value.id]) return spotNameMap[value.id];
  if (typeof value === 'object' && value.name) return value.name;
  return '';
}

function normalizeRecord(record, spotNameMap) {
  const fields = record.fields || {};
  return {
    id: record.id,
    name: fields[FIELD_NAMES.name] || 'Bus',
    status: normalizeSingleSelect(fields[FIELD_NAMES.status]) || 'Waiting',
    spot: normalizeLinkedSpot(fields[FIELD_NAMES.spot], spotNameMap) || '',
    spotId: getLinkedRecordIds(fields[FIELD_NAMES.spot])[0] || '',
    order: Number(fields[FIELD_NAMES.order] || 9999),
  };
}

function normalizeOfficeRecord(record, spotNameMap) {
  const fields = record.fields || {};
  return {
    ...normalizeRecord(record, spotNameMap),
    workflow: normalizeSingleSelect(fields[FIELD_NAMES.workflow]),
    lastArrival: fields[FIELD_NAMES.lastArrival] || '',
    lastDeparture: fields[FIELD_NAMES.lastDeparture] || '',
    lastEvent: fields[FIELD_NAMES.lastEvent] || '',
    morningArrived: Boolean(fields[FIELD_NAMES.morningArrived]),
  };
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

function formatForAirtableDateTime(date = new Date()) {
  return date.toISOString();
}

async function fetchSpotNameMap(options = {}) {
  const now = Date.now();
  if (!options.skipCache && cache.spotNameMap && cache.spotList && now - cache.spotNameMapFetchedAt < CACHE_SECONDS * 1000) {
    return cache.spotNameMap;
  }

  const params = new URLSearchParams();
  params.set('pageSize', '100');
  params.append('fields[]', AIRTABLE_SPOT_NAME_FIELD);

  let url = `${airtableTableUrl(AIRTABLE_SPOTS_TABLE_NAME)}?${params.toString()}`;
  const spotNameMap = {};
  const spotList = [];

  while (url) {
    const data = await airtableRequest(url);
    for (const record of data.records || []) {
      const name = record.fields?.[AIRTABLE_SPOT_NAME_FIELD] || '';
      spotNameMap[record.id] = name;
      spotList.push({ id: record.id, name });
    }
    if (data.offset) {
      const nextParams = new URLSearchParams(params);
      nextParams.set('offset', data.offset);
      url = `${airtableTableUrl(AIRTABLE_SPOTS_TABLE_NAME)}?${nextParams.toString()}`;
    } else {
      url = '';
    }
  }

  spotList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  cache.spotNameMap = spotNameMap;
  cache.spotList = spotList;
  cache.spotNameMapFetchedAt = now;
  return spotNameMap;
}

async function fetchRoutesForScreen(screen, options = {}) {
  const resolvedScreen = normalizeScreen(screen);
  const spotNameMap = await fetchSpotNameMap(options);
  const formula = buildFormula(resolvedScreen);
  const params = new URLSearchParams();
  params.set('pageSize', '100');
  params.set('sort[0][field]', FIELD_NAMES.order);
  params.set('sort[0][direction]', 'asc');
  params.append('fields[]', FIELD_NAMES.name);
  params.append('fields[]', FIELD_NAMES.status);
  params.append('fields[]', FIELD_NAMES.spot);
  params.append('fields[]', FIELD_NAMES.order);
  params.append('fields[]', FIELD_NAMES.workflow);
  params.append('fields[]', FIELD_NAMES.friday);
  if (options.office) {
    params.append('fields[]', FIELD_NAMES.lastArrival);
    params.append('fields[]', FIELD_NAMES.lastDeparture);
    params.append('fields[]', FIELD_NAMES.lastEvent);
    params.append('fields[]', FIELD_NAMES.morningArrived);
  }
  if (formula) params.set('filterByFormula', formula);

  let url = `${airtableTableUrl(AIRTABLE_TABLE_NAME)}?${params.toString()}`;
  let allRecords = [];
  while (url) {
    const data = await airtableRequest(url);
    allRecords = allRecords.concat(data.records || []);
    if (data.offset) {
      const nextParams = new URLSearchParams(params);
      nextParams.set('offset', data.offset);
      url = `${airtableTableUrl(AIRTABLE_TABLE_NAME)}?${nextParams.toString()}`;
    } else {
      url = '';
    }
  }

  const mapper = options.office ? normalizeOfficeRecord : normalizeRecord;
  const routes = allRecords.map((record) => mapper(record, spotNameMap)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { screen: resolvedScreen, routes, spots: cache.spotList || [] };
}

async function fetchRouteRecord(recordId) {
  const params = new URLSearchParams();
  params.append('fields[]', FIELD_NAMES.name);
  params.append('fields[]', FIELD_NAMES.status);
  params.append('fields[]', FIELD_NAMES.spot);
  params.append('fields[]', FIELD_NAMES.workflow);
  params.append('fields[]', FIELD_NAMES.lastArrival);
  params.append('fields[]', FIELD_NAMES.lastDeparture);
  params.append('fields[]', FIELD_NAMES.lastEvent);
  params.append('fields[]', FIELD_NAMES.morningArrived);
  return airtableRequest(`${airtableTableUrl(AIRTABLE_TABLE_NAME)}/${recordId}?${params.toString()}`);
}

async function updateRouteRecord(recordId, fields) {
  const cleanFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) cleanFields[key] = value;
  }

  try {
    const data = await airtableRequest(airtableTableUrl(AIRTABLE_TABLE_NAME), {
      method: 'PATCH',
      body: JSON.stringify({ records: [{ id: recordId, fields: cleanFields }] }),
    });
    return data.records?.[0];
  } catch (error) {
    console.error('Airtable route update failed. Fields attempted:', JSON.stringify(cleanFields));
    throw error;
  }
}

async function createEventLog({ recordId, eventType, statusAfter, routeDirection, spotId, note, now }) {
  const fields = {
    [EVENT_LOG_FIELD_NAMES.route]: [recordId],
    [EVENT_LOG_FIELD_NAMES.eventType]: eventType,
    [EVENT_LOG_FIELD_NAMES.eventTime]: formatForAirtableDateTime(now),
    [EVENT_LOG_FIELD_NAMES.eventDate]: toSchoolDateString(now),
    [EVENT_LOG_FIELD_NAMES.statusAfter]: statusAfter,
  };
  if (routeDirection) fields[EVENT_LOG_FIELD_NAMES.routeDirection] = routeDirection;
  if (spotId) fields[EVENT_LOG_FIELD_NAMES.spot] = [spotId];
  if (note) fields[EVENT_LOG_FIELD_NAMES.note] = note;

  try {
    await airtableRequest(airtableTableUrl(AIRTABLE_EVENT_LOG_TABLE_NAME), {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields }] }),
    });
  } catch (error) {
    console.error('Could not create event log record. This will not stop the office button:', error.message);
  }
}

function getNextStatus(currentStatus) {
  if (!currentStatus || currentStatus === 'Waiting' || currentStatus === 'Departed') return 'Arrived';
  if (currentStatus === 'Arrived') return 'Loading';
  if (currentStatus === 'Loading' || currentStatus === 'Ready to Board') return 'Departed';
  return 'Arrived';
}

function buildStatusUpdateFields({ targetStatus, now, spotId, isMorning }) {
  const fields = {
    [FIELD_NAMES.status]: targetStatus,
    [FIELD_NAMES.lastEvent]: formatForAirtableDateTime(now),
  };

  if (targetStatus === 'Waiting') {
    fields[FIELD_NAMES.spot] = [];
    if (isMorning) fields[FIELD_NAMES.morningArrived] = false;
  }

  if (targetStatus === 'Arrived') {
    fields[FIELD_NAMES.lastArrival] = formatForAirtableDateTime(now);
    if (isMorning) fields[FIELD_NAMES.morningArrived] = true;
    if (spotId && !isMorning) fields[FIELD_NAMES.spot] = [spotId];
  }

  if (targetStatus === 'Departed') {
    fields[FIELD_NAMES.lastDeparture] = formatForAirtableDateTime(now);
    fields[FIELD_NAMES.spot] = [];
  }

  return fields;
}

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/webhook/airtable', (req, res) => {
  const providedSecret = req.query.secret || req.headers['x-webhook-secret'] || '';
  if (WEBHOOK_SECRET && providedSecret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized webhook' });
  clearCache();
  notifyDisplays();
  res.json({ ok: true, displaysNotified: sseClients.size });
});

app.get('/api/routes/:screen', async (req, res) => {
  const screen = req.params.screen;
  if (!['current', 'from-school', 'pri-dismissal', 'friday-dismissal'].includes(screen)) return res.status(404).json({ error: 'Unknown screen' });
  try {
    const result = await fetchRoutesForScreen(screen, { skipCache: req.query.fresh === '1' });
    res.json({ screen: result.screen, requestedScreen: screen, updatedAt: new Date().toISOString(), routes: result.routes });
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
    const result = await fetchRoutesForScreen(screen, { skipCache: true, office: true });
    res.json({ ...result, requestedScreen: screen, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/spot', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    const spotId = req.body?.spotId || '';
    await updateRouteRecord(req.params.recordId, {
      [FIELD_NAMES.spot]: spotId ? [spotId] : [],
      [FIELD_NAMES.lastEvent]: formatForAirtableDateTime(new Date()),
    });
    clearCache();
    notifyDisplays();
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/status', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    const targetStatus = req.body?.status;
    if (!['Waiting', 'Arrived', 'Loading', 'Ready to Board', 'Departed', 'Delayed', 'Cancelled'].includes(targetStatus)) return res.status(400).json({ error: 'Invalid status' });

    const now = new Date();
    const isMorning = req.body?.screen === 'morning';
    const routeRecord = await fetchRouteRecord(req.params.recordId);
    const fields = routeRecord.fields || {};
    const spotId = req.body?.spotId || getLinkedRecordIds(fields[FIELD_NAMES.spot])[0] || '';
    const updateFields = buildStatusUpdateFields({ targetStatus, now, spotId, isMorning });

    await updateRouteRecord(req.params.recordId, updateFields);
    await createEventLog({
      recordId: req.params.recordId,
      eventType: targetStatus,
      statusAfter: targetStatus,
      routeDirection: isMorning ? 'To School' : normalizeSingleSelect(fields[FIELD_NAMES.workflow]),
      spotId,
      note: req.body?.note || '',
      now,
    });

    clearCache();
    notifyDisplays();
    res.json({ ok: true, status: targetStatus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/office/route/:recordId/next', async (req, res) => {
  if (!validateOfficePin(req, res)) return;
  try {
    const now = new Date();
    const isMorning = req.body?.screen === 'morning';
    const routeRecord = await fetchRouteRecord(req.params.recordId);
    const fields = routeRecord.fields || {};
    const currentStatus = normalizeSingleSelect(fields[FIELD_NAMES.status]) || 'Waiting';
    const targetStatus = isMorning ? 'Arrived' : getNextStatus(currentStatus);
    const spotId = req.body?.spotId || getLinkedRecordIds(fields[FIELD_NAMES.spot])[0] || '';

    if (!isMorning && targetStatus === 'Arrived' && !spotId) return res.status(400).json({ error: 'Choose a parking spot before marking this bus arrived.' });

    const updateFields = buildStatusUpdateFields({ targetStatus, now, spotId, isMorning });
    await updateRouteRecord(req.params.recordId, updateFields);
    await createEventLog({
      recordId: req.params.recordId,
      eventType: targetStatus,
      statusAfter: targetStatus,
      routeDirection: isMorning ? 'To School' : normalizeSingleSelect(fields[FIELD_NAMES.workflow]),
      spotId,
      now,
    });

    clearCache();
    notifyDisplays();
    res.json({ ok: true, from: currentStatus, to: targetStatus });
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

app.listen(PORT, () => {
  console.log(`Bus screen running on port ${PORT}`);
});
