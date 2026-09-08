// Prefer the explicitly named public Bulletin Blob store when present.
// Vercel's Blob SDK reads the standard BLOB_* environment variables, so
// alias the A_BLOB_STORE_ID before loading the app. Keep the standard
// BLOB_READ_WRITE_TOKEN in place because the new public store is exposing
// its token under that standard variable name.
if (process.env.A_BLOB_STORE_ID) {
  process.env.BLOB_STORE_ID = process.env.A_BLOB_STORE_ID;
}

module.exports = require('../server.js');
