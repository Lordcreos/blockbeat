import { describe, expect, it } from 'vitest';
import { MONAD_TESTNET_ID, blockbeatAddress } from '@blockbeat/shared';
import { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_TIMEOUT_MS, loadConfig } from './config';

/** Anvil's published default account 1 key: a well-known local dev key, not a secret. */
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('config', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' });
    expect(c.chainId).toBe(MONAD_TESTNET_ID);
    expect(c.rpcUrl).toBe('https://testnet-rpc.monad.xyz');
    expect(c.wsUrl).toBe('wss://testnet-rpc.monad.xyz');
    expect(c.enabled).toBe(true);
    expect(c.maxHitsPerSession).toBe(160); // W17: a phrase is up to 8 notes a bar
    expect(c.maxNotesPerBar).toBe(8);
    expect(c.key).toEqual({ tonic: 9, mode: 'minor' });
    expect(c.debugLlm).toBe(false);
    expect(c.setStartBar).toBe(0);
    expect(c.sessionId).toBe(1n);
    expect(c.anthropicApiKey).toBeNull();
    expect(c.model).toBe('claude-sonnet-5');
    expect(c.blockbeatAddress).toBe(blockbeatAddress(MONAD_TESTNET_ID));
    expect(c.bars).toBeNull();
    expect(c.decay).toEqual({ lifetimeBars: 8, maxLivePerTrack: 6 });
  });

  it('W13: reads the same decay knobs as the stage (NEXT_PUBLIC_*), 0 = off, and refuses nonsense', () => {
    const c = loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', NEXT_PUBLIC_NOTE_LIFETIME_BARS: '0', NEXT_PUBLIC_MAX_LIVE_PER_TRACK: '4' });
    expect(c.decay).toEqual({ lifetimeBars: 0, maxLivePerTrack: 4 });
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', NEXT_PUBLIC_NOTE_LIFETIME_BARS: 'x' })).toThrow(/NOTE_LIFETIME_BARS/);
  });

  it('W17: reads the per-bar cap (0..8), the key and the LLM debug switch, and refuses nonsense', () => {
    const base = { AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' };
    const c = loadConfig({ ...base, AGENT_MAX_NOTES_PER_BAR: '3', AGENT_KEY: 'D minor', AGENT_DEBUG_LLM: '1' });
    expect(c.maxNotesPerBar).toBe(3);
    expect(c.key).toEqual({ tonic: 2, mode: 'minor' });
    expect(c.debugLlm).toBe(true);
    expect(loadConfig({ ...base, AGENT_MAX_NOTES_PER_BAR: '0' }).maxNotesPerBar).toBe(0);
    expect(() => loadConfig({ ...base, AGENT_MAX_NOTES_PER_BAR: '9' })).toThrow(/AGENT_MAX_NOTES_PER_BAR/);
    expect(() => loadConfig({ ...base, AGENT_KEY: 'H dorian' })).toThrow(/AGENT_KEY/);
    expect(loadConfig({ ...base, AGENT_SET_START_BAR: '8' }).setStartBar).toBe(8);
    expect(() => loadConfig({ ...base, AGENT_SET_START_BAR: '-1' })).toThrow(/AGENT_SET_START_BAR/);
  });

  it('reads overrides for anvil', () => {
    const c = loadConfig({
      AGENT_PRIVATE_KEY: KEY,
      AGENT_SESSION_ID: '3',
      AGENT_CHAIN_ID: '31337',
      AGENT_RPC_URL: 'http://127.0.0.1:8545',
      BLOCKBEAT_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      AGENT_ENABLED: 'false',
      AGENT_MAX_HITS_PER_SESSION: '12',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      AGENT_BARS: '4',
    });
    expect(c.chainId).toBe(31337);
    expect(c.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(c.wsUrl).toBe('ws://127.0.0.1:8545');
    expect(c.blockbeatAddress).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
    expect(c.enabled).toBe(false);
    expect(c.maxHitsPerSession).toBe(12);
    expect(c.anthropicApiKey).toBe('sk-ant-x');
    expect(c.bars).toBe(4);
  });

  it('rejects a missing or malformed private key without echoing it', () => {
    expect(() => loadConfig({ AGENT_SESSION_ID: '1' })).toThrow(/AGENT_PRIVATE_KEY/);
    let message = '';
    try {
      loadConfig({ AGENT_PRIVATE_KEY: 'deadbeef', AGENT_SESSION_ID: '1' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/AGENT_PRIVATE_KEY/);
    expect(message).not.toContain('deadbeef');
  });

  it('refuses an unknown chain id without an explicit RPC URL instead of defaulting to testnet', () => {
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', AGENT_CHAIN_ID: '999' })).toThrow(/AGENT_RPC_URL/);
    const c = loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', AGENT_CHAIN_ID: '999', AGENT_RPC_URL: 'http://localhost:9999' });
    expect(c.chainId).toBe(999);
    expect(c.wsUrl).toBe('ws://localhost:9999');
  });

  it('accepts --session <id> on the command line over AGENT_SESSION_ID (review M9)', () => {
    expect(loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' }, ['--session', '42']).sessionId).toBe(42n);
    expect(loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' }, ['--session=43']).sessionId).toBe(43n);
    expect(loadConfig({ AGENT_PRIVATE_KEY: KEY }, ['--session', '44']).sessionId).toBe(44n);
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' }, ['--session', 'x'])).toThrow(/--session/);
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' }, ['--session'])).toThrow(/--session/);
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' }, ['--bogus'])).toThrow(/--bogus/);
  });

  it('rejects bad numbers and addresses', () => {
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: 'x' })).toThrow(/AGENT_SESSION_ID/);
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', AGENT_MAX_HITS_PER_SESSION: '-1' })).toThrow(/AGENT_MAX_HITS_PER_SESSION/);
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', BLOCKBEAT_ADDRESS: '0x12' })).toThrow(/BLOCKBEAT_ADDRESS/);
    expect(() => loadConfig({ AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1', AGENT_CHAIN_ID: 'abc' })).toThrow(/AGENT_CHAIN_ID/);
  });

  describe('brain selection (W12)', () => {
    const base = { AGENT_PRIVATE_KEY: KEY, AGENT_SESSION_ID: '1' };

    it('defaults to anthropic, else openai, else gemini, else rules (W14b)', () => {
      expect(loadConfig(base).brain).toBe('rules');
      expect(loadConfig({ ...base, OPENAI_API_KEY: 'sk-o' }).brain).toBe('openai');
      expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' }).brain).toBe('anthropic');
      // W14b: the user picked OpenAI; gemini is dormant and only wins without an OpenAI key.
      expect(loadConfig({ ...base, GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'sk-o' }).brain).toBe('openai');
      expect(loadConfig({ ...base, GOOGLE_API_KEY: 'g' }).brain).toBe('gemini');
      expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-a', GEMINI_API_KEY: 'g' }).brain).toBe('anthropic');
      expect(loadConfig({ ...base, GEMINI_API_KEY: '  ' }).brain).toBe('rules');
    });

    it('reads the Gemini key (GEMINI_API_KEY wins over GOOGLE_API_KEY), model and its own default timeout (W14)', () => {
      const c = loadConfig({ ...base, GEMINI_API_KEY: 'g-1', GOOGLE_API_KEY: 'g-2' });
      expect(c.geminiApiKey).toBe('g-1');
      expect(c.geminiModel).toBe(DEFAULT_GEMINI_MODEL);
      expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.6-flash');
      expect(DEFAULT_GEMINI_TIMEOUT_MS).toBe(4000);
      expect(c.geminiRpm).toBe(5);
      expect(loadConfig({ ...base, GEMINI_API_KEY: 'g', GEMINI_RPM: '0' }).geminiRpm).toBe(0);
      expect(loadConfig({ ...base, GEMINI_API_KEY: 'g', GEMINI_RPM: '1000' }).geminiRpm).toBe(1000);
      expect(() => loadConfig({ ...base, GEMINI_API_KEY: 'g', GEMINI_RPM: '-1' })).toThrow(/GEMINI_RPM/);
      expect(c.llmTimeoutMs).toBe(DEFAULT_GEMINI_TIMEOUT_MS);
      expect(loadConfig({ ...base, GOOGLE_API_KEY: 'g-2' }).geminiApiKey).toBe('g-2');
      expect(loadConfig({ ...base, GEMINI_API_KEY: 'g', GEMINI_MODEL: ' gemini-x-flash ' }).geminiModel).toBe('gemini-x-flash');
      expect(loadConfig({ ...base, GEMINI_API_KEY: 'g', AGENT_LLM_TIMEOUT_MS: '2500' }).llmTimeoutMs).toBe(2500);
      expect(loadConfig({ ...base, OPENAI_API_KEY: 'sk-o' }).llmTimeoutMs).toBe(4000);
      expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-a' }).llmTimeoutMs).toBe(3000);
      expect(() => loadConfig({ ...base, AGENT_BRAIN: 'gemini' })).toThrow(/AGENT_BRAIN=gemini needs GEMINI_API_KEY/);
      expect(loadConfig({ ...base, AGENT_BRAIN: 'Gemini', GOOGLE_API_KEY: 'g', ANTHROPIC_API_KEY: 'sk-a' }).brain).toBe('gemini');
    });

    it('honours AGENT_BRAIN and refuses a brain without its key', () => {
      expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', AGENT_BRAIN: 'openai' }).brain).toBe('openai');
      expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-a', AGENT_BRAIN: 'rules' }).brain).toBe('rules');
      expect(loadConfig({ ...base, AGENT_BRAIN: ' OpenAI ', OPENAI_API_KEY: 'sk-o' }).brain).toBe('openai');
      expect(() => loadConfig({ ...base, AGENT_BRAIN: 'openai' })).toThrow(/OPENAI_API_KEY/);
      expect(() => loadConfig({ ...base, AGENT_BRAIN: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
      expect(() => loadConfig({ ...base, AGENT_BRAIN: 'llama' })).toThrow(/AGENT_BRAIN must be anthropic, gemini, openai or rules/);
    });

    it('W14b: reasoning effort defaults to none for gpt-6-luna, model default otherwise, and is validated', () => {
      expect(loadConfig({ ...base, OPENAI_API_KEY: 'sk-o' }).openaiReasoningEffort).toBe('none');
      expect(loadConfig({ ...base, OPENAI_API_KEY: 'sk-o', OPENAI_MODEL: 'gpt-6-sol' }).openaiReasoningEffort).toBeNull();
      expect(loadConfig({ ...base, OPENAI_API_KEY: 'sk-o', OPENAI_REASONING_EFFORT: ' Low ' }).openaiReasoningEffort).toBe('low');
      expect(() => loadConfig({ ...base, OPENAI_API_KEY: 'sk-o', OPENAI_REASONING_EFFORT: 'turbo' })).toThrow(/OPENAI_REASONING_EFFORT must be one of/);
    });

    it('reads the OpenAI key and model, defaulting to gpt-6-luna, and never echoes a key in errors', () => {
      const c = loadConfig({ ...base, OPENAI_API_KEY: 'sk-secret-openai' });
      expect(c.openaiApiKey).toBe('sk-secret-openai');
      expect(c.openaiModel).toBe('gpt-6-luna');
      expect(loadConfig({ ...base, OPENAI_API_KEY: 'sk-o', OPENAI_MODEL: 'gpt-6-sol' }).openaiModel).toBe('gpt-6-sol');
      try {
        loadConfig({ ...base, AGENT_BRAIN: 'nope', OPENAI_API_KEY: 'sk-secret-openai' });
      } catch (error) {
        expect(String(error)).not.toContain('sk-secret-openai');
      }
    });
  });
});

