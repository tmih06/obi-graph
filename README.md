# obi-graph

A small React canvas renderer for interactive force-directed node graphs. Smooth pointer-anchored zoom, inertial pan, node dragging, selection, and collision-aware screen-space labels. Inspired by the feel of Obsidian's graph; not its renderer or an Obsidian dependency.

React 18+ is a peer dependency. The only runtime dependency is `d3-force`; drawing and gestures use native browser APIs. No per-node DOM, icon library, SVG graph layer, or perpetual render loop.

## Install and render

```sh
npm install obi-graph react
# or: bun add obi-graph react
```

```tsx
import { GraphCanvas } from "obi-graph";
import "obi-graph/styles.css";

const nodes = [
  { id: "notes", label: "Notes", radius: 10, color: "#8b5cf6" },
  { id: "ideas", label: "Ideas", shape: "diamond" as const },
];
const links = [{ source: "notes", target: "ideas", strength: 0.6 }];

export function Map() {
  return (
    <div style={{ position: "relative", height: 500 }}>
      <GraphCanvas nodes={nodes} links={links} />
    </div>
  );
}
```

The graph fills its parent; give that parent a size and positioning context. Import the stylesheet once. Next.js App Router callers should put their graph wrapper in a `"use client"` module. Package imports and server-side rendering are safe; actual drawing starts after browser mount.

The repository builds a publishable ESM package; it does not publish automatically. Before registry publication, choose a license and ensure ownership/availability of the `obi-graph` package name. A local packed tarball can be installed before publication (see below).

## Your data, your visual properties

Only a node's string `id` and a link's string `source` / `target` are required. Put arbitrary application payloads in typed `data`; the engine does not interpret them.

```tsx
import { useMemo } from "react";
import { GraphCanvas, type GraphConfig, type GraphNode, type GraphLink } from "obi-graph";

type Note = { title: string; importance: number; category: "note" | "tag" };
type Relationship = { weight: number };

const nodes: GraphNode<Note>[] = [
  { id: "one", label: "One", data: { title: "First note", importance: 3, category: "note" } },
  { id: "two", label: "Two", data: { title: "Second note", importance: 1, category: "tag" } },
];
const links: GraphLink<Relationship>[] = [{ source: "one", target: "two", data: { weight: 0.8 } }];

export function NotesGraph() {
  const config = useMemo<GraphConfig<Note, Relationship>>(
    () => ({
      nodes: {
        radius: (node) => 4 + (node.data?.importance ?? 1) * 2,
        color: (node) => (node.data?.category === "tag" ? "#10b981" : "#8b5cf6"),
        shape: (node) => (node.data?.category === "tag" ? "diamond" : "circle"),
        charge: (node) => -100 * (node.data?.importance ?? 1),
      },
      links: {
        strength: (link) => link.data?.weight ?? 0.3,
        distance: 100,
        width: 1,
      },
      physics: { collisionPadding: 8, velocityDecay: 0.5 },
      labels: { alwaysVisible: true },
      camera: { autoFitSelection: false },
    }),
    [],
  );

  return (
    <div style={{ position: "relative", height: 500 }}>
      <GraphCanvas
        nodes={nodes}
        links={links}
        config={config}
        onSelect={(id, node) => console.log(id, node?.data?.title)}
      />
    </div>
  );
}
```

**Precedence:** per-item property → configured value/accessor → default. Accessors receive your original objects and run when data/configuration changes, not on animation frames. A node's explicit `radius` therefore overrides `config.nodes.radius`, even if the latter is a function.

Use immutable updates: replace changed arrays/configuration rather than mutating them in place. Memoize stable data and configuration to avoid unnecessary normalization. The engine copies layout fields and never lets d3 mutate caller nodes or links; payloads are retained by reference, not deep-copied.

### Node fields

