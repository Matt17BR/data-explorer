type Listener<T> = (event: T) => unknown;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const window = {
  showWarningMessage: async (): Promise<undefined> => undefined
};
