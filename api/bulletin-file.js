// Proxies the current public Bulletin Blob through the bus-screen domain.
// This avoids school-network/browser issues loading Vercel Blob CDN URLs directly.
module.exports = async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const rawUrl = requestUrl.searchParams.get('url');

    if (!rawUrl) {
      res.status(400).json({ error: 'Missing bulletin file URL.' });
      return;
    }

    let target;
    try {
      target = new URL(rawUrl);
    } catch (error) {
      res.status(400).json({ error: 'Invalid bulletin file URL.' });
      return;
    }

    const allowedHost =
      target.protocol === 'https:' &&
      target.hostname.endsWith('.public.blob.vercel-storage.com');

    if (!allowedHost) {
      res.status(400).json({ error: 'Invalid bulletin storage host.' });
      return;
    }

    const upstream = await fetch(target.toString(), { redirect: 'follow' });
    if (!upstream.ok) {
      res.status(upstream.status || 502).json({
        error: `Could not load bulletin file (${upstream.status}).`,
      });
      return;
    }

    const contentType = (upstream.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();

    const allowedTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
    ]);

    if (!allowedTypes.has(contentType)) {
      res.status(415).json({ error: `Unsupported bulletin file type: ${contentType}` });
      return;
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    res.end(bytes);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not load bulletin file.' });
  }
};
