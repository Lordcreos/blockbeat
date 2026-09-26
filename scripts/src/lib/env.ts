/**
 * Key handling. Keys come from process.env or $HOME/.blockbeat/keys.env and are never
 * printed; every log line passes through redactSecrets as a last line of defence.
 */
import { ANVIL_ID } from '@blockbeat/shared';
import type { Hex } from 'viem';

export type Role = 'deployer' | 'drip' | 'agent';

/** Foundry's default anvil mnemonic accounts (public knowledge, local chain only). */
export const ANVIL_ACCOUNTS = [
  { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
] as const;

const ROLE_ENV: Record<Role, string> = {
  deployer: 'DEPLOYER_PRIVATE_KEY',
  drip: 'DRIP_PRIVATE_KEY',
  agent: 'AGENT_PRIVATE_KEY',
};
const ROLE_ANVIL_INDEX: Record<Role, 0 | 1 | 2> = { deployer: 0, drip: 1, agent: 2 };

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function parseKeysEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export interface ResolveKeyInput {
  chainId: number;
  env: Readonly<Record<string, string | undefined>>;
  role: Role;
}

/**
 * FUNDER_PRIVATE_KEY always wins. On the local anvil chain the role keys are ignored
 * (they are testnet keys with no local balance) and the well-known anvil accounts are
 * used; elsewhere the role key is required.
 */
export function resolveKey({ chainId, env, role }: ResolveKeyInput): { key: Hex; source: string } {
  const candidates: Array<[string, string | undefined]> = [['FUNDER_PRIVATE_KEY', env['FUNDER_PRIVATE_KEY']]];
  if (chainId !== ANVIL_ID) candidates.push([ROLE_ENV[role], env[ROLE_ENV[role]]]);
  for (const [source, value] of candidates) {
    if (value === undefined || value.trim() === '') continue;
    const key = value.trim();
    if (!KEY_RE.test(key)) throw new Error(`${source} is not a 0x-prefixed 32-byte hex key`);
    return { key: key as Hex, source };
  }
  if (chainId === ANVIL_ID) {
    const idx = ROLE_ANVIL_INDEX[role];
    return { key: ANVIL_ACCOUNTS[idx].key, source: `anvil:${idx}` };
  }
  throw new Error(`no key for role "${role}" on chain ${chainId}: set FUNDER_PRIVATE_KEY or ${ROLE_ENV[role]} (env or ~/.blockbeat/keys.env)`);
}

/**
 * Replaces registered secret values wherever they appear. Only exact values are redacted:
 * a transaction hash has the same shape as a key and must stay readable in logs.
 */
const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{20,}$/;

/**
 * Provider URLs carry API keys in the path (Alchemy, QuickNode), the query string or the
 * userinfo. Returns the sensitive substrings so they can be registered as secrets.
 */
export function urlSecrets(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (parsed.password) out.push(parsed.password);
  for (const [, value] of parsed.searchParams) if (value.length >= 8) out.push(value);
  for (const segment of parsed.pathname.split('/')) if (TOKEN_SEGMENT_RE.test(segment)) out.push(segment);
  return out;
}

/** Same URL with every secret part replaced, safe to print and commit. */
export function redactUrl(url: string): string {
  return redactSecrets(url, urlSecrets(url));
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '[redacted-key]');
  }
  return out;
}
