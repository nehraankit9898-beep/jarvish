import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';

function request(path: string, method: string, ip: string) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { 'x-real-ip': ip } });
}

test('read polling does not exhaust the write budget', () => {
  for (let i = 0; i < 60; i++) expect(proxy(request('/api/settings', 'GET', 'read-write')).status).toBe(200);
  expect(proxy(request('/api/settings', 'POST', 'read-write')).status).toBe(200);
});

test('429 includes retry timing and rate limit metadata', () => {
  let response = proxy(request('/api/chat', 'POST', 'retry'));
  for (let i = 1; i <= 20; i++) response = proxy(request('/api/chat', 'POST', 'retry'));
  expect(response.status).toBe(429);
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
  expect(response.headers.get('X-RateLimit-Limit')).toBe('20');
});

test('similarly named routes do not inherit expensive route limits', () => {
  for (let i = 0; i < 21; i++) expect(proxy(request('/api/chat-history', 'GET', 'prefix')).status).toBe(200);
});
