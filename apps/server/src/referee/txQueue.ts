import type { Receipt } from "./Referee";

/**
 * Sends one table's transactions one at a time, in order (window indexes must be sequential).
 * Retries network failures twice. A tx that still fails is reported (red on the ticker) and the
 * queue moves on: the game never dies because of the chain.
 */
export class TxQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly retries = 2) {}

  get size(): number {
    return this.pending;
  }

  enqueue(send: () => Promise<Receipt>): Promise<Receipt> {
    this.pending++;
    const run = async (): Promise<Receipt> => {
      let last: Receipt | undefined;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          last = await send();
        } catch (e) {
          last = { kind: "unknown", ms: 0, ok: false, mock: false, signer: "host", error: String((e as Error)?.message ?? e), retryable: true };
        }
        if (last.ok || !last.retryable) break;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
      return last!;
    };
    const p = this.tail.then(run, run).finally(() => this.pending--);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Resolves once everything queued so far has been sent. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
