import { useCallback, useEffect, useMemo, useState } from "react";
import { GraphCanvas, connectionsFor, type GraphLink, type Theme } from "../graph/index.ts";
import { buildDemoGraph } from "./demo-graph.ts";

const THEME_KEY = "obi-graph-theme";

function initialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The engine reads CSS custom properties off `<html>`; toggling the `dark`
 * class is therefore all a host needs to re-theme the map. The demo also
 * disables transitions for one frame so the flip does not smear.
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

export function DemoApp() {
  const { theme, toggle } = useTheme();
  const graph = useMemo(buildDemoGraph, []);
  const [selectedId, setSelectedId] = useState<string | null>("pattern:3");
  const [focusAudience, setFocusAudience] = useState<string | null>(null);

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
  const connections = useMemo(() => {
    if (!selectedId) return [];
    return connectionsFor(selectedId, graph);
  }, [graph, selectedId]);

  const hubs = graph.nodes.filter((node) => node.hub);

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
            selectedId={selectedId}
            activeIds={activeIds}
            emphasisIds={EMPTY}
            showContextLabels={false}
            labelHubsAlways
            onSelect={setSelectedId}
          />

          <div className="demo__legend">
            {(["circle", "square", "triangle", "diamond", "pentagon"] as const).map(
              (shape, index) => (
                <span key={shape} className="demo__legend-item">
                  <span className="demo__swatch" data-shape={shape} aria-hidden="true" />
                  {["text", "image", "video", "audio", "link"][index]}
                </span>
              ),
            )}
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
                  onClick={() => setFocusAudience(hub.label)}
                >
                  {hub.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="demo__heading">Selection</h2>
            {selected ? (
              <div className="demo__detail">
                <p className="demo__detail-title">{selected.label}</p>
                <p className="demo__detail-body">{selected.description}</p>
                <dl className="demo__stats">
                  <div>
                    <dt>kind</dt>
                    <dd>{selected.kind}</dd>
                  </div>
                  <div>
                    <dt>links</dt>
                    <dd>{selected.degree}</dd>
                  </div>
                  <div>
                    <dt>radius</dt>
                    <dd>{selected.radius.toFixed(1)}</dd>
                  </div>
                </dl>
                <ul className="demo__connections">
                  {connections.slice(0, 8).map((connection) => (
                    <li key={`${connection.node.id}:${connection.relation}`}>
                      <button
                        type="button"
                        className="demo__connection"
                        onClick={() => setSelectedId(connection.node.id)}
                      >
                        <span>{connection.node.label}</span>
                        <span className="demo__relation">
                          {connection.relation}
                          {connection.node.hub ? " · hub" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
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
              {graph.links.filter((link: GraphLink) => link.relation === "similarity").length}{" "}
              similarity
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

const EMPTY: Set<string> = new Set();
