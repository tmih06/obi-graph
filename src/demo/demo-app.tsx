import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GraphCanvas,
  connectionsFor,
  type Connection,
  type GraphConfig,
  type Theme,
} from "../graph/index.ts";
import {
  MEDIA,
  buildDemoGraph,
  shapeForMedia,
  type DemoLinkData,
  type DemoNodeData,
} from "./demo-graph.ts";

const THEME_KEY = "obi-graph-theme";

/** The demo owns its colours: the engine no longer decodes a domain palette. */
const PALETTE = {
  light: { surface: "#ffffff", accent: "#7048e8", anchor: "#737373" },
  dark: { surface: "#1b1c1f", accent: "#a78bfa", anchor: "#b3b3b3" },
} as const;

function initialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Blend two `#rrggbb` colours in sRGB; keeps the degree ramp tied to the theme. */
function mixColor(from: string, to: string, amount: number): string {
  const channels = (color: string) =>
    [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  const [r1, g1, b1] = channels(from);
  const [r2, g2, b2] = channels(to);
  const blend = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return `rgb(${blend(r1!, r2!)}, ${blend(g1!, g2!)}, ${blend(b1!, b2!)})`;
}

/**
 * The canvas resolves its palette from CSS custom properties on its own box, so
 * the `theme` prop is what flips them; the demo still toggles the `dark` class
 * so its own shell follows. Transitions are disabled for one frame so the flip
 * does not smear.
 */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.classList.toggle("dark", theme === "dark");
    void root.offsetHeight;
    const frame = window.requestAnimationFrame(() => root.classList.remove("theme-switching"));
    return () => window.cancelAnimationFrame(frame);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // Storage may be blocked; the session still follows the toggle.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
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

/** One labelled slider; the value is echoed so a drag is readable as a number. */
function SliderField({ label, value, min, max, step, onChange, format }: SliderFieldProps) {
  return (
    <label className="demo__control">
      <span className="demo__control-row">
        <span>{label}</span>
        <span className="demo__control-value">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        className="demo__slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function DemoApp() {
  const { theme, toggle } = useTheme();
  const graph = useMemo(buildDemoGraph, []);
  const [selectedId, setSelectedId] = useState<string | null>("pattern:3");
  const [focusAudience, setFocusAudience] = useState<string | null>(null);
  const [charge, setCharge] = useState(-220);
  const [linkStrength, setLinkStrength] = useState(0.3);
  const [linkDistance, setLinkDistance] = useState(90);
  const [nodeScale, setNodeScale] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [showControls, setShowControls] = useState(true);

  const activeIds = useMemo(() => {
    if (!focusAudience) return new Set(graph.nodes.map((node) => node.id));
    const hubId = `segment:${focusAudience}`;
    return new Set([
      hubId,
      ...graph.links.filter((link) => link.source === hubId).map((link) => link.target),
    ]);
  }, [focusAudience, graph]);

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );
  const connections = useMemo<Connection<DemoNodeData, DemoLinkData>[]>(() => {
    if (!selectedId) return [];
    return connectionsFor<DemoNodeData, DemoLinkData>(selectedId, graph);
  }, [graph, selectedId]);

  const hubs = graph.nodes.filter((node) => node.hub);

  /**
   * Everything the old renderer decoded from domain fields is now an explicit
   * choice here: media → outline, degree → fill ramp, hub → anchor grey.
   */
  const config = useMemo<GraphConfig<DemoNodeData, DemoLinkData>>(() => {
    const palette = PALETTE[theme];
    return {
      physics: { charge, linkStrength },
      nodes: {
        radius: (node) => (node.data?.size ?? 5) * nodeScale,
        shape: (node) => shapeForMedia(node.data?.media),
        color: (node) => {
          if (node.hub) return palette.anchor;
          const weight = Math.min(1, Math.max(0, ((node.data?.degree ?? 1) - 1) / 4));
          return mixColor(palette.surface, palette.accent, 0.12 + weight * 0.88);
        },
      },
      links: {
        // A measured similarity reads as a dashed peer link and sits slightly
        // closer than the solid stem into an audience hub.
        dashed: (link) => link.data?.relation === "similarity",
        width: (link) => (link.data?.relation === "similarity" ? 0.7 : 0.9),
        distance: (link) =>
          link.data?.relation === "similarity" ? linkDistance * 0.89 : linkDistance,
      },
      labels: {
        visible: showLabels,
        hubLabelsAlways: true,
      },
      controls: showControls,
    };
  }, [theme, charge, linkStrength, linkDistance, nodeScale, showLabels, showControls]);

  return (
    <div className="demo">
      <header className="demo__header">
        <div>
          <h1 className="demo__title">obi-graph</h1>
          <p className="demo__subtitle">
            Canvas render engine: d3-force layout, camera pan/zoom, drag and selection.
          </p>
        </div>
        <button type="button" className="demo__button" onClick={toggle}>
          {theme === "dark" ? "Light" : "Dark"} theme
        </button>
      </header>

      <div className="demo__body">
        <main className="demo__stage">
          <GraphCanvas
            theme={theme}
            nodes={graph.nodes}
            links={graph.links}
            config={config}
            selectedId={selectedId}
            activeIds={activeIds}
            onSelect={setSelectedId}
          />

          <div className="demo__legend">
            {MEDIA.map((media) => (
              <span key={media} className="demo__legend-item">
                <span
                  className="demo__swatch"
                  data-shape={shapeForMedia(media)}
                  aria-hidden="true"
                />
                {media}
              </span>
            ))}
            <span className="demo__legend-item">
              <span className="demo__swatch demo__swatch--dashed" aria-hidden="true" />
              similarity
            </span>
          </div>
        </main>

        <aside className="demo__side">
          <section>
            <h2 className="demo__heading">Audience</h2>
            <div className="demo__chips">
              <button
                type="button"
                className="demo__chip"
                aria-pressed={focusAudience === null}
                onClick={() => setFocusAudience(null)}
              >
                All
              </button>
              {hubs.map((hub) => (
                <button
                  key={hub.id}
                  type="button"
                  className="demo__chip"
                  aria-pressed={focusAudience === hub.label}
                  onClick={() => setFocusAudience(hub.label ?? null)}
                >
                  {hub.label ?? hub.id}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="demo__heading">Layout</h2>
            <div className="demo__controls">
              <SliderField
                label="Charge"
                value={charge}
                min={-800}
                max={-40}
                step={10}
                onChange={setCharge}
                format={(value) => String(Math.round(value))}
              />
              <SliderField
                label="Link strength"
                value={linkStrength}
                min={0.05}
                max={1}
                step={0.05}
                onChange={setLinkStrength}
              />
              <SliderField
                label="Link distance"
                value={linkDistance}
                min={40}
                max={220}
                step={5}
                onChange={setLinkDistance}
                format={(value) => String(Math.round(value))}
              />
              <SliderField
                label="Node size"
                value={nodeScale}
                min={0.4}
                max={2}
                step={0.05}
                onChange={setNodeScale}
                format={(value) => `${value.toFixed(2)}×`}
              />
            </div>
            <div className="demo__toggles">
              <button
                type="button"
                className="demo__chip"
                aria-pressed={showLabels}
                onClick={() => setShowLabels((current) => !current)}
              >
                Labels {showLabels ? "on" : "off"}
              </button>
              <button
                type="button"
                className="demo__chip"
                aria-pressed={showControls}
                onClick={() => setShowControls((current) => !current)}
              >
                Toolbar {showControls ? "on" : "off"}
              </button>
            </div>
          </section>

          <section>
            <h2 className="demo__heading">Selection</h2>
            {selected ? (
              <div className="demo__detail">
                <p className="demo__detail-title">{selected.label ?? selected.id}</p>
                <p className="demo__detail-body">{selected.data?.description}</p>
                <dl className="demo__stats">
                  <div>
                    <dt>kind</dt>
                    <dd>{selected.data?.kind}</dd>
                  </div>
                  <div>
                    <dt>links</dt>
                    <dd>{selected.data?.degree}</dd>
                  </div>
                  <div>
                    <dt>media</dt>
                    <dd>{selected.data?.media ?? "—"}</dd>
                  </div>
                </dl>
                <ul className="demo__connections">
                  {connections.slice(0, 8).map((connection) => {
                    const relation = connection.link.data?.relation;
                    const similarity = connection.link.data?.similarity;
                    return (
                      <li key={`${connection.node.id}:${connection.link.id ?? relation ?? "link"}`}>
                        <button
                          type="button"
                          className="demo__connection"
                          onClick={() => setSelectedId(connection.node.id)}
                        >
                          <span>{connection.node.label ?? connection.node.id}</span>
                          <span className="demo__relation">
                            {relation}
                            {similarity === undefined ? "" : ` ${similarity.toFixed(2)}`}
                            {connection.node.hub ? " · hub" : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="demo__muted">Click a node or its label to inspect it.</p>
            )}
          </section>

          <section>
            <h2 className="demo__heading">Canvas</h2>
            <p className="demo__muted">
              {graph.nodes.length} nodes · {graph.links.length} links ·{" "}
              {graph.links.filter((link) => link.data?.relation === "similarity").length} similarity
            </p>
            <p className="demo__muted">
              Drag to pan, wheel or pinch to zoom, drag a node to reposition it. Rendered at{" "}
              {typeof window === "undefined" ? 1 : window.devicePixelRatio}× DPR.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
