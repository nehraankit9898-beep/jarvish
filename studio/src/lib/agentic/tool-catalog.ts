// tool-catalog.ts — ONE place that assembles the complete tool catalog.
//
// The registry is a process-global map and every built-in family registers
// itself lazily (`registerPcTools()` etc. are idempotent, guarded per module).
// That works only if every entry point registers the SAME families — and it
// did not: `/api/tools` registered nine families, `/api/tools/invoke` six
// (memory / recollect / connector tools were missing, so the UI could not
// invoke them), `/api/tools/health` and `/api/system/status` registered
// NONE — their tool list was whatever some earlier request happened to leave
// behind (usually nothing on a fresh server, i.e. an empty health panel that
// looked like "no tools configured").
//
// Every route that lists, invokes or health-checks tools must call
// `ensureFullToolCatalog()` first.

import { registerBrowserTools } from './browser-tools';
import { registerConnectorTools } from './connector-tools';
import { registerDocumentTools } from './document-tools';
import { registerHostTools } from './host-tools';
import { registerInfoTools } from './info-tools';
import { registerLaptopTools } from './laptop-tools';
import { registerMemoryTools } from './memory-tools';
import { registerPcTools } from './pc-tools';
import { registerRecollectTools } from './recollect-tools';
import { loadActiveCustomTools } from './custom-tools';

let loaded = false;

/**
 * Register every built-in family and the APPROVED custom tools.
 *
 * Custom tools are (re)loaded on the first call only: a later call must not
 * resurrect a tool the user just deleted, and `custom-tools.ts` keeps its own
 * live set in sync on approve/disable/delete. Pass `{ refreshCustom: true }`
 * after a bulk import that bypassed those helpers.
 */
export async function ensureFullToolCatalog(opts: { refreshCustom?: boolean } = {}): Promise<void> {
  registerBrowserTools();
  registerHostTools();
  registerLaptopTools();
  registerMemoryTools();
  registerRecollectTools();
  registerConnectorTools();
  registerDocumentTools();
  registerInfoTools();
  registerPcTools();
  if (!loaded || opts.refreshCustom) {
    loaded = true;
    await loadActiveCustomTools().catch(() => 0);
  }
}

/** Test helper: forget that the custom tools were loaded. */
export function __resetToolCatalog(): void {
  loaded = false;
}
