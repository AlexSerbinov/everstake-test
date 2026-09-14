export class ElapsedTimer {
  private interval?: ReturnType<typeof setInterval>;
  private started = 0;
  start(node: HTMLElement) {
    this.stop();
    this.started = performance.now();
    const paint = () => {
      node.textContent = `${((performance.now() - this.started) / 1000).toFixed(1)}s`;
    };
    paint();
    this.interval = setInterval(paint, 100);
  }
  stop() {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }
}
