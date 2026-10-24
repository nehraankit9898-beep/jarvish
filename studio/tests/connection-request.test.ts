import { describe, expect, test } from 'bun:test';
import { connectionRequestSchema } from '../src/lib/connection-request';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/test-connection/route';

describe('connection request validation', () => {
  test('normalizes valid input without requiring a key for local providers', () => {
    expect(connectionRequestSchema.parse({ provider: ' ollama ', model: ' llama3 ' })).toEqual({ provider: 'ollama', model: 'llama3' });
  });
  test('rejects missing, null, mistyped and oversized fields', () => {
    for (const value of [null, {}, [], { provider: 3 }, { provider: '' }, { provider: 'openai', apiKey: {} }, { provider: 'openai', model: 'x'.repeat(257) }]) {
      expect(connectionRequestSchema.safeParse(value).success).toBe(false);
    }
  });
  test('malformed bodies return 400 before contacting a provider', async () => {
    for (const body of ['{', 'null', '{"provider":42}']) {
      const response = await POST(new NextRequest('http://localhost/api/test-connection', {
        method: 'POST', body, headers: {
          'Content-Type': 'application/json',
          ...(process.env.AGENTSCOPE_API_TOKEN ? { 'x-agentscope-token': process.env.AGENTSCOPE_API_TOKEN } : {}),
        },
      }));
      expect(response.status).toBe(400);
      expect((await response.json()).ok).toBe(false);
    }
  });
});
