/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Two jobs:
 *  1. report an invalid environment at BOOT instead of letting the first
 *     request fail with a confusing error (never throws — the Studio stays
 *     reachable so the user can read the report in the UI, System → Status);
 *  2. start the PERSISTENT BACKGROUND RUNTIME (schedule ticker, startup
 *     recovery, retry/unblock scans, proactive suggestions) so automation
 *     keeps working while no request is in flight and the browser tab is
 *     closed (Feature 3/5/8 of the platform spec).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { validateEnv } = await import('./lib/agentic/env');
  const report = validateEnv();

  for (const issue of report.issues) {
    const line = `[env] ${issue.severity.toUpperCase()} ${issue.name}: ${issue.message}`;
    if (issue.severity === 'error') {
      console.error(line);
    } else {
      console.warn(line);
    }
  }

  if (report.ok) {
    console.log(
      `[env] configuration OK — ${report.present.length} variable(s) configured (values are never logged).`
    );
  }

  // The background runtime can be disabled explicitly (e.g. for tests or a
  // dev instance that must stay quiet). It is idempotent, so a hot reload
  // never stacks tickers.
  // AGENTSCOPE_BACKGROUND_RUNTIME=external → the standalone worker (bun run worker)
  // is the only ticker; the server never starts one.
  if (!['0', 'external'].includes(process.env.AGENTSCOPE_BACKGROUND_RUNTIME ?? '')) {
    const { startBackgroundRuntime } = await import('./lib/agentic/background');
    startBackgroundRuntime();
  }
}
