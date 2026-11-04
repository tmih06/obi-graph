# obi-graph

Canvas graph render engine extracted from Trendifest's trend map. It draws an
interactive node-link graph on a `<canvas>`: d3-force layout, camera pan/zoom
with inertia, pinch zoom, node dragging, hover/selection, and screen-space
labels with collision avoidance.

The engine is framework-thin: React for lifecycle and events, plain Canvas 2D
for every pixel, `d3-force` only for the layout. There is no SVG layer, no
per-node DOM, and no animation frame once the graph has settled.

## Run

```sh
bun install
bun run dev      # vite-plus dev server on :5190
bun run build    # tsc --noEmit && vp build
bun run check    # vite-plus format + lint + type check
bun test         # model unit tests
```

`src/main.tsx` mounts `src/demo/demo-app.tsx`, a harness with synthetic data
(37 nodes, 161 links) that exercises selection, audience filtering, both
themes and every gesture.

## Use

```tsx
import { GraphCanvas, type GraphLink, type GraphNode } from "obi-graph";
import "obi-graph/styles.css";

<GraphCanvas
  theme={theme} // "light" | "dark"; must match a class on <html>
  nodes={nodes}
  links={links}
  selectedId={selectedId}
  activeIds={activeIds} // dimmed when absent
  emphasisIds={emphasisIds} // outlined when present
  showContextLabels={false}
  onSelect={setSelectedId}
/>;
```

The canvas is absolutely positioned and fills its parent, so give it a sized,
`position: relative` container.

| Prop                | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `theme`             | Forces a palette re-read after the host flips its theme class.        |
| `nodes` / `links`   | Model from `./model.ts`; `radius` is in graph units.                  |
| `selectedId`        | Selected node; drives the ring, label emphasis and the focus control. |
| `activeIds`         | Nodes drawn at full opacity; everything else dims.                    |
| `emphasisIds`       | Nodes with an accent outline.                                         |
| `showContextLabels` | Draw every label, ignoring the zoom-level fade.                       |
| `labelHubsAlways`   | Keep anchor labels visible at any zoom.                               |
| `autoFitSelection`  | Re-frame the camera onto the selection when it changes.               |
| `onSelect`          | Receives the clicked node id, or `null` for empty space.              |

Node `kind` (`segment`, `pattern`, `pool`) and `media`
(`text`, `image`, `video`, `audio`, `link`) drive hub colour and node shape.
Nodes with `hub: true` keep their anchor label and get a solid label chip
instead of a halo.

Data refreshes that only change labels or scores reuse the existing layout
object and node coordinates; only a change in node ids or link endpoints
restarts the simulation.

## Theming

Every colour the renderer needs is a CSS custom property resolved from
`<html>` at paint setup, with light defaults and `.dark` overrides in
`graph.css`:

```
--graph-surface   --graph-foreground   --graph-text   --graph-line
--graph-node      --graph-node-focused --graph-node-attachment
--graph-control-surface  --graph-control-line  --graph-control-fg
--graph-control-fg-hover --graph-control-hover --graph-control-shadow
--graph-font-sans
```

Host tokens still work: when a `--graph-*` value is absent the renderer falls
back to `--background-primary`/`--surface`, `--text-normal`/`--fg`,
`--fg-3` and `--line-strong`. Canvas cannot read CSS variables directly, so
colours are resolved through a 1×1 probe canvas.

## Layout

`makeGraphData` seeds nodes on a golden-angle spiral, then runs a bounded
simulation (atomic charge, link, collision, weak x/y centring). A rebuild
relaxes for at most 100 ticks or 2 s, and a drag keeps the simulation warm
until release. `prefers-reduced-motion` skips both: the pre-settled spiral is
used as-is and camera tweens collapse to instant moves.

## Structure

```
src/graph/model.ts        graph types, endpointId, connectionsFor
src/graph/graph-canvas.tsx  simulation, camera, gestures, painting, labels
src/graph/graph.css       palette tokens + canvas/toolbar layout
src/graph/index.ts        public entry
src/demo/                 synthetic data and harness
tests/model.test.ts       model unit tests
```

Extracted from `trendifest/src/lib/graph.ts` and
`trendifest/src/components/trend-graph-canvas.tsx`; the app's Tailwind
utilities, `@trendifest/opendesk` button and theme hook were replaced with the
engine's own stylesheet and a `theme` prop.
