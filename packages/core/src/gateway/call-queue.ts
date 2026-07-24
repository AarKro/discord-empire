/**
 * A minimal FIFO queue so bursty outbound work (e.g. thirty role grants from one
 * event, §9) is serialized per bot — discord.js does the actual rate-limit
 * bucketing, this just keeps us from firing a burst at it all at once.
 */
export class CallQueue {
  private chain: Promise<unknown> = Promise.resolve();
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run as Promise<T>;
  }
}
