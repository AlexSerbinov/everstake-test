/** Local generation IDs prevent a cancelled request from repainting a newer answer. */
export class RunState {
  private generation = 0;
  private controller?: AbortController;
  start() {
    this.controller?.abort();
    const generation = ++this.generation;
    this.controller = new AbortController();
    return {
      signal: this.controller.signal,
      scope: `answer-${generation}`,
      current: () => generation === this.generation,
    };
  }
  cancel() {
    this.controller?.abort();
    this.generation++;
  }
}
