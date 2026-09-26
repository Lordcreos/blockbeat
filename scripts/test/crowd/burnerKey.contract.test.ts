import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BURNER_STORAGE_KEY } from '../../src/lib/crowd/ui/playwright';

describe('visible mode reads the join page burner where the page keeps it (W19)', () => {
  it('matches apps/web/lib/burner.ts BURNER_STORAGE_KEY', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../apps/web/lib/burner.ts'), 'utf8');
    expect(source).toContain(`export const BURNER_STORAGE_KEY = '${BURNER_STORAGE_KEY}';`);
  });
});
