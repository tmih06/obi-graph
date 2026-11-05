<img width="1802" height="973" alt="image" src="https://github.com/user-attachments/assets/238ea12f-36d3-43ff-83f9-ef1e5b961bea" />

# obi-graph

[**Live demo**](https://obi-graph.tmih06.com/) — a 1,420-species animal taxonomy with notes, wiki-links and the density slider.

An Obsidian-style graph view for React. Force-directed dots, labels that fade in
as you zoom, hover focus that dims everything else, draggable nodes, inertial
pan and pointer-anchored zoom — all drawn on a single `<canvas>`.

It is the graph _engine_, not a note-taking app: you own the data and the
styling. React 18+ is its only peer dependency — the force simulation and
everything else ship inside the package.

## Install

```sh
npm install obi-graph react
```

```sh
# pnpm install obi-graph react
# yarn add obi-graph react
# bun add obi-graph react
```

React is a peer dependency, so install it alongside — the package does not
bundle its own copy. Nothing else is required: there are no runtime
dependencies at all.

Then render it. The canvas fills its parent, so the parent needs a height:

```tsx
import { GraphCanvas, type GraphLink, type GraphNode } from "obi-graph";
import "obi-graph/styles.css";

const nodes: GraphNode[] = [
  { id: "lion", label: "Lion", radius: 8 },
  { id: "cat", label: "Cat", radius: 5 },
];
const links: GraphLink[] = [{ source: "cat", target: "lion" }];

export function Graph() {
  return (
    <div style={{ position: "relative", height: 500 }}>
      <GraphCanvas nodes={nodes} links={links} />
    </div>
  );
}
```

The stylesheet import is the piece that is easy to miss. It carries the
palette tokens the renderer reads at runtime and the container rule
(`position: absolute; inset: 0`) that makes the graph fill its parent, so
skipping it collapses the layout even though the canvas still paints.

| Runtime  | Supported                                                      |
| -------- | -------------------------------------------------------------- |
| React    | 18 and 19 (peer `>=18`); both render and typecheck             |
| Bundlers | Any that honour `exports` — Vite, Next.js, webpack, Bun        |
| SSR      | Safe; markup renders on the server, drawing starts after mount |

The package is ESM-only and tree-shakeable: importing just `connectionsFor`
bundles 28 KB before gzip, versus 83 KB for the whole entry. Bundlers resolve it
through the `exports` map (verified with Vite, Bun and webpack 5). CommonJS code
can `require()` it on Node 20.19+ or 22.12+, where requiring ESM is supported;
on older Node it throws `ERR_REQUIRE_ESM` — use an import there instead.

### Next.js

Put the component in a `"use client"` module. Imports and SSR are safe — the
graph draws after mount — but the canvas touches `window`, so it cannot run in a
Server Component body.

```tsx
// app/graph.tsx
"use client";
import { GraphCanvas, type GraphLink, type GraphNode } from "obi-graph";
import "obi-graph/styles.css";

export function Graph(props: { nodes: GraphNode[]; links: GraphLink[] }) {
  return (
    <div style={{ position: "relative", height: 500 }}>
      <GraphCanvas {...props} />
    </div>
  );
}
```

## Compared to Obsidian's graph view

The look and interaction model are deliberately the same.

| Obsidian graph view                                       | obi-graph                                  |
| --------------------------------------------------------- | ------------------------------------------ |
| Force layout (charge, link, collision, center)            | Same forces, same tuning knobs             |
| Labels fade out below a zoom threshold                    | `labels.zoomThreshold` + `fadeRange`       |
| Hover highlights a node and its neighbours, dims the rest | Same, easing over 240 ms                   |
| Drag a node, pan with inertia, wheel-zoom to the pointer  | Same                                       |
| Fit View / Reset Layout controls                          | Same, plus a built-in toolbar              |
| Colour and size groups                                    | `nodes.color` / `nodes.radius` accessors   |
| Runs inside Obsidian over your vault                      | A React component over your arrays         |
| Search, tag filters, saved groups                         | Your UI — pass `activeIds` / `emphasisIds` |
| Arrowheads and curved links                               | `links.arrow`, `links.curve` per link      |

## Data

Only `id`, `source` and `target` are required. Put your own payload in `data`;
the renderer never reads it.

```tsx
import { GraphCanvas, type GraphConfig, type GraphNode } from "obi-graph";

type Note = { words: number; folder: "daily" | "project" };

const nodes: GraphNode<Note>[] = [
  { id: "a", label: "Sprint plan", data: { words: 400, folder: "project" } },
  { id: "b", label: "Tuesday", data: { words: 90, folder: "daily" } },
];
const links = [{ source: "a", target: "b" }];

const config: GraphConfig<Note> = {
  nodes: {
    radius: (node) => 2 + Math.sqrt(node.data?.words ?? 0) * 0.4,
    color: (node) => (node.data?.folder === "daily" ? "#10b981" : "#8b5cf6"),
  },
};

export function Notes() {
  return (
    <div style={{ position: "relative", height: 600 }}>
      <GraphCanvas nodes={nodes} links={links} config={config} />
    </div>
  );
}
```

Precedence is per-item property → configured value/accessor → default. Accessors
run when data or config changes, never per frame, and receive your original
objects. Update arrays immutably; layout fields are copied, so your objects are
never mutated.

**Node fields:** `id`, `label`, `data`, `radius`, `color`, `shape` (`circle` |
`square` | `triangle` | `diamond` | `pentagon`), `charge`, `x`, `y`, `fx`/`fy`
(pin an axis; `null` releases it), `hub` (keeps its label at every zoom, like a
pinned topic note).

**Link fields:** `source`, `target`, `id`, `data`, `color`, `width`, `dashed`,
`distance`, `strength`, `curve` (0 is straight; two links between the same pair
need opposite signs), `arrow` (head at the target end).

Duplicate ids and unknown endpoints throw descriptive errors.

## Configuration

Every field of `GraphConfig<NodeData, LinkData>` is optional. Appearance settings
accept a constant or an accessor function.

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

Physics, topology, radius and pin changes keep live positions and gently reheat
the solver; label, colour, width and dash changes repaint without touching a
settled layout. Dragging a node releases it back into the simulation unless you
pinned it with `fx`/`fy`.

### Hover threshold

Zoomed out, a node can be a fraction of a pixel wide — hovering it dims the map
around a dot you cannot see. `interaction.hoverMinZoom` disables hover entirely
below a zoom level: no highlight, no dimming, neutral cursor.

```tsx
const config: GraphConfig = { interaction: { hoverMinZoom: 1.1 } };
```

`0` (the default) leaves hover enabled at every zoom. The demo uses `1.1`, so the
fitted overview stays still and hover begins once you zoom into a cluster.

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

Omit `selectedId` for internal state; `defaultSelectedId` sets its initial value;
explicit `null` means controlled and cleared. `onSelect(id, node)` gets your
original node, or `(null, null)` for empty space.

`activeIds` dims nodes outside the set, `emphasisIds` outlines them, and
`theme: "light" | "dark"` plus `className`/`style` style the container.
`connectionsFor(id, { nodes, links })` returns typed neighbours.

The canvas is visual and hidden from screen readers — provide an accessible list
or inspector from the same data.

### Metrics

`onMetrics={(m) => ...}` reports `GraphMetrics` up to four times per second while
active: rendered FPS, render and physics CPU milliseconds, node/link counts,
canvas size, pixel ratio and activity. At idle it reports FPS 0 and stops. Keep
the readout in its own component so it does not re-render the graph.

## Large graphs

The demo renders 3,584 nodes and 3,583 links at 60 fps while hovering, about
40 fps during a node drag. Two engine choices get it there:

- **Grid forces instead of quadtree forces.** A general-purpose force library
  rebuilds a quadtree
  object graph every tick for both many-body repulsion and collision. At a few
  thousand nodes that costs ~16 ms and ~14 ms per tick, so a settle frame
  overruns. The built-in replacements keep d3's math and API on flat typed
  arrays: Barnes-Hut over a quadtree in `Int32Array`/`Float64Array` for
  repulsion, a uniform grid for collision. Measured on 3,584 nodes: charge
  16 ms → ~5 ms, collision 14 ms → ~1.2 ms per tick.
- **Nothing renders while idle.** Frames are scheduled only for a settle, a
  gesture or a highlight transition. Hit testing walks a typed-array coordinate
  buffer, and sub-pixel nodes paint as `rect` instead of arcs.

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

Capacity depends on topology, zoom, hardware and label density. The renderer is
Canvas 2D on the main thread, not WebGL. Measure with `onMetrics`.

## Theming

Styles are scoped to `.graph-canvas` and do not touch the page. Override tokens
on the graph's own class or `style`:

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

Toolbar tokens: `--graph-control-surface`, `--graph-control-line`,
`--graph-control-fg`, `--graph-control-hover`, `--graph-control-shadow`.

## Development

```sh
bun install
bun run dev      # demo on port 5190 (PORT overrides)
bun run ci       # format, lint, typecheck, tests, build
bun run build    # library in dist/, demo in demo-dist/
```

The demo is a real animal taxonomy: 1,420 species and 2,164 higher taxa sampled
from Wikidata. The Playground's **Nodes** slider keeps a stable random 1–100% of
them — survivors are re-attached to their nearest kept ancestor, so the graph
stays one connected tree at any density. The six animal classes hang off their
real shared ancestry (class → clade → phylum → Animalia); those shared nodes are
drawn neutral grey because they belong to no single class.

Selecting a node opens an overlay note panel without resizing, scrolling, or
re-framing the graph. Keyboard focus moves into the panel without scrolling.
Notes are markdown composed from the same taxonomy, with
`[[wiki-links]]` that jump between nodes. The markdown parser is loaded with a
dynamic import only when the first note opens, and it is demo-only — the
published library has no markdown dependency.

Data is generated once by `bun scripts/fetch-taxonomy.ts` and committed as
`src/demo/animal-data.ts`, so the demo runs offline.

### Hosting on Cloudflare Pages

The demo is a static site in `demo-dist`, served from the domain root.

| Setting                | Value                |
| ---------------------- | -------------------- |
| Build command          | `bun run build:demo` |
| Build output directory | `demo-dist`          |
| Environment variable   | `BUN_VERSION=1.4.4`  |

Cloudflare serves Brotli/gzip; `public/_headers` caches the content-hashed
`/assets/*` for a year and revalidates `index.html`. Total transfer is ~143 KB
gzipped: 54 KB of taxonomy in its own chunk, 87 KB of app and engine, 3 KB of
CSS and HTML.

The taxonomy ships as a positional, interned payload — every Wikidata QID, rank
and group name appears once in a lookup table, and rows carry small integers.
Rolldown emits it as a separate chunk with `modulepreload`, so data and code
download in parallel and the first paint is not blocked by the payload.

## License

MIT © Thanh Minh. See [LICENSE](LICENSE).