| Field      | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `id`       | Required, unique non-empty string.                                               |
| `label`    | Display name; defaults to `id`.                                                  |
| `data`     | Your typed application payload.                                                  |
| `radius`   | Radius in graph units; default 3.25 (65% of the original size).                  |
| `color`    | Canvas-compatible CSS color, e.g. hex/rgb/hsl.                                   |
| `shape`    | `circle`, `square`, `triangle`, `diamond`, or `pentagon`.                        |
| `charge`   | Many-body strength; negative repels, positive attracts.                          |
| `x`, `y`   | Initial coordinates; changing an explicit coordinate repositions the node.       |
| `fx`, `fy` | Pin either axis. Set to `null` or remove a prior model pin to release it.        |
| `hub`      | Label anchor: chip background and hub-label behavior. Does **not** pin the node. |

Coordinates remain stable across data refreshes. Unchanged explicit seeds do not reset settled positions. Dragging a free node releases it back into the simulation; dragging a pinned node restores the caller's pin on release.

### Link fields

| Field                      | Meaning                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `source`, `target`         | Required node ids.                                                                                   |
| `id`                       | Optional unique non-empty id; generated from endpoints if omitted. Parallel links need explicit ids. |
| `data`                     | Your typed relationship payload.                                                                     |
| `color`, `width`, `dashed` | Stroke color, width in CSS pixels, dashed/solid.                                                     |
| `distance`, `strength`     | Rest length in graph units and spring strength.                                                      |

Duplicate ids and missing endpoints throw descriptive errors. Links are drawn as straight, undirected strokes; applications decide relationship semantics. Color values are actual Canvas CSS colors, not unresolved `var(...)` expressions.

## Configuration

Every group and field in `GraphConfig<NodeData, LinkData>` is optional. Values should be finite and in the documented range. `nodes.radius/color/shape/charge` and `links.color/width/dashed/distance/strength` accept either a constant or an accessor function.

| Group         | Settings and defaults                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `physics`     | `charge: -600`, `chargeDistance: 650`, `linkDistance: 200`, `linkStrength: 0.3`                                                                                               |
|               | `collisionPadding: 10`, `collisionStrength: 1`, `collisionIterations: 3`, `centerStrength: 0.025`                                                                             |
|               | `alphaDecay: 0.035`, `velocityDecay: 0.5`, `warmupTicks: 0`, `settleTicks: 100`, `settleMs: 2000`                                                                             |
| `nodes`       | `radius: 3.25`, `shape: "circle"`, `dimOpacity: 0.16`; uniform neutral-grey theme fill (`#bfc3c9`); charge falls back to `physics.charge`                                     |
| `links`       | `width: 0.9`, `dashed: false`; theme color; distance/strength fall back to `physics.linkDistance/linkStrength`                                                                |
| `labels`      | `visible: true`, `alwaysVisible: false`, `hubLabelsAlways: false`, `fontSize: 11`, `hubFontSize: 12`, `zoomThreshold: 1.25`, `fadeRange: 0.3`; theme `color` and `fontFamily` |
| `camera`      | `minZoom: 0.04`, `maxZoom: 8`, `fitPadding: 92`, `autoFitSelection: true`, `selectionBottomInset: 0`                                                                          |
| `interaction` | `dragNodes: true`, `pan: true`, `zoom: true`, `inertia: true`                                                                                                                 |
| `rendering`   | `pixelRatio`: device DPR unless explicitly set to a positive number                                                                                                           |
| `controls`    | `true`; set `false` to hide the built-in toolbar                                                                                                                              |

All node titles use the same zoom fade, including hubs. The effective threshold is the larger of `zoomThreshold` and 1.15 times the most recent Fit View zoom, so the fitted overview hides normal titles. Zooming closer reveals them uniformly. Hover or selection reveals the focused title and directly connected titles even at Fit View. Explicit `alwaysVisible` / `hubLabelsAlways` opt out of this fading.

Strengths, decay factors, opacity and damping use 0–1. Distances/radii/padding are non-negative; zoom bounds and pixel ratio are positive with `minZoom <= maxZoom`. Tick counts are non-negative integers. Font sizes and `fadeRange` are positive. `settleMs` is a non-negative upper time bound.

