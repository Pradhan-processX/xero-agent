'use strict';
// One-time OAuth consent to create the single org connection.
// Run: npm run auth   -> open the printed URL, authorise AS A STANDARD/ADVISER USER,
// then the callback is captured here and tokens are saved to XERO_TOKEN_FILE.
const express = require('express');
const config = require('./config');
const xero = require('./xero');

const url = new URL(config.xero.redirectUri);
const port = url.port || 3000;

const app = express();

app.get(url.pathname, async (req, res) => {
  try {
    const fullUrl = `${config.xero.redirectUri}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
    const { tenants } = await xero.handleCallback(fullUrl);
    const list = (tenants || []).map((t) => `  - ${t.tenantName} (${t.tenantId})`).join('\n');
    console.log('\n✅ Tokens saved. Connected org(s):\n' + list + '\n');
    res.send('<h3>Connected. You can close this tab and return to the terminal.</h3>');
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error('Auth failed:', err.message);
    res.status(500).send('Auth failed: ' + err.message);
    setTimeout(() => process.exit(1), 500);
  }
});

app.listen(port, async () => {
  const consent = await xero.buildConsentUrl();
  console.log('\n1) Sign into Xero AS A STANDARD or ADVISER user (so the connection can log time for everyone).');
  console.log('2) Open this URL in your browser:\n');
  console.log('   ' + consent + '\n');
  console.log(`Waiting for the callback on ${config.xero.redirectUri} ...`);
});
