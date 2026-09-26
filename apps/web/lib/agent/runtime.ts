/**
 * Process-wide agent manager for the /api/agent routes (W12). Kept on globalThis so a dev
 * hot reload never orphans a running DJ, and the child's process group is signalled when the
 * web server exits. Server only.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createAgentManager, type AgentManager } from './manager';

const GLOBAL_KEY = '__blockbeatAgentManager';

type WithManager = typeof globalThis & { [GLOBAL_KEY]?: AgentManager };

/** apps/web runs from its own directory (`next dev`); the repo root is two levels up unless BLOCKBEAT_REPO_ROOT says otherwise. */
export function agentRepoRoot(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const override = env.BLOCKBEAT_REPO_ROOT?.trim();
  return override ? path.resolve(override) : path.resolve(cwd, '..', '..');
}

export function getAgentManager(): AgentManager {
  const g = globalThis as WithManager;
  const existing = g[GLOBAL_KEY];
  if (existing) return existing;
  const repoRoot = agentRepoRoot();
  const manager = createAgentManager({
    spawn: (command, args, options) => spawn(command, args, { ...options, env: { ...options.env, NODE_ENV: process.env.NODE_ENV ?? 'development' } }),
    // Negative pid: the whole group (pnpm → tsx → node), started with detached: true.
    kill: (pid, signal) => process.kill(-pid, signal),
    repoRoot,
    agentAvailable: () => existsSync(path.join(repoRoot, 'apps', 'agent', 'package.json')),
    baseEnv: process.env,
    log: (m) => console.warn(m),
  });
  process.once('exit', () => {
    const pid = manager.status().pid;
    if (pid === null) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      console.warn(`agent: could not stop pid ${pid} on exit (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  g[GLOBAL_KEY] = manager;
  return manager;
}
