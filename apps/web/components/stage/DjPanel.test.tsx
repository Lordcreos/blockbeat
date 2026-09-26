import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStatus } from '@/lib/host/client';
import { DjPanel } from './DjPanel';

const off: AgentStatus = { running: false, sessionId: null, pid: null, startedAt: null, lines: [], hitsSent: null, budgetLeft: null, brain: null, lastExit: null };
const on: AgentStatus = {
  ...off,
  running: true,
  sessionId: '3',
  pid: 7,
  startedAt: 1,
  lines: ['agent 0xabc on chain 10143', 'bar 214 | block 65518906 | sent 3 | match 1/2 (50%) | budget 37 | brain openai | next: t2@13n0', 'WARN brain: openai failed (timeout); using rules for this bar'],
  hitsSent: 3,
  budgetLeft: 37,
  brain: 'openai',
};

describe('DjPanel (W12)', () => {
  afterEach(cleanup);

  it('shows on, hits sent, budget left, brain and the last three lines', () => {
    render(<DjPanel status={on} error={null} />);
    expect(screen.getByTestId('dj-state').textContent).toBe('On · session 3');
    expect(screen.getByTestId('dj-stats').textContent).toBe('3 hits sent · 37 left · brain openai');
    expect(screen.getByTestId('dj-lines').querySelectorAll('li')).toHaveLength(3);
  });

  it('W14: shows the Gemini brain with its model, and the fallback reason on a rules bar', () => {
    const { rerender } = render(<DjPanel status={{ ...on, brain: 'gemini gemini-3.8-flash' }} error={null} />);
    expect(screen.getByTestId('dj-stats').textContent).toBe('3 hits sent · 37 left · brain gemini gemini-3.8-flash');
    expect(screen.getByTestId('dj-stats').getAttribute('title')).toBe('3 hits sent · 37 left · brain gemini gemini-3.8-flash');
    expect(screen.getByTestId('dj-panel').getAttribute('data-brain-fallback')).toBe('false');
    rerender(<DjPanel status={{ ...on, brain: 'rules (gemini timeout)' }} error={null} />);
    expect(screen.getByTestId('dj-stats').textContent).toBe('3 hits sent · 37 left · brain rules (gemini timeout)');
    expect(screen.getByTestId('dj-panel').getAttribute('data-brain-fallback')).toBe('true');
    rerender(<DjPanel status={{ ...on, brain: 'rules (gemini unavailable: model not found)' }} error={null} />);
    expect(screen.getByTestId('dj-stats').textContent).toContain('brain rules (gemini unavailable: model not found)');
    expect(screen.getByTestId('dj-panel').getAttribute('data-brain-fallback')).toBe('true');
  });

  it('shows off with why the last run ended', () => {
    render(<DjPanel status={{ ...off, lastExit: 'stopped: session finalized (exited with code 0)' }} error={null} />);
    expect(screen.getByTestId('dj-state').textContent).toBe('Off');
    expect(screen.getByTestId('dj-panel').textContent).toMatch(/session finalized/);
  });

  it('shows an error line', () => {
    render(<DjPanel status={off} error="the DJ agent plays on a real chain" />);
    expect(screen.getByRole('alert').textContent).toMatch(/real chain/);
  });
});
