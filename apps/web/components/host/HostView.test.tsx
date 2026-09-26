import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startSessionRequest = vi.fn();
const saveHostSecret = vi.fn();
vi.mock('@/lib/host/client', () => ({
  startSessionRequest: (secret: string | null) => startSessionRequest(secret),
  saveHostSecret: (secret: string) => saveHostSecret(secret),
  loadHostSecret: () => null,
}));
vi.mock('@/lib/chain/clients', () => ({ isMockMode: () => false }));
vi.mock('@/components/QrCode', () => ({ QrCode: ({ label }: { label: string }) => <canvas aria-label={label} /> }));

const { HostView } = await import('./HostView');

describe('HostView (W15)', () => {
  beforeEach(() => {
    startSessionRequest.mockReset();
    saveHostSecret.mockReset();
  });
  afterEach(cleanup);

  it('makes Create session the primary action', () => {
    render(<HostView recent={[]} recentError={null} />);
    const create = screen.getByRole('button', { name: 'Create session' });
    expect(create.getAttribute('data-primary')).toBe('true');
  });

  it('commits the host secret on blur or Enter, not per keystroke', () => {
    render(<HostView recent={[]} recentError={null} />);
    const field = screen.getByLabelText(/host secret/i);
    fireEvent.change(field, { target: { value: 'abc' } });
    expect(saveHostSecret).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(saveHostSecret).toHaveBeenCalledWith('abc');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(saveHostSecret).toHaveBeenCalledTimes(2);
  });

  it('lists recent sessions with their state and a token link when minted', () => {
    render(
      <HostView
        recent={[
          { sessionId: '4', finalized: false, tokenId: '0', hits: '0' },
          { sessionId: '2', finalized: true, tokenId: '1', hits: '31' },
        ]}
        recentError={null}
      />,
    );
    const rows = screen.getAllByTestId('recent-session');
    expect(within(rows[0] as HTMLElement).getByText('Live')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: /stage/i }).getAttribute('href')).toBe('/stage/4?host=1');
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'Track #1' }).getAttribute('href')).toBe('/track/1');
    expect(screen.getByRole('link', { name: /open the gallery/i }).getAttribute('href')).toBe('/tracks');
  });

  it('says when there is no session yet, and when the list could not be read', () => {
    const { unmount } = render(<HostView recent={[]} recentError={null} />);
    expect(screen.getByText(/no sessions yet/i)).toBeTruthy();
    unmount();
    render(<HostView recent={null} recentError="rpc busy" />);
    expect(screen.getByRole('alert').textContent).toMatch(/rpc busy/);
  });

  it('after Create session shows the stage link (host bar on), join link, QR codes and adds it to the list', async () => {
    startSessionRequest.mockResolvedValue({ sessionId: 7n, txHash: null });
    render(<HostView recent={[]} recentError={null} />);
    fireEvent.change(screen.getByLabelText(/host secret/i), { target: { value: ' s3cret ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    });
    expect(startSessionRequest).toHaveBeenCalledWith('s3cret');
    expect(screen.getByRole('link', { name: /open stage/i }).getAttribute('href')).toBe('/stage/7?host=1');
    expect(screen.getByRole('link', { name: /open join page/i }).getAttribute('href')).toBe('/join/7');
    expect(screen.getByTestId('qr-stage')).toBeTruthy();
    expect(screen.getByTestId('qr-join')).toBeTruthy();
    expect(screen.getAllByTestId('recent-session')[0]?.textContent).toContain('Session 7');
  });

  it('explains a failed create', async () => {
    startSessionRequest.mockRejectedValue(new Error('wrong host secret'));
    render(<HostView recent={[]} recentError={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/wrong host secret/);
  });
});
