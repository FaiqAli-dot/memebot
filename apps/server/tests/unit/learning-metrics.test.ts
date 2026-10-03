import { describe, expect, it } from 'vitest';
import {
  classifyInteraction,
  computeLearningMetrics,
} from '../../src/learning/metrics.js';

describe('learning metrics', () => {
  it('optimizes for expectancy and flags small samples', () => {
    const m = computeLearningMetrics(
      [
        { netPnlUsd: 1, grossPnlUsd: 1.5, costsUsd: 0.5, win: true, holdSec: 60 },
        { netPnlUsd: -0.8, grossPnlUsd: -0.3, costsUsd: 0.5, win: false, holdSec: 30 },
        { netPnlUsd: 0.5, grossPnlUsd: 1, costsUsd: 0.5, win: true, holdSec: 90 },
      ],
      30,
    );
    expect(m.sampleAdequate).toBe(false);
    expect(m.expectancyUsd).toBeCloseTo(0.7 / 3);
    expect(m.notes.some((n) => n.includes('sample_size'))).toBe(true);
  });

  it('classifies healthy vs suspicious volume interactions', () => {
    expect(
      classifyInteraction({
        highVolume: true,
        risingUniqueBuyers: true,
        risingLiquidity: true,
        lowConcentration: true,
        positiveMomentum: true,
      }).label,
    ).toBe('healthy_expansion');
    expect(
      classifyInteraction({
        highVolume: true,
        risingUniqueBuyers: false,
        risingLiquidity: false,
        lowConcentration: false,
        positiveMomentum: true,
      }).label,
    ).toBe('suspicious_volume');
  });
});
