import { useSyncExternalStore } from "react";
import type { GraphMetrics, Theme } from "../graph/index.ts";
import "./graph-playground.css";

export interface PlaygroundSettings {
  charge: number;
  linkStrength: number;
  linkDistance: number;
  nodeScale: number;
  showLabels: boolean;
  showControls: boolean;
}

interface GraphPlaygroundProps {
  settings: PlaygroundSettings;
  onChange: (settings: PlaygroundSettings) => void;
  theme: Theme;
  onToggleTheme: () => void;
  open: boolean;
  metrics: MetricsStore;
  onOpenChange: (open: boolean) => void;
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}

function SliderField({ label, value, min, max, step, onChange, format }: SliderFieldProps) {
  return (
    <label className="playground__control">
      <span className="playground__control-row">
        <span>{label}</span>
        <span className="playground__control-value">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        className="playground__slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export interface MetricsStore {
  getSnapshot: () => GraphMetrics | null;
  subscribe: (listener: () => void) => () => void;
  update: (metrics: GraphMetrics | null) => void;
}

/** Sampling updates only its subscribed readout, never the graph or its controls. */
export function createMetricsStore(): MetricsStore {
  let metrics: GraphMetrics | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => metrics,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: GraphMetrics | null) => {
      metrics = next;
      for (const listener of listeners) listener();
    },
  };
}

/** Floating controls do not resize or re-frame the graph when opened. */
export function GraphPlayground({
  settings,
  onChange,
  theme,
  onToggleTheme,
  open,
  metrics,
  onOpenChange,
}: GraphPlaygroundProps) {
  function change<K extends keyof PlaygroundSettings>(key: K, value: PlaygroundSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <details
      className="playground"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
    >
      <summary className="playground__toggle">
        Playground
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4 10 4-4 4 4" />
        </svg>
      </summary>
      <div className="playground__panel" role="group" aria-label="Graph settings">
        <div className="playground__controls">
          <SliderField
            label="Charge"
            value={settings.charge}
            min={-800}
            max={-40}
            step={10}
            onChange={(value) => change("charge", value)}
            format={(value) => String(Math.round(value))}
          />
          <SliderField
            label="Link strength"
            value={settings.linkStrength}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(value) => change("linkStrength", value)}
          />
          <SliderField
            label="Link distance"
            value={settings.linkDistance}
            min={40}
            max={220}
            step={5}
            onChange={(value) => change("linkDistance", value)}
            format={(value) => String(Math.round(value))}
          />
          <SliderField
            label="Node size"
            value={settings.nodeScale}
            min={0.4}
            max={2}
            step={0.05}
            onChange={(value) => change("nodeScale", value)}
            format={(value) => `${value.toFixed(2)}×`}
          />
        </div>
        <div className="playground__toggles">
          <button
            type="button"
            aria-pressed={settings.showLabels}
            onClick={() => change("showLabels", !settings.showLabels)}
          >
            Labels {settings.showLabels ? "on" : "off"}
          </button>
          <button
            type="button"
            aria-pressed={settings.showControls}
            onClick={() => change("showControls", !settings.showControls)}
          >
            Toolbar {settings.showControls ? "on" : "off"}
          </button>
          <button type="button" onClick={onToggleTheme}>
            {theme === "dark" ? "Light" : "Dark"} theme
          </button>
        </div>
        {open && <PerformanceMetrics store={metrics} />}
      </div>
    </details>
  );
}

function PerformanceMetrics({ store }: { store: MetricsStore }) {
  const metrics = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div className="playground__metrics" role="group" aria-label="Renderer performance">
      <div className="playground__metrics-heading">
        <span>Performance</span>
        <span className="playground__activity" data-activity={metrics?.activity ?? "sampling"}>
          {metrics?.activity ?? "Measuring"}
        </span>
      </div>
      <dl className="playground__metrics-values">
        <div title="Graph-rendered animation frames per second; zero when idle.">
          <dt>Graph FPS</dt>
          <dd data-metric="fps">{metrics?.fps?.toFixed(0) ?? "—"}</dd>
        </div>
        <div title="Renderer CPU time per rendered frame. Excludes physics and GPU time.">
          <dt>Render CPU</dt>
          <dd data-metric="render">{metrics ? `${metrics.renderMs.toFixed(2)} ms/frame` : "—"}</dd>
        </div>
        <div title="CPU time per d3-force simulation tick.">
          <dt>Physics CPU</dt>
          <dd data-metric="physics">
            {metrics ? `${metrics.simulationMs.toFixed(2)} ms/tick` : "—"}
          </dd>
        </div>
        <div>
          <dt>Nodes / links</dt>
          <dd data-metric="graph">
            {metrics ? `${metrics.nodeCount} / ${metrics.linkCount}` : "—"}
          </dd>
        </div>
        <div>
          <dt>Canvas</dt>
          <dd data-metric="canvas">
            {metrics ? `${metrics.canvasWidth} × ${metrics.canvasHeight} px` : "—"}
          </dd>
        </div>
        <div>
          <dt>Pixel ratio</dt>
          <dd data-metric="pixel-ratio">{metrics ? `${metrics.pixelRatio.toFixed(2)}×` : "—"}</dd>
        </div>
      </dl>
      <p className="playground__metrics-note">Sampled while open. Idle graphs do not render.</p>
    </div>
  );
}
