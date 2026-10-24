import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import path from 'path';
import { db } from '@/lib/db';
import { rejectIfUnauthorized } from '@/lib/agentic/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 180;

/**
 * POST — run a Studio agent through REAL AgentScope Python.
 * Body: { agentId?: string, prompt: string, provider?, apiKey?, model?, baseUrl?, temperature? }
 * AgentScope classes used (via python-bridge/runner.py):
 *   agentscope.agent.Agent + Msg/TextBlock + provider credential/chat model
 */
export async function POST(req: NextRequest) {
  const denied = rejectIfUnauthorized(req);
  if (denied) return denied;

  try {
    const body = (await req.json()) as {
      agentId?: string;
      prompt?: string;
      provider?: string;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      temperature?: number;
    };
    const prompt = body.prompt?.trim();
    if (!prompt) {
      return Response.json({ error: 'prompt required' }, { status: 400 });
    }

    // Agent config from DB (reuse existing agents — no duplicate config)
    let systemPrompt = 'You are a helpful assistant inside AgentScope Studio.';
    let agentName = 'StudioAgent';
    let provider = body.provider || 'zai';
    let model = body.model || '';
    let temperature = body.temperature ?? 0.7;
    if (body.agentId) {
      const agent = await db.agent.findUnique({ where: { id: body.agentId } });
      if (agent) {
        systemPrompt = agent.systemPrompt;
        agentName = agent.name;
        provider = body.provider || agent.provider;
        model = body.model || agent.model;
        temperature = body.temperature ?? agent.temperature;
      }
    }

    const pythonBin = process.env.AGENTSCOPE_PYTHON || 'python3';
    const runner = path.join(process.cwd(), 'python-bridge', 'runner.py');
    const payload = JSON.stringify({
      prompt,
      agentName,
      systemPrompt,
      provider,
      apiKey: body.apiKey || '',
      model,
      baseUrl: body.baseUrl || '',
      temperature,
    });

    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        pythonBin,
        [runner],
        { timeout: 150_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) return reject(err);
          resolve(String(stdout));
        }
      );
      child.stdin?.write(payload);
      child.stdin?.end();
    }).catch((err) => {
      throw new Error(
        `Python bridge fail: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    // runner prints a single JSON line
    const jsonLine = result.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine);
    if (!parsed.ok) {
      return Response.json(parsed, { status: 502 });
    }
    return Response.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bridge error';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
