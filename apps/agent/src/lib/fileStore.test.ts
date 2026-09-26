import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileStore } from './fileStore';

describe('file store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockbeat-agent-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when the file is missing, then round-trips with owner-only permissions', () => {
    const store = createFileStore(join(dir, 'nested', '.agent.json'));
    expect(store.read()).toBeNull();
    store.write('{"agentId":"1"}');
    expect(store.read()).toBe('{"agentId":"1"}');
    expect(readFileSync(join(dir, 'nested', '.agent.json'), 'utf8')).toBe('{"agentId":"1"}');
    expect(statSync(join(dir, 'nested', '.agent.json')).mode & 0o777).toBe(0o600);
  });
});
