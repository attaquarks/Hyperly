/** Session-scoped recovery limits for reference loss and worker inference faults. */
export class AecRecoveryPolicy {
  private overflowCount = 0;
  private consecutiveFailures = 0;
  private resetSent = false;

  /** Tolerate short FIFO backpressure bursts; bypass after sustained overflow. */
  noteOverflows(count: number): "gap" | "bypass" {
    if (!Number.isSafeInteger(count) || count <= 0) return "gap";
    this.overflowCount += count;
    return this.overflowCount <= 4 ? "gap" : "bypass";
  }

  /** Three consecutive failures are tolerated; the fourth resets once. */
  noteWorkerFailure(): "continue" | "reset" | "bypass" {
    if (this.resetSent) return "bypass";
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures <= 3) return "continue";
    this.resetSent = true;
    this.consecutiveFailures = 0;
    return "reset";
  }

  noteWorkerSuccess(): void {
    if (this.overflowCount > 0) this.overflowCount -= 1;
    if (!this.resetSent) this.consecutiveFailures = 0;
  }
}
