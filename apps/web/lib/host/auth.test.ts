import { describe, expect, it } from 'vitest';
import { HOST_HEADER, hostSecretFromEnv, isAuthorizedHost } from './auth';

describe('host auth', () => {
  it('reads HOST_SECRET and treats blank as unset', () => {
    expect(hostSecretFromEnv({ HOST_SECRET: ' s3cret ' })).toBe('s3cret');
    expect(hostSecretFromEnv({ HOST_SECRET: '   ' })).toBeNull();
    expect(hostSecretFromEnv({})).toBeNull();
  });

  it('accepts only the exact secret in the x-blockbeat-host header', () => {
    const headers = (v: string | null) => new Headers(v === null ? {} : { [HOST_HEADER]: v });
    expect(isAuthorizedHost(headers('abc'), 'abc')).toBe(true);
    expect(isAuthorizedHost(headers('abd'), 'abc')).toBe(false);
    expect(isAuthorizedHost(headers('abcd'), 'abc')).toBe(false);
    expect(isAuthorizedHost(headers(''), 'abc')).toBe(false);
    expect(isAuthorizedHost(headers(null), 'abc')).toBe(false);
  });

  it('never authorizes when no secret is configured', () => {
    expect(isAuthorizedHost(new Headers({ [HOST_HEADER]: '' }), null)).toBe(false);
    expect(isAuthorizedHost(new Headers({ [HOST_HEADER]: 'x' }), null)).toBe(false);
  });
});
