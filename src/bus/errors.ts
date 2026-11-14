// SPDX-License-Identifier: AGPL-3.0-only

/** Rejected because the scheduler is in read-only (receive-only) mode. */
export class ReadOnlyError extends Error {
  constructor() {
    super('TxScheduler is read-only');
    this.name = 'ReadOnlyError';
  }
}

/** Rejected because the waiting queue already holds `limit` requests. */
export class QueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`TxScheduler queue is full (${limit} waiting)`);
    this.name = 'QueueFullError';
  }
}

/** No ack after `attempts` writes. `cause` holds the last write error, if any. */
export class TxTimeoutError extends Error {
  constructor(readonly attempts: number, cause?: unknown) {
    super(`No ack after ${attempts} attempt(s)`, cause === undefined ? undefined : { cause });
    this.name = 'TxTimeoutError';
  }
}

/** Replaced by a newer waiting request with the same `coalesceKey`. */
export class SupersededError extends Error {
  constructor(readonly coalesceKey: string) {
    super(`Superseded by a newer request with key ${JSON.stringify(coalesceKey)}`);
    this.name = 'SupersededError';
  }
}

/** Rejected by `TxScheduler.abortAll`; `cause` is the abort reason. */
export class TxAbortedError extends Error {
  constructor(cause: unknown) {
    super('Transmission aborted', { cause });
    this.name = 'TxAbortedError';
  }
}
