// Prefer the explicitly named public Bulletin Blob store when present.
// Vercel's Blob SDK reads the standard BLOB_* environment variables, so
// alias the A_BLOB_* variables before loading the app. This leaves the old
// private Blob store connected but ensures Bulletin uploads use the public one.
if (process.env.A_BLOB_STORE_ID) {
  process.env.BLOB_STORE_ID = process.env.A_BLOB_STORE_ID;
}
if (process.env.A_BLOB_READ_WRITE_TOKEN) {
  process.env.BLOB_READ_WRITE_TOKEN = process.env.A_BLOB_READ_WRITE_TOKEN;
}

module.exports = require('../server.js');
