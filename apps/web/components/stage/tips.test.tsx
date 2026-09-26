import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hash } from 'viem';
import type { TipLine } from '@/lib/tips/tipList';
import { HostControls } from './HostControls';
import { StageQrs } from './StageQrs';
import { TipsPanel } from './TipsPanel';
import { JOIN_QR_STORAGE_KEY, useJoinQrVisible } from './useJoinQrVisible';

const FROM = '0x1111111111111111111111111111111111111111' as Address;
const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}` as Hash;

function line(n: number, overrides: Partial<TipLine> = {}): TipLine {
  return { txHash: hash(n), from: FROM, amountWei: 20_000_000_000_000_000n, name: null, message: null, at: null, ...overrides };
}

afterEach(cleanup);

describe('StageQrs (W21b: two codes, the join code hidden by default)', () => {
  it('blurs the join code and hides its URL until the host shows it; the tips code is always there', () => {
    const { rerender } = render(<StageQrs sessionId={4n} joinUrl="https://x.test/join/4" tipUrl="https://x.test/tip/4" joinVisible={false} size={176} />);
    const join = screen.getByTestId('qr-join');
    expect(join.getAttribute('data-visible')).toBe('false');
    expect(join.textContent).toMatch(/hidden by the host/i);
    expect(join.textContent).not.toContain('x.test/join/4');
    expect(screen.getByTestId('join-hidden').textContent).toBe('Hidden by the host');
    expect(screen.queryByRole('img', { name: /QR code to join/i })).toBeNull();
    expect(screen.getByTestId('tip-url').textContent).toBe('x.test/tip/4');
    expect(screen.getByRole('img', { name: /QR code to tip session 4/i })).toBeTruthy();
    rerender(<StageQrs sessionId={4n} joinUrl="https://x.test/join/4" tipUrl="https://x.test/tip/4" joinVisible size={176} />);
    expect(screen.getByTestId('qr-join').getAttribute('data-visible')).toBe('true');
    expect(screen.getByTestId('short-url').textContent).toBe('x.test/join/4');
    expect(screen.getByRole('img', { name: /QR code to join session 4/i })).toBeTruthy();
  });
});

describe('useJoinQrVisible (per tab, sessionStorage)', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('starts hidden, remembers a toggle for the tab and shares it between readers', () => {
    const a = renderHook(() => useJoinQrVisible());
    const b = renderHook(() => useJoinQrVisible());
    expect(a.result.current[0]).toBe(false);
    act(() => a.result.current[1](true));
    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
    expect(window.sessionStorage.getItem(JOIN_QR_STORAGE_KEY)).toBe('shown');
    act(() => a.result.current[1](false));
    expect(b.result.current[0]).toBe(false);
  });

  it('survives a storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useJoinQrVisible());
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe('TipsPanel (W21b: raised by this song and the latest tips)', () => {
  it('shows the raised total and an invitation while there are no tips', () => {
    render(<TipsPanel raisedWei={0n} lines={[]} flash={0} />);
    expect(screen.getByTestId('raised').textContent).toBe('0 MON');
    expect(screen.getByTestId('tip-list-empty').textContent).toMatch(/scan the tip code/i);
  });

  it('lists the newest tips with the name (or short address), amount and message, plain text', () => {
    render(<TipsPanel raisedWei={60_000_000_000_000_000n} lines={[line(3, { name: 'Ana', message: '<b>more kick</b>' }), line(2), line(1), line(0)]} flash={2} />);
    expect(screen.getByTestId('raised').textContent).toBe('0.06 MON');
    const items = screen.getAllByTestId('tip-item');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Ana');
    expect(items[0]?.textContent).toContain('0.02 MON');
    expect(items[0]?.textContent).toContain('<b>more kick</b>');
    expect(items[0]?.querySelector('b')).toBeNull();
    expect(items[1]?.textContent).toContain('0x1111…1111');
    // The newest line and the figure replay their animation once per tip.
    expect(items[0]?.className).toMatch(/tip-in/);
    expect(screen.getByTestId('raised-figure').className).toMatch(/raised-pop/);
  });
});

describe('HostControls W21b: join code toggle and host tips', () => {
  const base = {
    sessionId: 4n,
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
  };

  it('toggles the join code and says which way it goes', () => {
    const onToggleJoinQr = vi.fn();
    const { rerender } = render(<HostControls {...base} joinQrVisible={false} onToggleJoinQr={onToggleJoinQr} />);
    const button = screen.getByRole('button', { name: 'Show join code' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggleJoinQr).toHaveBeenCalledTimes(1);
    rerender(<HostControls {...base} joinQrVisible onToggleJoinQr={onToggleJoinQr} />);
    expect(screen.getByRole('button', { name: 'Hide join code' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('offers the host share with its amount and disables it when there is nothing to claim', () => {
    const onClaimHost = vi.fn();
    const { rerender } = render(<HostControls {...base} hostClaimableWei={4_000_000_000_000_000n} onClaimHost={onClaimHost} />);
    fireEvent.click(screen.getByRole('button', { name: 'Claim host tips (0.004 MON)' }));
    expect(onClaimHost).toHaveBeenCalledTimes(1);
    rerender(<HostControls {...base} hostClaimableWei={0n} onClaimHost={onClaimHost} />);
    expect(screen.getByRole('button', { name: 'Claim host tips (0 MON)' }).hasAttribute('disabled')).toBe(true);
    rerender(<HostControls {...base} />);
    expect(screen.queryByRole('button', { name: /claim host tips/i })).toBeNull();
  });
});
