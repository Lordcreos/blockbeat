import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrowdStatus } from '@/lib/crowd/client';
import { CrowdPanel } from './CrowdPanel';

const off: CrowdStatus = { running: false, stopping: false, sessionId: null, mode: null, players: null, minutes: null, pid: null, startedAt: null, lines: [], bar: null, bars: null, playersActive: null, playersTotal: null, notesSent: null, notesConfirmed: null, onStepPct: null, monSpent: null, lastExit: null };
const on: CrowdStatus = { ...off, running: true, sessionId: '3', mode: 'headless', players: 10, minutes: 3, pid: 9, startedAt: 1, bar: 7, bars: 38, playersActive: 8, playersTotal: 10, notesSent: 34, notesConfirmed: 31, onStepPct: 87, monSpent: 0.412, lines: ['crowd | bar 7/38 | players 8/10 | sent 34 | confirmed 31 | on-step 87% | spent 0.4120 MON'] };

describe('CrowdPanel (W19)', () => {
  afterEach(cleanup);

  it('says plainly that the players are simulated, and shows players, notes and MON spent', () => {
    render(<CrowdPanel status={on} error={null} />);
    const panel = screen.getByRole('region', { name: 'Simulated players' });
    expect(panel.textContent).toContain('Simulated players');
    expect(screen.getByTestId('crowd-state').textContent).toBe('On · session 3 · bar 7/38');
    expect(screen.getByTestId('crowd-stats').textContent).toBe('8/10 active · 34 notes (31 landed) · 87% on step · 0.412 MON');
  });

  it('shows the sweep while stopping, and the last run when off', () => {
    const { rerender } = render(<CrowdPanel status={{ ...on, stopping: true }} error={null} />);
    expect(screen.getByTestId('crowd-state').textContent).toBe('Stopping · sweeping MON back');
    rerender(<CrowdPanel status={{ ...off, lastExit: 'stopped: host pressed Stop crowd (exited with code 0)', notesSent: 90, notesConfirmed: 88, monSpent: 1.02, playersTotal: 10 }} error={null} />);
    expect(screen.getByTestId('crowd-state').textContent).toBe('Off');
    expect(screen.getByText(/Last run: stopped: host pressed Stop crowd/)).toBeTruthy();
  });

  it('marks visible mode and shows an error as an alert', () => {
    render(<CrowdPanel status={{ ...on, mode: 'visible', players: 5 }} error="Crowd: a crowd is already playing session 3" />);
    expect(screen.getByTestId('crowd-state').textContent).toBe('On · session 3 · bar 7/38 · visible phones');
    expect(screen.getByRole('alert').textContent).toContain('already playing');
  });

  it('renders nothing before the first status (idle, never run)', () => {
    const { container } = render(<CrowdPanel status={off} error={null} />);
    expect(container.textContent).toBe('');
  });
});
