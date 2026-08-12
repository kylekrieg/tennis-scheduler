'use strict';
require('dotenv').config();
const app = require('./app');
const cron = require('./services/cron');

const PORT = process.env.PORT || 3000;

// Last-resort safety net. Every async Express route handler in this app is
// wrapped in asyncHandler() (see src/middleware/asyncHandler.js), which
// should catch anything a route throws — but the cron loop and any future
// code path that isn't a wrapped route handler has no such wrapper. Node's
// default behavior for an unhandled promise rejection is to crash the whole
// process (since Node 15), which would take the entire site down for every
// player over one bad request or one bad tick, not just fail that one
// operation. Log and keep running instead — this app is meant to run
// unattended on a Pi for months, so staying up in a degraded way beats a
// silent full outage until someone notices and restarts it by hand.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection] kept the process alive, but this should be investigated:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception] kept the process alive, but this should be investigated:', err);
});

app.listen(PORT, () => {
  console.log(`Tennis doubles scheduler listening on http://localhost:${PORT}`);
  cron.start();
});
