// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { systemClock } from '../../../src/util/clock.js';

describe('systemClock', () => {
  it('now() follows Date.now()', () => {
    const before = Date.now();
    const t = systemClock.now();
    const after = Date.now();
    assert.ok(t >= before && t <= after);
  });

  it('setTimeout() runs the callback', { timeout: 1000 }, async () => {
    await new Promise<void>((resolve) => {
      systemClock.setTimeout(resolve, 1);
    });
  });

  it('clearTimeout() cancels the callback', async () => {
    let fired = false;
    const handle = systemClock.setTimeout(() => {
      fired = true;
    }, 1);
    systemClock.clearTimeout(handle);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
    assert.equal(fired, false);
  });
});
