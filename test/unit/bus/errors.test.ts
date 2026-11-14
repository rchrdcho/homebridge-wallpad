// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  QueueFullError, ReadOnlyError, SupersededError, TxAbortedError, TxTimeoutError,
} from '../../../src/bus/errors.js';

describe('bus errors', () => {
  const cases: [string, Error][] = [
    ['ReadOnlyError', new ReadOnlyError()],
    ['QueueFullError', new QueueFullError(32)],
    ['TxTimeoutError', new TxTimeoutError(3)],
    ['SupersededError', new SupersededError('k')],
    ['TxAbortedError', new TxAbortedError(new Error('socket closed'))],
  ];
  for (const [name, err] of cases) {
    it(`${name} extends Error and sets name`, () => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, name);
      assert.ok(err.message.length > 0);
    });
  }

  it('TxTimeoutError carries attempts and an optional cause', () => {
    const cause = new Error('EPIPE');
    const err = new TxTimeoutError(2, cause);
    assert.equal(err.attempts, 2);
    assert.equal(err.cause, cause);
    assert.equal(new TxTimeoutError(3).cause, undefined);
  });

  it('TxAbortedError carries its cause', () => {
    const cause = new Error('disconnected');
    assert.equal(new TxAbortedError(cause).cause, cause);
  });

  it('SupersededError carries the coalesce key', () => {
    assert.equal(new SupersededError('light-1').coalesceKey, 'light-1');
  });
});
