import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tourSteps } from '@/lib/join/tour';
import { Tour } from './Tour';

const STEPS = tourSteps({ startTrack: 'Hat' });
const frame = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Tour', () => {
  it('renders nothing while closed', () => {
    render(<Tour steps={STEPS} open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('walks forward and back, and the last step starts playing', async () => {
    const onClose = vi.fn();
    render(<Tour steps={STEPS} open onClose={onClose} />);
    await frame();
    const dialog = screen.getByRole('dialog', { name: 'Pick your instrument' });
    expect(dialog.textContent).toMatch(/You start on Hat/);
    expect(dialog.textContent).toMatch(/1 of 6/);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Eight different sounds' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Pick your instrument' })).toBeTruthy();
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: /^(Next|Start playing)$/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no Back on the first step', async () => {
    render(<Tour steps={STEPS} open onClose={vi.fn()} />);
    await frame();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('Skip and Escape close it', async () => {
    const onClose = vi.fn();
    render(<Tour steps={STEPS} open onClose={onClose} />);
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('highlights the target of the step, measured from the page', async () => {
    const target = document.createElement('div');
    target.dataset.tour = 'tabs';
    target.getBoundingClientRect = () => ({ top: 120, bottom: 164, left: 12, right: 378, width: 366, height: 44, x: 12, y: 120, toJSON: () => ({}) });
    document.body.appendChild(target);
    render(<Tour steps={STEPS} open onClose={vi.fn()} />);
    await frame();
    const spot = screen.getByTestId('tour-spotlight');
    expect(spot.style.top).toBe('114px'); // 6 px of padding around the target
    expect(spot.style.height).toBe('56px');
  });

  it('moves focus to Next and keeps Tab inside the card', async () => {
    render(<Tour steps={STEPS} open onClose={vi.fn()} />);
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('gives focus back to what had it before the tour opened', async () => {
    const help = document.createElement('button');
    document.body.appendChild(help);
    help.focus();
    const { rerender } = render(<Tour steps={STEPS} open onClose={vi.fn()} />);
    await frame();
    rerender(<Tour steps={STEPS} open={false} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(help);
  });
});