`centerStrength` adjusts the weak x/y pull toward the origin; the layout also recenters the graph. Increasing `velocityDecay` damps motion faster. `warmupTicks` is an optional synchronous pre-solve: leave it at zero for fast first paint. Live relaxation stops at the tick/time limit or when the solver cools. Reduced-motion preferences suppress animated settling, inertia and camera tweens; explicit warmup is still honored.

Physics/topology/radius/pin changes preserve live positions and velocities. Force tuning gently reheats the solver instead of restarting at full energy; slider updates do not rewind the graph, reset the camera, or discard unchanged label bitmaps. Label, color, width, and dash changes repaint without reheating a settled layout. Restart Layout reseeds free nodes while preserving pan and zoom, with no fit or snap-back when settling ends. The initial graph may auto-fit once; explicit camera gestures cancel that pending fit. Fit View remains the explicit framing control. Model coordinates and pins remain authoritative.

`interaction` controls pointer gestures; toolbar camera commands remain available while the toolbar is visible. Touch supports single-finger pan and two-finger zoom; node dragging is mouse/pen. Wheel zoom prevents page scroll only when graph zoom is enabled.

## Selection and events

Selection works internally without any additional props. For controlled selection:

```tsx
const [selectedId, setSelectedId] = useState<string | null>(null);

<GraphCanvas
  nodes={nodes}
  links={links}
  selectedId={selectedId}
  onSelect={(id, node) => setSelectedId(id)}
  onNodeHover={(node) => console.log(node?.id)}
/>;
```

Omit `selectedId` for internal state; `defaultSelectedId` sets its initial value. Explicit `selectedId={null}` means controlled, cleared selection. `onSelect(id, node)` receives your original node, or `(null, null)` for empty space. `onNodeHover(node)` receives the original node, or `null` on exit.

`activeIds?: ReadonlySet<string>` dims nodes outside the set (omit for all active); `emphasisIds?: ReadonlySet<string>` adds outlines. `className`, `style`, `ariaLabel`, and `theme: "light" | "dark"` customize the graph container. Default theme is light; pass your application's current theme explicitly.

Hover eases the current node and its incident links to the purple theme accent (`--graph-accent`). Directly connected nodes retain a neutral bright highlight; unrelated nodes and links dim. Clicking keeps the same focus effect selected, with **no selection border or halo**. Hovering another node temporarily overrides selection; leaving restores the selected focus. Clicking empty space clears selection. Highlighting, title reveal, link width and dimming ease in/out over 240 ms, continuing from their current visual values when the pointer changes nodes quickly. The current focus title smoothly grows to 125% and shrinks back when focus changes; neighbour titles stay at normal size. Reduced motion applies these changes immediately.

Labels sit directly below their nodes with a consistent 3 px gap to the label bitmap. The current focus label eases another 6 px downward to clear the cursor; neighbour labels stay close. Text scaling uses cached, supersampled bitmaps instead of allocating a new canvas for every intermediate font size. During a node drag, focus remains on the dragged node and its one-hop neighbourhood, including the revealed titles, even if the pointer crosses another node or leaves the canvas. Release follows the hover under the pointer, falling back to the selected focus; release outside or cancellation also restores selection, or clears focus if nothing is selected.

`connectionsFor(id, { nodes, links })` returns typed `{ node, link }` entries for either link direction. Resolved d3 endpoints are accepted too. `endpointId` unwraps string/number/object endpoints. Exported model types include `GraphNode`, `GraphLink`, `NodeShape`, `Connection`, `Endpoint`, and `ResolvedLink`.

The canvas is visual and hidden from screen readers; provide an accessible list or inspector using the same data and selection state. The built-in toolbar uses labelled buttons.

## Themes without host-page side effects

Styles are scoped to `.graph-canvas`; importing them does not change `<html>`, the page theme, or the host font. Separate graph instances can have different themes. Override tokens on the graph's own class or `style`, not only an ancestor, because each graph defines its own defaults.

