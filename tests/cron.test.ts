import { describe, expect, it } from 'vitest';
import { cronToForm, formToCron, timesExpressible, type CronForm } from '../src/shared/cron';

describe('formToCron', () => {
  it('builds each mode', () => {
    expect(formToCron({ mode: 'minutes', step: 10 })).toBe('*/10 * * * *');
    expect(formToCron({ mode: 'minutes', step: 15, from: 9, to: 18, days: [1, 2, 3, 4, 5] })).toBe('*/15 9-18 * * 1-5');
    expect(formToCron({ mode: 'hours', step: 1, minute: 0 })).toBe('0 * * * *');
    expect(formToCron({ mode: 'hours', step: 1, minute: 15 })).toBe('15 * * * *');
    expect(formToCron({ mode: 'hours', step: 6, minute: 0 })).toBe('0 */6 * * *');
    expect(formToCron({ mode: 'hours', step: 2, minute: 30, from: 9, to: 17, days: [1, 3, 5] })).toBe('30 9-17/2 * * 1,3,5');
    expect(formToCron({ mode: 'daily', times: [{ hour: 9, minute: 30 }] })).toBe('30 9 * * *');
    expect(formToCron({ mode: 'daily', times: [{ hour: 17, minute: 0 }, { hour: 9, minute: 0 }] })).toBe('0 9,17 * * *');
    expect(formToCron({ mode: 'daily', times: [{ hour: 9, minute: 30 }, { hour: 9, minute: 0 }] })).toBe('0,30 9 * * *');
    expect(formToCron({ mode: 'weekly', days: [5, 1], hour: 8, minute: 0 })).toBe('0 8 * * 1,5');
    expect(formToCron({ mode: 'weekly', days: [1, 2, 3, 4, 5], hour: 8, minute: 0 })).toBe('0 8 * * 1-5');
    expect(formToCron({ mode: 'monthly', days: [15], hour: 0, minute: 0 })).toBe('0 0 15 * *');
    expect(formToCron({ mode: 'monthly', days: [1, 15], hour: 0, minute: 0 })).toBe('0 0 1,15 * *');
    expect(formToCron({ mode: 'custom', cron: '1 2 3 4 5' })).toBe('1 2 3 4 5');
  });
});

describe('cronToForm', () => {
  it('round-trips every friendly form', () => {
    const forms: CronForm[] = [
      { mode: 'minutes', step: 5 },
      { mode: 'minutes', step: 15, from: 9, to: 18, days: [1, 2, 3, 4, 5] },
      { mode: 'minutes', step: 10, days: [0, 6] },
      { mode: 'hours', step: 1, minute: 0 },
      { mode: 'hours', step: 1, minute: 15 },
      { mode: 'hours', step: 12, minute: 0 },
      { mode: 'hours', step: 2, minute: 30, from: 9, to: 17, days: [1, 3, 5] },
      { mode: 'hours', step: 1, minute: 0, from: 8, to: 20 },
      { mode: 'daily', times: [{ hour: 23, minute: 59 }] },
      { mode: 'daily', times: [{ hour: 9, minute: 0 }, { hour: 17, minute: 0 }] },
      { mode: 'daily', times: [{ hour: 9, minute: 0 }, { hour: 9, minute: 30 }] },
      { mode: 'weekly', days: [0, 3], hour: 7, minute: 15 },
      { mode: 'weekly', days: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
      { mode: 'monthly', days: [1], hour: 6, minute: 0 },
      { mode: 'monthly', days: [1, 15], hour: 6, minute: 0 },
    ];
    for (const f of forms) expect(cronToForm(formToCron(f))).toEqual(f);
  });

  it('normalizes weekday 7 to 0, dedupes, and folds all-days to undefined', () => {
    expect(cronToForm('0 8 * * 7,1,1')).toEqual({ mode: 'weekly', days: [0, 1], hour: 8, minute: 0 });
    expect(cronToForm('*/10 * * * 0-6')).toEqual({ mode: 'minutes', step: 10 });
    expect(cronToForm('0 8 * * 0-6')).toEqual({ mode: 'daily', times: [{ hour: 8, minute: 0 }] });
  });

  it('keeps inexpressible patterns as custom', () => {
    for (const c of [
      '0,30 9,17 * * *', // minute list x hour list cross-product
      '0 9,17 * * 1-5', // several hours with a weekday constraint
      '0 9 1 * 1', // dom+dow combined
      '0 9 * 6 *', // specific month
      '5-59/10 * * * *', // offset minute step
      '*/30 * * * * *', // six fields (seconds)
      'not a cron',
    ]) {
      expect(cronToForm(c)).toEqual({ mode: 'custom', cron: c });
    }
  });
});

describe('timesExpressible', () => {
  it('requires a shared hour or a shared minute', () => {
    expect(timesExpressible([{ hour: 9, minute: 0 }])).toBe(true);
    expect(timesExpressible([{ hour: 9, minute: 0 }, { hour: 17, minute: 0 }])).toBe(true);
    expect(timesExpressible([{ hour: 9, minute: 0 }, { hour: 9, minute: 30 }])).toBe(true);
    expect(timesExpressible([{ hour: 9, minute: 0 }, { hour: 17, minute: 30 }])).toBe(false);
  });
});
