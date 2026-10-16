/** Injected time source: services never call Date.now() directly, so simulations and tests control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class VirtualClock implements Clock {
  private t: number;
  constructor(start: Date) {
    this.t = start.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date): void {
    this.t = d.getTime();
  }
  advance(ms: number): Date {
    this.t += ms;
    return this.now();
  }
}
