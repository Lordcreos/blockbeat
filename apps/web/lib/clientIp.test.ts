import { describe, expect, it } from 'vitest';
import { clientIp } from './clientIp';

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/x', { method: 'POST', headers });
}

describe('clientIp (review H5)', () => {
  it('prefers cf-connecting-ip, which only the Cloudflare tunnel sets', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': 'spoofed, 203.0.113.5', 'x-real-ip': '1.2.3.4' }))).toBe('198.51.100.7');
  });

  it('falls back to the right-most x-forwarded-for hop, never the first', () => {
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 203.0.113.5' }))).toBe('203.0.113.5');
    expect(clientIp(req({ 'x-forwarded-for': ' 203.0.113.9 ' }))).toBe('203.0.113.9');
  });

  it('never trusts x-real-ip: the tunnel does not set it, so it is fully client-controlled', () => {
    expect(clientIp(req({ 'x-real-ip': '1.2.3.4' }))).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('reports unknown without any proxy header', () => {
    expect(clientIp(req({}))).toBe('unknown');
    expect(clientIp(req({ 'cf-connecting-ip': '   ', 'x-forwarded-for': ' , ' }))).toBe('unknown');
  });
});
