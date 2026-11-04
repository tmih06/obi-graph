import { useCallback, useEffect, useMemo, useState } from "react";
import { GraphCanvas, type GraphConfig, type Theme } from "../graph/index.ts";
import {
  GROUPS,
  buildAnimalGraph,
  colorForNode,
  radiusForNode,
  sampleAnimalGraph,
  shapeForNode,
  type AnimalLinkData,
  type AnimalNodeData,
} from "./demo-graph.ts";
import {
  createMetricsStore,
  GraphPlayground,
  type PlaygroundSettings,
} from "./graph-playground.tsx";
import { NoteDrawer } from "./note-drawer.tsx";
import { noteFor, resolveWikiLink } from "./note-content.ts";

const THEME_KEY = "obi-graph-theme";

function initialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
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

export function DemoApp() {
  const { theme, toggle } = useTheme();
  const baseGraph = useMemo(buildAnimalGraph, []);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [metrics] = useState(createMetricsStore);
  const [settings, setSettings] = useState<PlaygroundSettings>({
    charge: -90,
    linkStrength: 0.45,
    linkDistance: 70,
    nodeScale: 1,
    density: 50,
    showLabels: true,
    showControls: true,
  });
  const { charge, linkStrength, linkDistance, nodeScale, density, showLabels, showControls } =
    settings;

  /**
   * The slider picks a deterministic subset, so lowering it removes nodes
   * instead of reshuffling the map under the pointer.
   */
  const graph = useMemo(() => sampleAnimalGraph(baseGraph, density), [baseGraph, density]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The note follows the selection, so a wiki-link jump re-renders the panel in
   * place. Composed lazily: only the open note is built.
   */
  const selectedNode = useMemo(
    () => (selectedId ? graph.nodes.find((node) => node.id === selectedId) : undefined),
    [graph, selectedId],
  );
  const selectedLabel = selectedNode?.label ?? selectedId ?? "";
  const selectedMarkdown = useMemo(
    () => (selectedId ? noteFor(selectedId, selectedLabel) : ""),
    [selectedId, selectedLabel],
  );

  /**
   * Three thousand nodes need a cheaper solver: a short charge radius keeps the
   * many-body force local, one collision pass is enough with these radii, and
   * the settle window is fixed so a large graph cannot pin the main thread.
   */
  const config = useMemo<GraphConfig<AnimalNodeData, AnimalLinkData>>(
    () => ({
      physics: {
        charge,
        chargeDistance: 320,
        linkStrength,
        linkDistance,
        collisionPadding: 3,
        collisionIterations: 1,
        alphaDecay: 0.05,
        velocityDecay: 0.6,
        settleTicks: 140,
        settleMs: 1600,
      },
      nodes: {
        radius: (node) => radiusForNode(node.data) * nodeScale,
        color: (node) => colorForNode(node.data),
        shape: (node) => shapeForNode(node.data),
        dimOpacity: 0.1,
      },
      links: {
        // Trunk links are the only thing joining the six clusters, so they are
        // drawn heavier than the intra-cluster structure they span. No colour is
        // set on purpose: the theme's edge colour is translucent and must stay
        // that way, or a few thousand links paint over the whole map.
        width: (link) => (link.data?.trunk ? 1.4 : link.data?.species ? 0.5 : 0.85),
        // Species edges are directed (species -> genus), so they get a subtle
        // bow and an arrowhead. The trunk stays a plain stroke: it is a
        // hierarchy, and curving it into a knot reads as noise.
        curve: (link) => (link.data?.species ? 0.08 : 0),
        arrow: (link) => link.data?.species === true,
        // Species sit tight to their genus; trunk links span the gap between
        // clusters so the shared ancestry stays visible when zoomed out.
        distance: (link) =>
          link.data?.species
            ? linkDistance * 0.8
            : link.data?.trunk
              ? linkDistance * 4
              : linkDistance * 1.5,
        strength: (link) =>
          link.data?.trunk
            ? linkStrength * 0.5
            : link.data?.species
              ? linkStrength
              : linkStrength * 1.3,
      },
      // Hover is off below this zoom: at a fitted overview a pointer motion
      // would otherwise dim the map the moment it crosses a cluster.
      interaction: { hoverMinZoom: 1.1 },
      labels: { visible: showLabels, hubLabelsAlways: true, zoomThreshold: 1.1 },
      // Selecting a node must not reframe the graph: the note opens over it.
      camera: { autoFitSelection: false },
      controls: showControls,
    }),
    [charge, linkStrength, linkDistance, nodeScale, showLabels, showControls],
  );

  return (
    <main
      className="demo"
      aria-label="Animal taxonomy graph"
      // The drawer is an overlay, but the graph's own chrome has to stay
      // reachable, so the canvas shifts its toolbar rather than re-framing.
      data-note-open={selectedId ? "true" : "false"}
    >
      <GraphCanvas
        theme={theme}
        nodes={graph.nodes}
        links={graph.links}
        config={config}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        onMetrics={playgroundOpen ? metrics.update : undefined}
      />

      <div className="demo__legend">
        {GROUPS.map((group) => (
          <span key={group.name} className="demo__legend-item">
            <span className="demo__swatch" style={{ background: group.color }} aria-hidden="true" />
            {group.name}
          </span>
        ))}
      </div>

      <div className="demo__stats">
        {graph.nodes.length.toLocaleString()} nodes · {graph.links.length.toLocaleString()} links
        {density < 100
          ? ` (${Math.round(density)}% of ${baseGraph.nodes.length.toLocaleString()})`
          : ""}
        {" · "}data from Wikidata
      </div>

      <NoteDrawer
        nodeId={selectedId}
        title={selectedLabel}
        markdown={selectedMarkdown}
        onNavigate={(target) => {
          // Notes name taxa by display name; the graph is keyed by QID.
          const id = resolveWikiLink(target);
          if (id) setSelectedId(id);
        }}
        onClose={() => setSelectedId(null)}
      />

      <GraphPlayground
        settings={settings}
        onChange={setSettings}
        theme={theme}
        onToggleTheme={toggle}
        open={playgroundOpen}
        metrics={metrics}
        onOpenChange={(open) => {
          setPlaygroundOpen(open);
          if (!open) metrics.update(null);
        }}
      />
    </main>
  );
}
