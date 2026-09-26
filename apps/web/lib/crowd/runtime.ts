/**
 * Process-wide crowd manager for the /api/crowd routes (W19). Kept on globalThis so a dev hot
 * reload never orphans a running crowd; its process group gets SIGTERM when the web server
 * exits (the crowd sweeps on SIGTERM). Server only.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { agentRepoRoot } from '../agent/runtime';
import { createCrowdManager, type CrowdManager } from './manager';

const GLOBAL_KEY = '__blockbeatCrowdManager';

type WithManager = typeof globalThis & { [GLOBAL_KEY]?: CrowdManager };

export function getCrowdManager(): CrowdManager {
  const g = globalThis as WithManager;
  const existing = g[GLOBAL_KEY];
  if (existing) return existing;
  const scriptsRoot = path.join(agentRepoRoot(), 'scripts');
  const manager = createCrowdManager({
    spawn: (command, args, options) => spawn(command, args, { ...options, env: { ...options.env, NODE_ENV: process.env.NODE_ENV ?? 'development' } }),
    // Negative pid: the whole group (node and, in visible mode, its browsers), started with detached: true.
    kill: (pid, signal) => process.kill(-pid, signal),
    scriptsRoot,
    nodePath: process.execPath,
    available: () => existsSync(path.join(scriptsRoot, 'src', 'crowd.ts')),
    baseEnv: process.env,
    log: (m) => console.warn(m),
  });
  process.once('exit', () => {
    const pid = manager.status().pid;
    if (pid === null) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      console.warn(`crowd: could not stop pid ${pid} on exit (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  g[GLOBAL_KEY] = manager;
  return manager;
}
