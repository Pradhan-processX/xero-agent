'use strict';
// Diagnose Azure OpenAI 404s: tries several api-versions against the configured
// endpoint+deployment and reports the HTTP status for each. Key is never printed.
const config = require('./config');
const c = config.llm;

const versions = ['2024-06-01', '2024-08-01-preview', '2024-10-21', '2025-01-01-preview', '2025-04-01-preview'];

(async () => {
  console.log('endpoint  :', c.azureEndpoint || '(missing)');
  console.log('deployment:', c.azureDeployment || '(missing)');
  console.log('key       :', c.azureKey ? `set (${c.azureKey.length} chars)` : 'MISSING');
  const host = (() => { try { return new URL(c.azureEndpoint).host; } catch { return '(invalid URL)'; } })();
  console.log('host looks like *.openai.azure.com? :', /\.openai\.azure\.com$/.test(host) ? 'yes' : `NO -> "${host}"`);
  console.log('\nTrying api-versions:\n');

  for (const ver of versions) {
    const url = `${c.azureEndpoint}/openai/deployments/${c.azureDeployment}/chat/completions?api-version=${ver}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': c.azureKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
      });
      const text = await res.text();
      const short = text.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  ${ver.padEnd(22)} -> ${res.status} ${res.status === 200 ? '✅' : ''} ${res.status === 200 ? '' : short}`);
    } catch (e) {
      console.log(`  ${ver.padEnd(22)} -> ERROR ${e.message}`);
    }
  }
  console.log('\nIf ALL are 404: endpoint or deployment name is wrong (check exact name + that it is the Azure OpenAI endpoint).');
  console.log('If some are 200: set AZURE_OPENAI_API_VERSION in .env to a working one.');
})();
