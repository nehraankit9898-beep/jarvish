// browser-smoke.ts — verify the browser engine end-to-end with real chromium:
// session → navigate → intel (form/checkout detection) → screenshot → takeover.
// Serves a local checkout page and enables the loopback opt-in for the test.
process.env.AGENTSCOPE_BROWSER_ALLOW_LOOPBACK = '1';
import http from 'node:http';
import {
  createSession,
  navigate,
  readPage,
  takeControl,
  releaseControl,
  closeSession,
  listSessions,
  screenshot,
} from '../src/lib/agentic/browser/browser-service';

const HTML = `<!doctype html><html><head><title>Checkout Test</title></head><body>
  <h1>Order summary</h1>
  <form id="checkout">
    <label>Email <input name="email" type="email"></label>
    <label>Card number <input name="cardnumber" autocomplete="cc-number"></label>
    <label>CVV <input name="cvv" autocomplete="cc-csc"></label>
    <button type="submit">Pay now</button>
  </form></body></html>`;

async function main() {
  // tiny local page server
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
  });
  await new Promise<void>((r) => server.listen(4123, '127.0.0.1', r));

  const session = await createSession('');
  console.log('session created:', session.id);

  const intel = await navigate(session.id, 'http://127.0.0.1:4123/');
  console.log('intel dump:', JSON.stringify({
    url: intel.url,
    title: intel.title,
    forms: intel.forms.length,
    payment: intel.payment,
    checkout: intel.checkout,
  }, null, 1).slice(0, 900));
  console.log('page title ok:', intel.title === 'Checkout Test');
  console.log('forms found:', intel.forms.length);
  console.log('payment detected:', intel.payment?.detected);

  const shot = await screenshot(session.id);
  console.log('screenshot bytes:', shot.base64.length > 100);

  await takeControl(session.id);
  const sessions = await listSessions();
  const held = sessions.find((s) => s.id === session.id);
  console.log('takeover active:', held?.userHold === true);

  // while on hold, an AGENT navigation must be refused
  try {
    await navigate(session.id, 'http://127.0.0.1:4123/', { actor: 'agent' });
    console.log('AGENT NAVIGATE DURING TAKEOVER: NOT BLOCKED (BUG!)');
  } catch {
    console.log('agent navigate during takeover refused: true');
  }

  await releaseControl(session.id);
  console.log('released, intel refreshed:', Boolean(await readPage(session.id)));

  await closeSession(session.id);
  server.close();
  console.log('closed. SMOKE OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});

