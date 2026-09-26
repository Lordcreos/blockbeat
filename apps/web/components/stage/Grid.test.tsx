import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { STEPS, TRACKS } from '@blockbeat/shared';
import { Grid } from './Grid';

function grid(value: number): number[][] {
  return Array.from({ length: STEPS }, () => new Array<number>(TRACKS).fill(value));
}

describe('Grid fades (W13)', () => {
  afterEach(cleanup);

  it('marks a fading live note and dims it, keeps a fresh one at full light, and draws an evicted ghost', () => {
    const cells = grid(0);
    const fades = grid(0);
    const ghosts = grid(0);
    (cells[2] as number[])[1] = 1;
    (fades[2] as number[])[1] = 0.5;
    (cells[3] as number[])[1] = 1;
    (fades[3] as number[])[1] = 1;
    (ghosts[4] as number[])[1] = 0.25;
    const { container } = render(<Grid cells={cells} currentStep={0} flash={null} agentCells={new Set()} fades={fades} ghosts={ghosts} />);
    const fading = container.querySelector<HTMLElement>('[data-cell="2:1"]');
    expect(fading?.dataset.on).toBe('true');
    expect(fading?.dataset.fade).toBe('0.50');
    expect(Number(fading?.style.opacity)).toBeCloseTo(0.9 * (0.15 + 0.85 * 0.5));
    expect(fading?.getAttribute('aria-label')).toMatch(/fading/);
    const fresh = container.querySelector<HTMLElement>('[data-cell="3:1"]');
    expect(fresh?.dataset.fade).toBeUndefined();
    expect(Number(fresh?.style.opacity)).toBeCloseTo(0.9);
    const ghost = container.querySelector<HTMLElement>('[data-cell="4:1"]');
    expect(ghost?.dataset.on).toBeUndefined();
    expect(ghost?.dataset.ghost).toBe('true');
  });

  it('without fades every lit cell is at full light (decay off)', () => {
    const cells = grid(0);
    (cells[5] as number[])[0] = 2;
    const { container } = render(<Grid cells={cells} currentStep={0} flash={null} agentCells={new Set()} />);
    const lit = container.querySelector<HTMLElement>('[data-cell="5:0"]');
    expect(lit?.dataset.fade).toBeUndefined();
    expect(Number(lit?.style.opacity)).toBeCloseTo(1);
  });
});
