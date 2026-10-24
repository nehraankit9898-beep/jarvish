import { execFile } from 'child_process';
import path from 'path';
import type { NextRequest } from 'next/server';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

function findPython(): Promise<string | null> {
  return new Promise((resolve) => {
    const candidates = process.env.AGENTSCOPE_PYTHON
      ? [process.env.AGENTSCOPE_PYTHON]
      : ['python3', 'python'];
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(null);
      const bin = candidates[i++];
      execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return tryNext();
        resolve(bin);
        void stdout;
      });
    };
    tryNext();
  });
}

export async function GET(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;
  const python = await findPython();
  if (!python) {
    return Response.json({
      ok: false,
      python: null,
      agentscope: null,
      hint: 'Python hi nahi mila. Python 3.10+ install karo ya AGENTSCOPE_PYTHON env var set karo.',
    });
  }

  const version = await new Promise<string>((resolve) => {
    execFile(python, ['--version'], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? '?' : String(stdout).trim())
    );
  });

  const agentscope = await new Promise<string | null>((resolve) => {
    execFile(
      python,
      ['-c', 'import agentscope; print(getattr(agentscope, "__version__", "unknown"))'],
      { timeout: 20_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim())
    );
  });

  return Response.json({
    ok: Boolean(agentscope),
    python: version,
    agentscope,
    bridgePath: path.join(process.cwd(), 'python-bridge', 'runner.py'),
    hint: agentscope
      ? 'AgentScope Python ready — Studio agents ko Python engine se chala sakte ho.'
      : "pip install -e ./agentscope chalao (repo ke 'agentscope' folder me), phir Studio restart karo.",
  });
}
