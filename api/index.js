// Prefer the explicitly named public Bulletin Blob store when present.
// Vercel's Blob SDK reads the standard BLOB_* environment variables, so
// alias the A_BLOB_STORE_ID before loading the app. Keep the standard
// BLOB_READ_WRITE_TOKEN in place because the new public store is exposing
// its token under that standard variable name.
if (process.env.A_BLOB_STORE_ID) {
  process.env.BLOB_STORE_ID = process.env.A_BLOB_STORE_ID;
}

const app = require('../server.js');

// The school network has had trouble loading Vercel Blob URLs directly in the browser.
// Proxy bulletin files through this app's own domain so the kiosk only talks to the
// already-working bus-screen host. Restrict the target to Vercel's public Blob CDN
// to avoid turning this into an open proxy.
module.exports = async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname === '/api/bulletin/file') {
      const rawUrl = requestUrl.searchParams.get('url');
      if (!rawUrl) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing bulletin file URL.' }));
        return;
      }

      let target;
      try {
        target = new URL(rawUrl);
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Invalid bulletin file URL.' }));
        return;
      }

      const allowedHost = target.protocol === 'https:' && target.hostname.endsWith('.public.blob.vercel-storage.com');
      if (!allowedHost) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Invalid bulletin storage host.' }));
        return;
      }

      const upstream = await fetch(target.toString(), { redirect: 'follow' });
      if (!upstream.ok) {
        res.statusCode = upstream.status || 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Could not load bulletin file (${upstream.status}).` }));
        return;
      }

      const contentType = (upstream.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
      if (!allowedTypes.has(contentType)) {
        res.statusCode = 415;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unsupported bulletin file type.' }));
        return;
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Disposition', 'inline');
      res.end(bytes);
      return;
    }
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message || 'Could not load bulletin file.' }));
      return;
    }
  }

  return app(req, res);
};