```css
.my-graph {
  --graph-surface: #101419;
  --graph-accent: #7dd3fc;
  --graph-node: #bfc3c9;
  --graph-line: #64748b;
  --graph-text: #94a3b8;
  --graph-foreground: #f8fafc;
  --graph-font-sans: Inter, system-ui, sans-serif;
}
```

Toolbar tokens: `--graph-control-surface`, `--graph-control-line`, `--graph-control-fg`, `--graph-control-fg-hover`, `--graph-control-hover`, `--graph-control-shadow`. Changing `theme`, `className`, or the `style` object re-reads the palette. Direct stylesheet mutations without a prop change are not observed automatically.

## Lightweight rendering

- No blocking warmup by default; settling is finite and RAF-driven, with no second d3 animation loop.
- Idle graphs schedule no animation frames.
- Item accessors, color resolution, stroke grouping and label priority sorting stay outside frame loops.
- Nodes and links, including purple focus states, are drawn in style batches. Only explicitly outlined `emphasisIds` need individual overlay drawing.
- Off-screen nodes, labels and links with fully off-screen bounds are culled; links crossing the viewport remain eligible.
- Reusable screen-cell grids avoid scanning every placed label and every hub for each candidate.
- Label metrics are cached; glyph canvases are created only after visibility/collision acceptance and reused across frames.
- One React canvas, not one element per graph item; React does not receive position updates on simulation ticks.

For dense graphs on high-DPI devices, reduce raster cost explicitly:

```tsx
const config: GraphConfig = {
  controls: false,
  rendering: { pixelRatio: 1 },
  labels: { visible: false },
  physics: { collisionIterations: 1, chargeDistance: 400 },
  camera: { autoFitSelection: false },
};
```

This trades label detail and collision precision for less work; it is not a promise of a particular node capacity or frame rate. Solver cost depends on topology, zoom, hardware and label density. The renderer uses Canvas 2D on the main thread, not WebGL or a worker.

## Develop, build, and package

```sh
bun install
bun run dev          # demo, default port 5190; override with PORT
bun run check        # formatting, lint, typecheck
bun test             # model, layout/update and label-collision behavior
bun run build:lib    # minified dist/index.js, declarations and styles
bun run build:demo   # separate demo-dist directory
bun run build        # library + demo
bun pm pack          # prepack builds the library; creates obi-graph-0.1.0.tgz
```

Install the generated tarball into another app with `npm install /path/to/obi-graph-0.1.0.tgz` (or `bun add /path/to/obi-graph-0.1.0.tgz`). Consumers need neither Bun nor a TypeScript source loader at runtime. The package exports compiled ESM, declarations, and `obi-graph/styles.css`; demo assets are excluded.

The demo retains the original 37-node / 161-link example and exposes live force, link-distance, node-size, label and toolbar controls. Its initial size scale is 0.65×, charge −600, link strength 0.3 and distance 200 for every link; all nodes share the neutral-grey fill and nothing is initially selected.

### Development annotations

Agentation is installed as a development dependency and mounted only by `bun run dev`. Open its bottom-right **Start feedback mode** toolbar to select elements, add notes and copy structured feedback. For individual canvas nodes, use area annotations: the graph is one canvas, not separate DOM elements per node. Local annotations work without an MCP server; agent sync requires an explicitly configured Agentation endpoint.

The annotation UI is excluded from the production demo and the published library; graph consumers do not install Agentation as a runtime dependency.

### Migrating the original source-only interface

`kind`, `description`, `media`, `degree`, `relation`, and `similarity` are no longer renderer fields. Store them in `data` and choose styles explicitly. `GraphNodeKind`/`GraphRelation` were removed. `connectionsFor` returns `.link` instead of `.relation`. Move old `showContextLabels`/`labelHubsAlways` into `config.labels.alwaysVisible/hubLabelsAlways`, and `autoFitSelection`/`selectionBottomInset` into `config.camera`. `theme`, selection callbacks, and filter sets are no longer required.
