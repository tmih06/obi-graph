# obi-graph

A canvas graph renderer for React. Force-directed layout, smooth pointer zoom and pan, node dragging, selection, and collision-aware labels. It draws thousands of nodes in a single `<canvas>` — no per-node DOM, no SVG layer, no render loop when the graph is idle.

The only runtime dependency is `d3-force`; React 18+ is a peer dependency.

```sh
npm install obi-graph react
# or: bun add obi-graph react
```

```tsx
import { GraphCanvas } from "obi-graph";
import "obi-graph/styles.css";

const nodes = [
  { id: "cat", label: "Cat", radius: 8 },
  { id: "lion", label: "Lion", radius: 5 },
];
const links = [{ source: "cat", target: "lion", strength: 0.5 }];

export function Taxa() {
  return (
    <div style={{ position: "relative", height: 500 }}>
      <GraphCanvas nodes={nodes} links={links} />
    </div>
  );
}
```

The canvas fills its parent, so give the parent a height. Import the stylesheet once. In the Next.js App Router, put the wrapper in a `"use client"` module — package imports and SSR are safe, drawing starts after mount.

## Data

Only `id`, `source` and `target` are required. Put your own payload in `data`; the renderer never reads it.

```tsx
import { GraphCanvas, type GraphConfig, type GraphLink, type GraphNode } from "obi-graph";

type Species = { rank: "genus" | "species"; wikipediaLinks: number };

const nodes: GraphNode<Species>[] = [
  { id: "Panthera", label: "Panthera", data: { rank: "genus", wikipediaLinks: 0 } },
  { id: "lion", label: "Panthera leo", data: { rank: "species", wikipediaLinks: 274 } },
];
const links: GraphLink[] = [{ source: "lion", target: "Panthera" }];

const config: GraphConfig<Species> = {
  nodes: {
    radius: (node) => (node.data?.rank === "genus" ? 6 : 3),
    color: (node) => (node.data?.rank === "genus" ? "#8b5cf6" : "#94a3b8"),
  },
  physics: { charge: -120, linkDistance: 60 },
};

export function Taxonomy() {
  return (
    <div style={{ position: "relative", height: 600 }}>
      <GraphCanvas nodes={nodes} links={links} config={config} />
    </div>
  );
}
```

Precedence is per-item property → configured value/accessor → default. Accessors run when data or config changes, never per frame, and receive your original objects. Update arrays immutably; the renderer copies layout fields, so your objects are never mutated.

**Node fields:** `id`, `label`, `data`, `radius`, `color`, `shape` (`circle` | `square` | `triangle` | `diamond` | `pentagon`), `charge`, `x`, `y`, `fx`/`fy` (pin an axis; `null` releases it), `hub` (label anchor).

**Link fields:** `source`, `target`, `id`, `data`, `color`, `width`, `dashed`, `distance`, `strength`.

Duplicate ids and unknown endpoints throw descriptive errors.

## Configuration

Every field of `GraphConfig<NodeData, LinkData>` is optional. Node and link appearance settings accept a constant or an accessor function.

| Group         | Defaults                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `physics`     | `charge: -600`, `chargeDistance: 650`, `linkDistance: 200`, `linkStrength: 0.3`, `collisionPadding: 10`, `collisionIterations: 3`, `alphaDecay: 0.035`, `velocityDecay: 0.5`, `settleTicks: 100`, `settleMs: 2000`, `warmupTicks: 0` |
| `nodes`       | `radius: 3.25`, `shape: "circle"`, `dimOpacity: 0.16`                                                                                                                                                                                |
| `links`       | `width: 0.9`, `dashed: false`; colour and distance/strength fall back to the theme and `physics`                                                                                                                                     |
| `labels`      | `visible: true`, `alwaysVisible: false`, `fontSize: 11`, `zoomThreshold: 1.25`, `fadeRange: 0.3`                                                                                                                                     |
| `camera`      | `minZoom: 0.04`, `maxZoom: 8`, `fitPadding: 92`, `autoFitSelection: true`                                                                                                                                                            |
| `interaction` | `dragNodes`, `pan`, `zoom`, `inertia` all `true`; `hoverMinZoom: 0` (disabled)                                                                                                                                                       |
| `rendering`   | `pixelRatio`: device DPR unless set                                                                                                                                                                                                  |
| `controls`    | `true` — the built-in toolbar                                                                                                                                                                                                        |

Physics, topology, radius and pin changes keep live positions and gently reheat the solver; label, colour, width and dash changes repaint without touching a settled layout. Fit View frames the graph, Reset Layout reseeds it.

## Large graphs

The demo renders 3,585 nodes and 3,584 links at 60 fps while hovering and about 40 fps during a node drag (physics + repaint each frame). Two engine choices matter when you go that far:

