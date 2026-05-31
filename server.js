const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appEoktGjwEeUP9GX';
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Bus routes';
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

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
};

const sseClients = new Set();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function clearCache() {
  cache = { fetchedAt: 0, records: [], recordsByScreen: {} };
}

function notifyDisplays() {
  const payload = `data: ${JSON.stringify({ type: 'refresh', at: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function buildFormula(screen) {
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

function normalizeLinkedSpot(value) {
  if (!value) return '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && item.name) return item.name;
      return String(item);
    }).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  return String(value);
}

function normalizeRecord(record) {
  const fields = record.fields || {};
  return {
    id: record.id,
    name: fields[FIELD_NAMES.name] || 'Bus',
    status: normalizeSingleSelect(fields[FIELD_NAMES.status]) || 'Waiting',
    spot: normalizeLinkedSpot(fields[FIELD_NAMES.spot]) || '',
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

async function fetchRoutes(screen, options = {}) {
  if (!AIRTABLE_TOKEN) {
    throw new Error('Missing AIRTABLE_TOKEN environment variable. Add it in Render, not GitHub.');
  }

  const now = Date.now();
  const skipCache = options.skipCache === true;
  const cacheValid = !skipCache && cache.recordsByScreen && cache.recordsByScreen[screen] && now - cache.recordsByScreen[screen].fetchedAt < CACHE_SECONDS * 1000;
  if (cacheValid) {
    return cache.recordsByScreen[screen].records;
  }

  const formula = buildFormula(screen);
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

  const records = allRecords.map(normalizeRecord).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  cache.recordsByScreen = cache.recordsByScreen || {};
  cache.recordsByScreen[screen] = { fetchedAt: now, records };
  return records;
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
  if (!['from-school', 'pri-dismissal', 'friday-dismissal'].includes(screen)) {
    return res.status(404).json({ error: 'Unknown screen' });
  }

  try {
    const skipCache = req.query.fresh === '1';
    const routes = await fetchRoutes(screen, { skipCache });
    res.json({ screen, updatedAt: new Date().toISOString(), routes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get(['/from-school', '/pri-dismissal', '/friday-dismissal'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/', (req, res) => {
  res.redirect('/from-school');
});

app.listen(PORT, () => {
  console.log(`Bus screen running on port ${PORT}`);
});
