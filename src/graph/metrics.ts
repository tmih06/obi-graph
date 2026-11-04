export interface GraphMetrics {
  readonly activity: "idle" | "layout" | "dragging" | "interacting";
  /** Distinct rendered animation frames per second; zero at idle. */
  readonly fps: number | null;
  /** Average renderer CPU milliseconds per rendered animation frame. */
  readonly renderMs: number;
  /** Average CPU milliseconds per simulation tick. */
  readonly simulationMs: number;
  readonly nodeCount: number;
  readonly linkCount: number;
  /** Canvas backing-buffer dimensions in physical pixels. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly pixelRatio: number;
}

type MetricsSnapshot = Omit<GraphMetrics, "fps" | "renderMs" | "simulationMs">;

/** Batches real work; one pending flush, no polling or animation loop. */
export class GraphMetricsReporter {
  private readonly onMetrics: (metrics: GraphMetrics) => void;
  private readonly snapshot: () => MetricsSnapshot;
  private timer: number | null = null;
  private frames = 0;
  private firstFrame = 0;
  private lastFrame = -1;
  private renderTotal = 0;
  private ticks = 0;
  private simulationTotal = 0;

  constructor(onMetrics: (metrics: GraphMetrics) => void, snapshot: () => MetricsSnapshot) {
    this.onMetrics = onMetrics;
    this.snapshot = snapshot;
  }

  recordRender(frameTime: number, duration: number) {
    // Layout, camera and highlight loops may paint during the same browser frame.
    if (frameTime !== this.lastFrame) {
      if (!this.frames) this.firstFrame = frameTime;
      this.lastFrame = frameTime;
      this.frames += 1;
    }
    this.renderTotal += duration;
    this.schedule();
  }

  recordSimulation(duration: number) {
    this.ticks += 1;
    this.simulationTotal += duration;
    this.schedule();
  }

  dispose() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const snapshot = this.snapshot();
      const metrics: GraphMetrics = {
        ...snapshot,
        fps:
          snapshot.activity === "idle"
            ? 0
            : this.frames > 1
              ? ((this.frames - 1) * 1000) / (this.lastFrame - this.firstFrame)
              : null,
        renderMs: this.frames ? this.renderTotal / this.frames : 0,
        simulationMs: this.ticks ? this.simulationTotal / this.ticks : 0,
      };
      this.frames = 0;
      this.lastFrame = -1;
      this.renderTotal = 0;
      this.ticks = 0;
      this.simulationTotal = 0;
      this.onMetrics(metrics);
    }, 250);
  }
}