- **Grid forces instead of quadtree forces.** `d3-force` rebuilds a quadtree object graph every tick for both many-body repulsion and collision. At a few thousand nodes that costs ~16 ms and ~14 ms per tick respectively, so a settle frame overruns and interaction stutters. The built-in replacements keep d3's math and API but work on flat typed arrays: Barnes-Hut over a quadtree held in `Int32Array`/`Float64Array` for repulsion, and a uniform grid for collision. Measured here on 3,585 nodes: charge 16 ms → ~5 ms, collision 14 ms → ~1.2 ms per tick.
- **Nothing renders while idle.** Frames are scheduled only for a settle, a gesture or a highlight transition; hit testing walks a typed-array coordinate buffer instead of resolving styles per node, and sub-pixel nodes paint as `rect` instead of arcs.

For dense graphs on high-DPI screens, trade detail for speed:

```tsx
const config: GraphConfig = {
  controls: false,
  rendering: { pixelRatio: 1 },
  labels: { visible: false },
  physics: { collisionIterations: 1, chargeDistance: 320, settleTicks: 140 },
  camera: { autoFitSelection: false },
};
```

Capacity depends on topology, zoom, hardware and label density; the renderer is Canvas 2D on the main thread, not WebGL. Measure with `onMetrics`.

### Hover threshold

Zoomed out, a node can be a fraction of a pixel wide. Hovering it then dims the
map around a dot you cannot see, so `interaction.hoverMinZoom` disables hover
entirely below a zoom level — no highlight, no dimming, neutral cursor:

```tsx
const config: GraphConfig = { interaction: { hoverMinZoom: 1.1 } };
```

`0` (the default) leaves hover enabled at every zoom. The demo uses `1.1`, so
the fitted overview stays static and hover begins once you zoom into a cluster.

## Selection and events

```tsx
const [selected, setSelected] = useState<string | null>(null);

<GraphCanvas
  nodes={nodes}
  links={links}
  selectedId={selected}
  onSelect={(id) => setSelected(id)}
  onNodeHover={(node) => console.log(node?.id)}
/>;
```

Omit `selectedId` for internal state; `defaultSelectedId` sets its initial value; explicit `null` means controlled and cleared. `onSelect(id, node)` gets your original node or `(null, null)` for empty space.

`activeIds` dims nodes outside the set, `emphasisIds` outlines them, and `theme: "light" | "dark"` plus `className`/`style` style the container. Hover focuses the node, its neighbours and incident links; clicking keeps that focus. `connectionsFor(id, { nodes, links })` returns typed neighbours.

The canvas is visual and hidden from screen readers — provide an accessible list or inspector from the same data.

### Metrics

`onMetrics={(m) => ...}` reports `GraphMetrics` up to four times per second while active: rendered FPS, render and physics CPU milliseconds, node/link counts, canvas size, pixel ratio and activity. At idle it reports FPS 0 and stops. Keep the readout in its own component so it does not re-render the graph.

## Theming

Styles are scoped to `.graph-canvas` and do not touch the page. Override tokens on the graph's own class or `style`:

```css
.my-graph {
  --graph-surface: #101419;
  --graph-accent: #7dd3fc;
  --graph-node: #bfc3c9;
  --graph-line: #64748b;
  --graph-text: #94a3b8;
  --graph-foreground: #f8fafc;
}
```

Toolbar tokens: `--graph-control-surface`, `--graph-control-line`, `--graph-control-fg`, `--graph-control-hover`, `--graph-control-shadow`.

## Demo

```sh
bun install
bun run dev      # demo on port 5190 (PORT overrides)
bun test         # layout, model and label-collision tests
bun run check    # formatting, lint, typecheck
bun run build    # library in dist/, demo in demo-dist/
```

The demo is a real animal taxonomy: 1,420 species and 2,165 higher taxa sampled from Wikidata. The Playground's **Nodes** slider keeps a stable random 1–100% of them — survivors are re-attached to their nearest kept ancestor, so the graph stays one connected tree at any density instead of dissolving into disconnected fragments. Species are ranked by how many Wikipedia language editions carry them, so recognisable animals dominate. The six sampled classes stay connected through their real shared ancestry — class → clade → phylum → Animalia — instead of six disconnected trees; those shared nodes are drawn in a neutral grey because they belong to no single class.

Data is generated once by `bun scripts/fetch-taxonomy.ts` and committed as `src/demo/animal-data.ts`, so the demo runs offline. Bottom-left **Playground** exposes live force, size, label and theme controls; bottom-right shows the node count.

## Migrating from the source-only interface

`kind`, `description`, `media`, `degree`, `relation` and `similarity` are no longer renderer fields — store them in `data` and choose styles explicitly. `connectionsFor` returns `.link` instead of `.relation`. Move `showContextLabels`/`labelHubsAlways` into `config.labels` and `autoFitSelection`/`selectionBottomInset` into `config.camera`.
