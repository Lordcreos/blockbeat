import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareButton } from './ShareButton';

describe('ShareButton', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('copies the page URL and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<ShareButton url="https://blockbeat.example/track/3" title="Blockbeat Track #3" />);
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://blockbeat.example/track/3'));
    expect(await screen.findByText(/link copied/i)).toBeTruthy();
  });

  it('prefers the native share sheet when the browser has one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share, clipboard: { writeText: vi.fn() } });
    render(<ShareButton url="https://blockbeat.example/track/3" title="Blockbeat Track #3" />);
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'Blockbeat Track #3', url: 'https://blockbeat.example/track/3' }));
  });

  it('says so when copying is not possible', async () => {
    vi.stubGlobal('navigator', {});
    render(<ShareButton url="https://blockbeat.example/track/3" title="Blockbeat Track #3" />);
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    expect(await screen.findByText(/copy the address bar/i)).toBeTruthy();
  });
});
