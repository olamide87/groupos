import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { canonicalIp, clientIp, enforceProxyBoundary, readProxyPolicy, type ProxyPolicy } from './proxy.js';
import { createApp } from './app.js';

test('recovery queue health is not exposed by public HTTP routes', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const path of ['/health/recovery', '/api/v1/auth/recovery-health']) {
      const response: globalThis.Response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status, 404); await response.text();
    }
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'groupos-api' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

const trusted: ProxyPolicy = { mode: 'trusted', chain: ['10.0.0.2'], host: 'app.example.test' };
const headers = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.test' };
function request(policy: ProxyPolicy, peer: string, values: Record<string, string>, duplicate?: string) {
  const req = { socket: { remoteAddress: peer }, headers: values,
    rawHeaders: [...Object.entries(values).flat(), ...(duplicate ? [duplicate, values[duplicate]] : [])] } as unknown as Request;
  let error: unknown;
  enforceProxyBoundary(policy)(req, {} as Response, e => { error = e; });
  return { error, ip: error ? undefined : clientIp(req) };
}

test('proxy production configuration rejects implicit trust, CIDRs, hop counts and ambiguous topology', () => {
  assert.deepEqual(readProxyPolicy({}), { mode: 'direct' });
  assert.throws(() => readProxyPolicy({ NODE_ENV: 'production' }));
  assert.throws(() => readProxyPolicy({ API_PROXY_MODE: 'direct', API_TRUSTED_PROXY_CHAIN: '["127.0.0.1"]' }));
  for (const chain of ['null', '[]', '[true]', '["10.0.0.0/8"]', '["loopback"]', '["0.0.0.0"]', '["127.0.0.1","::ffff:127.0.0.1"]']) {
    assert.throws(() => readProxyPolicy({ API_PROXY_MODE: 'trusted', API_TRUSTED_PROXY_CHAIN: chain, AUTH_ORIGIN: 'https://app.example.test' }));
  }
  assert.deepEqual(readProxyPolicy({ API_PROXY_MODE: 'trusted', API_TRUSTED_PROXY_CHAIN: '["10.0.0.2"]', AUTH_ORIGIN: 'https://app.example.test' }), trusted);
});

test('direct mode ignores forged forwarded identities and normalizes mapped IPv4', () => {
  assert.equal(request({ mode: 'direct' }, '::ffff:127.0.0.1', { ...headers, forwarded: 'for=evil' }).ip, '127.0.0.1');
  assert.equal(canonicalIp('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
});

test('trusted mode requires the exact peer and single canonical forwarding contract', () => {
  assert.equal(request(trusted, '10.0.0.2', headers).ip, '203.0.113.9');
  assert.ok(request(trusted, '203.0.113.7', headers).error);
  const changes: Record<string, string>[] = [
    { 'x-forwarded-for': '203.0.113.9, 203.0.113.8' }, { 'x-forwarded-for': 'unknown' },
    { 'x-forwarded-for': '203.0.113.9:1234' }, { 'x-forwarded-for': '10.0.0.2' },
    { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' },
    { 'x-forwarded-host': 'evil.test' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' },
  ];
  for (const changed of changes) assert.ok(request(trusted, '10.0.0.2', { ...headers, ...changed }).error);
  for (const name of Object.keys(headers)) {
    assert.ok(request(trusted, '10.0.0.2', headers, name).error);
    const missing = { ...headers }; delete missing[name as keyof typeof headers];
    assert.ok(request(trusted, '10.0.0.2', missing).error);
  }
});

test('multi-proxy paths require exact order and length; shorter and appended paths fail closed', () => {
  const policy: ProxyPolicy = { ...trusted, chain: ['10.0.0.2', '10.0.0.3', '10.0.0.4'] };
  assert.equal(request(policy, '10.0.0.2', { ...headers, 'x-forwarded-for': '203.0.113.9, 10.0.0.4, 10.0.0.3' }).ip, '203.0.113.9');
  for (const value of ['203.0.113.9', '203.0.113.9, 10.0.0.3, 10.0.0.4', '203.0.113.8, 203.0.113.9, 10.0.0.4, 10.0.0.3']) {
    assert.ok(request(policy, '10.0.0.2', { ...headers, 'x-forwarded-for': value }).error);
  }
});
