// Local preview has its own origin; production uses `npm start` with an explicit origin.
process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '4321';
process.env.EMDASH_SITE_URL ??= `http://localhost:${process.env.PORT}`;
await import('../dist/server/entry.mjs');
