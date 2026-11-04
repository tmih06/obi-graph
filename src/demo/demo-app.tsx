import { useCallback, useEffect, useMemo, useState } from "react";
import { GraphCanvas, type GraphConfig, type Theme } from "../graph/index.ts";
import {
  MEDIA,
  buildDemoGraph,
  shapeForMedia,
  type DemoLinkData,
  type DemoNodeData,
} from "./demo-graph.ts";
import {
  createMetricsStore,
  GraphPlayground,
  type PlaygroundSettings,
} from "./graph-playground.tsx";

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
  const graph = useMemo(buildDemoGraph, []);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [metrics] = useState(createMetricsStore);
  const [settings, setSettings] = useState<PlaygroundSettings>({
    charge: -600,
    linkStrength: 0.3,
    linkDistance: 200,
    nodeScale: 0.65,
    showLabels: true,
    showControls: true,
  });
  const { charge, linkStrength, linkDistance, nodeScale, showLabels, showControls } = settings;

  /** Domain data chooses size/shape; the engine supplies the uniform neutral fill. */
  const config = useMemo<GraphConfig<DemoNodeData, DemoLinkData>>(() => {
    return {
      physics: { charge, linkStrength, linkDistance },
      nodes: {
        radius: (node) => (node.data?.size ?? 5) * nodeScale,
        shape: (node) => shapeForMedia(node.data?.media),
      },
      links: {
        dashed: (link) => link.data?.relation === "similarity",
        width: (link) => (link.data?.relation === "similarity" ? 0.7 : 0.9),
        distance: linkDistance,
      },
      labels: {
        visible: showLabels,
      },
      controls: showControls,
    };
  }, [charge, linkStrength, linkDistance, nodeScale, showLabels, showControls]);

  return (
    <main className="demo" aria-label="Graph playground">
      <GraphCanvas
        theme={theme}
        nodes={graph.nodes}
        links={graph.links}
        config={config}
        onMetrics={playgroundOpen ? metrics.update : undefined}
      />

      <div className="demo__legend">
        {MEDIA.map((media) => (
          <span key={media} className="demo__legend-item">
            <span className="demo__swatch" data-shape={shapeForMedia(media)} aria-hidden="true" />
            {media}
          </span>
        ))}
        <span className="demo__legend-item">
          <span className="demo__swatch demo__swatch--dashed" aria-hidden="true" />
          similarity
        </span>
      </div>
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
