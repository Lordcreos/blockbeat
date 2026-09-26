import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostControls } from './HostControls';
import { hostBarRequested } from './host-bar';

type Props = Parameters<typeof HostControls>[0];

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    sessionId: 12n,
    finalized: false,
    mintedTokenId: null,
    busy: false,
    status: null,
    hasSecret: true,
    onSecretCommit: vi.fn(),
    onNewSession: vi.fn(),
    onEndAndMint: vi.fn(),
    djRunning: false,
    djBusy: false,
    onToggleDj: vi.fn(),
    ...overrides,
  };
  render(<HostControls {...props} />);
  return props;
}

describe('HostControls: the host bar', () => {
  afterEach(cleanup);

  it('names the session and its state, with labelled actions', () => {
    setup();
    const bar = screen.getByRole('region', { name: /host controls/i });
    expect(bar.textContent).toContain('Session 12');
    expect(screen.getByTestId('host-session-state').textContent).toBe('Live');
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End session and mint' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start DJ' })).toBeTruthy();
  });

  it('asks before a new session strands the phones', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.getByText(/phones must re-scan/i)).toBeTruthy();
    expect(props.onNewSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /keep this session/i }));
    expect(screen.queryByText(/phones must re-scan/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.click(screen.getByRole('button', { name: /start new session/i }));
    expect(props.onNewSession).toHaveBeenCalledOnce();
  });

  it('ends and mints on one click', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'End session and mint' }));
    expect(props.onEndAndMint).toHaveBeenCalledOnce();
  });

  it('after minting offers the track and the gallery instead of mint', () => {
    setup({ finalized: true, mintedTokenId: 3n });
    expect(screen.getByTestId('host-session-state').textContent).toBe('Minted as Track #3');
    expect(screen.queryByRole('button', { name: 'End session and mint' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Play the track' }).getAttribute('href')).toBe('/track/3');
    expect(screen.getByRole('link', { name: 'Open the gallery' }).getAttribute('href')).toBe('/tracks');
  });

  it('a finalized session with an unknown token still links the gallery', () => {
    setup({ finalized: true, mintedTokenId: null });
    expect(screen.getByTestId('host-session-state').textContent).toBe('Minted');
    expect(screen.queryByRole('link', { name: 'Play the track' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the gallery' })).toBeTruthy();
  });

  it('without a secret it shows a labelled field committed on Enter or blur, never per key', () => {
    const props = setup({ hasSecret: false });
    const field = screen.getByLabelText('Host secret');
    fireEvent.change(field, { target: { value: ' s3cret ' } });
    expect(props.onSecretCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(props.onSecretCommit).toHaveBeenCalledWith('s3cret');
    fireEvent.blur(field);
    expect(props.onSecretCommit).toHaveBeenCalledTimes(2);
  });

  it('shows the status in a live region', () => {
    setup({ status: 'Minted track #3' });
    expect(screen.getByRole('status').textContent).toBe('Minted track #3');
  });
});

describe('HostControls DJ button (W12, moved from DjPanel.test.tsx)', () => {
  afterEach(cleanup);

  it('puts Start DJ next to New session and calls the toggle', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Start DJ' }));
    expect(props.onToggleDj).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
  });

  it('turns into Stop DJ while the agent runs and locks while busy or finalized', () => {
    setup({ djRunning: true });
    expect(screen.getByRole('button', { name: 'Stop DJ' }).getAttribute('aria-pressed')).toBe('true');
    cleanup();
    setup({ djRunning: true, djBusy: true });
    expect(screen.getByRole('button', { name: 'Stop DJ' }).hasAttribute('disabled')).toBe(true);
    cleanup();
    setup({ finalized: true });
    expect(screen.getByRole('button', { name: 'Start DJ' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('hostBarRequested (?host=1, read by the server page)', () => {
  it('is true only for host=1', () => {
    expect(hostBarRequested('1')).toBe(true);
    expect(hostBarRequested(['0', '1'])).toBe(true);
    expect(hostBarRequested('0')).toBe(false);
    expect(hostBarRequested('')).toBe(false);
    expect(hostBarRequested(undefined)).toBe(false);
  });
});

describe('HostControls: simulated players (W19)', () => {
  afterEach(cleanup);
  const crowd = (over: Partial<NonNullable<Props['crowd']>> = {}): NonNullable<Props['crowd']> => ({ running: false, stopping: false, busy: false, visibleAvailable: false, onAdd: vi.fn(), onStop: vi.fn(), ...over });

  it('has no crowd buttons unless the stage passes the crowd controls', () => {
    setup();
    expect(screen.queryByRole('button', { name: /players|crowd/i })).toBeNull();
  });

  it('"Add 10 players" starts a headless crowd; "Add 5 visible" only on the laptop itself', () => {
    const c = crowd();
    setup({ crowd: c });
    fireEvent.click(screen.getByRole('button', { name: 'Add 10 players' }));
    expect(c.onAdd).toHaveBeenCalledWith('headless');
    expect(screen.queryByRole('button', { name: 'Add 5 visible' })).toBeNull();
    cleanup();
    const local = crowd({ visibleAvailable: true });
    setup({ crowd: local });
    fireEvent.click(screen.getByRole('button', { name: 'Add 5 visible' }));
    expect(local.onAdd).toHaveBeenCalledWith('visible');
  });

  it('while the crowd plays: "Stop crowd"; while it sweeps: disabled; after minting: no new crowd', () => {
    const c = crowd({ running: true });
    setup({ crowd: c });
    fireEvent.click(screen.getByRole('button', { name: 'Stop crowd' }));
    expect(c.onStop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add 10 players' })).toBeNull();
    cleanup();
    setup({ crowd: crowd({ running: true, stopping: true }) });
    expect((screen.getByRole('button', { name: 'Sweeping…' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup({ finalized: true, crowd: crowd({ visibleAvailable: true }) });
    expect((screen.getByRole('button', { name: 'Add 10 players' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add 5 visible' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
