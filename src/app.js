'use strict';

const express = require('express');
const { createRateLimiter } = require('./rateLimiter');

function createApp({ limiter = createRateLimiter() } = {}) {
  const { rateLimit } = limiter;
  const app = express();

  const ok = (_req, res) => res.status(200).json({ ok: true });

 
  app.post('/ai/generate', rateLimit('ai'), ok);
  app.post('/ai/summarise', rateLimit('ai'), ok);
  app.get('/data/list', rateLimit('read'), ok);
  app.get('/data/export', rateLimit('read'), ok);

  app.get('/health', (_req, res) => res.status(200).json({ status: 'up' }));

  return app;
}

module.exports = { createApp };
