// render-panels.tsx — server-render every new panel once.
//
// It is a smoke test, not a UI test: it proves that each panel module
// imports cleanly and that its render function does not throw. The panels are
// client components, so the markup is rendered on the server and the
// `useEffect` hooks (the data loading) do not run.
//
// Run: bun run scripts/render-panels.tsx

import { renderToStaticMarkup } from 'react-dom/server';
import { ProvidersPanel } from '../src/components/studio/providers-panel';
import { MemoryPanel } from '../src/components/studio/memory-panel';
import { KnowledgePanel } from '../src/components/studio/knowledge-panel';
import { AutomationPanel } from '../src/components/studio/automation-panel';
import { AuditPanel } from '../src/components/studio/audit-panel';
import { SystemPanel } from '../src/components/studio/system-panel';
import { DashboardPanel } from '../src/components/studio/dashboard-panel';
import { LaptopPanel } from '../src/components/studio/laptop-panel';

const panels: [string, () => React.ReactElement][] = [
  ['ProvidersPanel', ProvidersPanel],
  ['MemoryPanel', MemoryPanel],
  ['KnowledgePanel', KnowledgePanel],
  ['AutomationPanel', AutomationPanel],
  ['AuditPanel', AuditPanel],
  ['SystemPanel', SystemPanel],
  ['DashboardPanel', DashboardPanel],
  ['LaptopPanel', LaptopPanel],
];

let failed = 0;
for (const [name, Panel] of panels) {
  try {
    const html = renderToStaticMarkup(<Panel />);
    if (html.length < 200) {
      console.log(`  ??  ${name}: rendered only ${html.length} characters`);
      failed++;
    } else {
      console.log(`  OK  ${name}: ${html.length} characters`);
    }
  } catch (err) {
    failed++;
    console.log(`  XX  ${name}: ${(err as Error).message}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} panel(s) failed to render`);
  process.exit(1);
}
console.log('\nall panels render without an error');
