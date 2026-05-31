const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appEoktGjwEeUP9GX';
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Bus routes';
const AIRTABLE_SPOTS_TABLE_NAME = process.env.AIRTABLE_SPOTS_TABLE_NAME || 'Bus Parking Spots';
const AIRTABLE_SPOT_NAME_FIELD = process.env.AIRTABLE_SPOT_NAME_FIELD || 'Spot Name';
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SCHOOL_TIME_ZONE = process.env.SCHOOL_TIME_ZONE || 'America/New_York';

const FIELD_NAMES = {
  name: process.env.FIELD_NAME_BUS_NAME || 'Student Bus Screen Name',
  status: process.env.FIELD_NAME_STATUS || 'Current Student Screen Status',
  spot: process.env.FIELD_NAME_SPOT || 'Current Parking Spot',
  order: process.env.FIELD_NAME_ORDER || 'Student Bus Screen Order',
  workflow: process.env.FIELD_NAME_WORKFLOW || 'Route Workflow Type',
  friday: process.env.FIELD_NAME_FRIDAY || 'Use for Friday Dismissal',
};

let cache = {
  fetchedAt: 0,
  records: [],
  recordsByScreen: {},
  spotNameMap: null,
  spotNameMapFetchedAt: 0,
};

const sseClients = new Set();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function clearCache() {
  cache = {
    fetchedAt: 0,
    records: [],
    recordsByScreen: {},
    spotNameMap: null,
    spotNameMapFetchedAt: 0,
  };
}

function notifyDisplays() {
  const payload = `data: ${JSON.stringify({ type: 'refresh', at: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
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
  return {
    weekday: value('weekday'),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
  };
}

function chooseCurrentScreen() {
  const { weekday, hour, minute } = getSchoolNowParts();
  const minutes = hour * 60 + minute;

  const fridayDismissal = 11 * 60 + 15;
  const priDismissal = 14 * 60 + 30;
  const regularDismissal = 15 * 60 + 30;

  if (weekday === 'Fri') {
    return 'friday-dismissal';
  }

  if (minutes < priDismissal) {
    return 'pri-dismissal';
  }

  if (minutes < regularDismissal) {
    return 'pri-dismissal';
  }

  return 'from-school';
}

function buildFormula(screen) {
  if (screen === 'current') {
    return buildFormula(chooseCurrentScreen());
  }

  if (screen === 'from-school') {
    return `{${FIELD_NAMES.workflow}} = 'From School Dismissal'`;
  }

  if (screen === 'pri-dismissal') {
    return `{${FIELD_NAMES.workflow}} = 'PRI Dismissal'`;
  }

  if (screen === 'friday-dismissal') {
    return `{${FIELD_NAMES.friday}} = 1`;
  }

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

function normalizeLinkedSpot(value, spotNameMap) {
  if (!value) return '';

  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return spotNameMap[item] || (looksLikeAirtableRecordId(item) ? '' : item);
        }
        if (item && item.id && spotNameMap[item.id]) return spotNameMap[item.id];
        if (item && item.name) return item.name;
        return '';
      })
      .filter(Boolean)
      .join(', ');
  }

  if (typeof value === 'string') {
    return spotNameMap[value] || (looksLikeAirtableRecordId(value) ? '' : value);
  }

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
    order: Number(fields[FIELD_NAMES.order] || 9999),
  };
}

async function airtableRequest(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable error ${response.status}: ${text}`);
  }

  return response.json();
}

async function fetchSpotNameMap(options = {}) {
  const now = Date.now();
  const skipCache = options.skipCache === true;

  if (!skipCache && cache.spotNameMap && now - cache.spotNameMapFetchedAt < CACHE_SECONDS * 1000) {
    return cache.spotNameMap;
  }

  const params = new URLSearchParams();
  params.set('pageSize', '100');
  params.append('fields[]', AIRTABLE_SPOT_NAME_FIELD);

  const encodedTable = encodeURIComponent(AIRTABLE_SPOTS_TABLE_NAME);
  let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodedTable}?${params.toString()}`;
  const spotNameMap = {};

  while (url) {
    const data = await airtableRequest(url);
    for (const record of data.records || []) {
      spotNameMap[record.id] = record.fields?.[AIRTABLE_SPOT_NAME_FIELD] || '';
    }

    if (data.offset) {
      const nextParams = new URLSearchParams(params);
      nextParams.set('offset', data.offset);
      url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodedTable}?${nextParams.toString()}`;
    } else {
      url = '';
    }
  }

  cache.spotNameMap = spotNameMap;
  cache.spotNameMapFetchedAt = now;
  return spotNameMap;
}

async function fetchRoutes(screen, options = {}) {
  if (!AIRTABLE_TOKEN) {
    throw new Error('Missing AIRTABLE_TOKEN environment variable. Add it in Render, not GitHub.');
  }

  const resolvedScreen = screen === 'current' ? chooseCurrentScreen() : screen;
  const now = Date.now();
  const skipCache = options.skipCache === true;
  const cacheValid = !skipCache && cache.recordsByScreen && cache.recordsByScreen[resolvedScreen] && now - cache.recordsByScreen[resolvedScreen].fetchedAt < CACHE_SECONDS * 1000;
  if (cacheValid) {
    return { screen: resolvedScreen, routes: cache.recordsByScreen[resolvedScreen].records };
  }

  const spotNameMap = await fetchSpotNameMap({ skipCache });
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
  if (formula) params.set('filterByFormula', formula);

  const encodedTable = encodeURIComponent(AIRTABLE_TABLE_NAME);
  let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodedTable}?${params.toString()}`;
  let allRecords = [];

  while (url) {
    const data = await airtableRequest(url);
    allRecords = allRecords.concat(data.records || []);

    if (data.offset) {
      const nextParams = new URLSearchParams(params);
      nextParams.set('offset', data.offset);
      url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodedTable}?${nextParams.toString()}`;
    } else {
      url = '';
    }
  }

  const records = allRecords
    .map((record) => normalizeRecord(record, spotNameMap))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  cache.recordsByScreen = cache.recordsByScreen || {};
  cache.recordsByScreen[resolvedScreen] = { fetchedAt: now, records };
  return { screen: resolvedScreen, routes: records };
}

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/webhook/airtable', (req, res) => {
  const providedSecret = req.query.secret || req.headers['x-webhook-secret'] || '';
  if (WEBHOOK_SECRET && providedSecret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized webhook' });
  }

  clearCache();
  notifyDisplays();
  res.json({ ok: true, displaysNotified: sseClients.size });
});

app.get('/api/routes/:screen', async (req, res) => {
  const screen = req.params.screen;
  if (!['current', 'from-school', 'pri-dismissal', 'friday-dismissal'].includes(screen)) {
    return res.status(404).json({ error: 'Unknown screen' });
  }

  try {
    const skipCache = req.query.fresh === '1';
    const result = await fetchRoutes(screen, { skipCache });
    res.json({ screen: result.screen, requestedScreen: screen, updatedAt: new Date().toISOString(), routes: result.routes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
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
