'use strict';

/**
 * Netlify serverless function: Flymaster API proxy.
 *
 * Routes browser requests to lb.flymaster.net / lt.flymaster.net,
 * bypassing CORS restrictions. Only the two Flymaster hostnames are
 * whitelisted — all other targets are rejected with 403.
 *
 * Usage (browser → Netlify → Flymaster):
 *   GET /.netlify/functions/flymaster-proxy?url=https%3A%2F%2Flb.flymaster.net%2F...
 */

const https = require('https');
const { URL } = require('url');

const ALLOWED_HOSTS = new Set(['lb.flymaster.net', 'lt.flymaster.net']);
// 12 s gives Flymaster's backend enough time to respond even under load,
// while still failing fast enough not to block the Netlify function slot.
const TIMEOUT_MS = 12_000;

exports.handler = async event => {
  // ── Validate target URL ──────────────────────────────────────
  const rawUrl = (event.queryStringParameters || {}).url;

  if (!rawUrl) {
    return json(400, { error: 'Missing required parameter: url' });
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return json(400, { error: 'Invalid URL' });
  }

  if (target.protocol !== 'https:') {
    return json(400, { error: 'Only HTTPS targets are allowed' });
  }

  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return json(403, {
      error: `Host not allowed: ${target.hostname}`,
      allowed: [...ALLOWED_HOSTS],
    });
  }

  // ── Forward request to Flymaster ─────────────────────────────
  return new Promise(resolve => {
    const options = {
      hostname: target.hostname,
      path:     target.pathname + target.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0',
        'Accept':     'application/json, text/plain, */*',
      },
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: 200,
          headers: {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':               'no-store',
          },
          body,
        });
      });
    });

    req.on('error', err => {
      resolve(json(502, { error: `Upstream error: ${err.message}` }));
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve(json(504, { error: 'Upstream request timed out' }));
    });

    req.end();
  });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(obj),
  };
}
