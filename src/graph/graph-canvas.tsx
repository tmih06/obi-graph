import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { Crosshair, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { connectionsFor, endpointId, type GraphLink, type GraphNode } from "./model.ts";

type NodePoint = GraphNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};
type LinkPoint = Omit<GraphLink, "source" | "target"> & {
  source: string | number | NodePoint;
  target: string | number | NodePoint;
};
/** The layout copy: links point at ids until d3 resolves them to node objects. */
type CanvasGraph = { nodes: NodePoint[]; links: LinkPoint[] };

interface LabelHitArea {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The camera is the graph point at the viewport centre and a uniform scale.
 * Every gesture writes this one object; drawing derives the canvas transform
 * from it, so pan, zoom, fit and the controls cannot disagree.
 */
interface Camera {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 8;
/** Relaxation is finite: 100 ticks or two seconds, whichever comes first. */
const MAX_RELAX_TICKS = 100;
const MAX_RELAX_MS = 2_000;

/** Camera → screen mapping in CSS pixels, matching the d3-zoom transform. */
function graphToScreen(camera: Camera, width: number, height: number, x: number, y: number) {
  return {
    x: (x - camera.x) * camera.k + width / 2,
    y: (y - camera.y) * camera.k + height / 2,
  };
}

function screenToGraph(camera: Camera, width: number, height: number, x: number, y: number) {
  return {
    x: camera.x + (x - width / 2) / camera.k,
    y: camera.y + (y - height / 2) / camera.k,
  };
}

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

interface LabelBitmap {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  textWidth: number;
}

/** Default label face; `--graph-font-sans` overrides it from the stylesheet. */
const LABEL_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

type NodeShape = "circle" | "square" | "triangle" | "diamond" | "pentagon";

/** Content type decides shape; the visual vocabulary is also in the legend. */
function shapeFor(media: string | undefined): NodeShape {
  if (media === "image") return "square";
  if (media === "video") return "triangle";
  if (media === "audio") return "diamond";
  if (media === "link") return "pentagon";
  return "circle";
}

/**
 * Build one node outline. Polygons get optically rounded corners: each vertex
 * is replaced by a short quadratic curve, so the square and triangle still read
 * as their shape instead of losing their silhouette to a large radius.
 */
function nodePath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  shape: NodeShape,
) {
  context.beginPath();
  if (shape === "circle") {
    context.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  const sides = shape === "square" ? 4 : shape === "triangle" ? 3 : shape === "diamond" ? 4 : 5;
  const rotation = shape === "triangle" ? -Math.PI / 2 : shape === "square" ? Math.PI / 4 : 0;
  const points = Array.from({ length: sides }, (_, index) => {
    const angle = rotation + (index / sides) * Math.PI * 2;
    return { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius };
  });
  const corner = Math.min(radius * 0.35, 2.2);
  const mix = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const t = Math.min(0.5, corner / length);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  };
  let first = mix(points[0]!, points[1]!);
  context.moveTo(first.x, first.y);
  for (let index = 1; index <= sides; index += 1) {
    const vertex = points[index % sides]!;
    const previous = points[(index - 1) % sides]!;
    const incoming = mix(vertex, previous);
    const outgoing = mix(vertex, points[(index + 1) % sides]!);
    context.lineTo(incoming.x, incoming.y);
    context.quadraticCurveTo(vertex.x, vertex.y, outgoing.x, outgoing.y);
    if (index === sides) first = outgoing;
  }
  // Wrap back to the first corner so the start edge is closed smoothly.
  const vertex = points[0]!;
  context.quadraticCurveTo(vertex.x, vertex.y, first.x, first.y);
  context.closePath();
}

/**
 * Labels repeat every frame. Rasterize the halo and glyphs once per role,
 * color and DPR; the frame loop then only draws the bitmap.
 */
function makeLabelBitmap(
  label: string,
  isHub: boolean,
  color: string,
  background: string,
  dpr: number,
  fontFamily: string,
): LabelBitmap {
  const fontSize = isHub ? 12 : 11;
  const font = `${isHub ? 500 : 400} ${fontSize}px ${fontFamily}`;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) {
    return { canvas: document.createElement("canvas"), width: 0, height: 0, textWidth: 0 };
  }
  measure.font = font;
  const textWidth = measure.measureText(label).width;
  const width = Math.ceil(textWidth + 8);
  const height = Math.ceil(fontSize + 8);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * dpr));
  canvas.height = Math.max(1, Math.ceil(height * dpr));
  const context = canvas.getContext("2d");
  if (context) {
    context.scale(dpr, dpr);
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    // Hub names are the map's frame, and leaves keep moving under them while
    // the force simulation settles. A halo is not enough to stay legible over
    // a circle, so hub labels get an opaque chip; leaf labels keep the halo so
    // they stay quiet.
    if (isHub) {
      context.fillStyle = background;
      context.beginPath();
      const radius = 3;
      const left = 0;
      const top = 0;
      const right = width;
      const bottom = height;
      context.moveTo(left + radius, top);
      context.lineTo(right - radius, top);
      context.quadraticCurveTo(right, top, right, top + radius);
      context.lineTo(right, bottom - radius);
      context.quadraticCurveTo(right, bottom, right - radius, bottom);
      context.lineTo(left + radius, bottom);
      context.quadraticCurveTo(left, bottom, left, bottom - radius);
      context.lineTo(left, top + radius);
      context.quadraticCurveTo(left, top, left + radius, top);
      context.closePath();
      context.fill();
    }
    context.font = font;
    context.textAlign = "center";
    context.textBaseline = "middle";
    if (!isHub) {
      context.lineWidth = 3;
      context.lineJoin = "round";
      context.strokeStyle = background;
      context.strokeText(label, width / 2, height / 2);
    }
    context.fillStyle = color;
    context.fillText(label, width / 2, height / 2);
  }
  return { canvas, width, height, textWidth };
}

const INTERACTIVE_TARGET = "button, a, input, select, textarea, [role='dialog']";

/** Pointer events over graph chrome must not become graph clicks. */
function isGraphSurface(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest(INTERACTIVE_TARGET));
}

interface GraphPalette {
  segment: string;
  pattern: string;
  pool: string;
  foreground: string;
  muted: string;
  background: string;
  edge: string;
  edgeDim: string;
  edgeSelected: string;
  /** Similarity is a measured affinity, so it stays quieter than an observation. */
  edgeSimilarity: string;
  edgeSimilarityDim: string;
  /** Resolved once with the colours so labels never re-read the stylesheet. */
  fontFamily: string;
}

const FALLBACK_PALETTE: GraphPalette = {
  segment: "#737373",
  pattern: "#7048e8",
  pool: "#a3a3a3",
  foreground: "#0a0a0a",
  muted: "#737373",
  background: "#ffffff",
  edge: "rgba(115, 115, 115, 0.30)",
  edgeDim: "rgba(115, 115, 115, 0.06)",
  edgeSelected: "rgba(115, 115, 115, 0.62)",
  edgeSimilarity: "rgba(115, 115, 115, 0.40)",
  edgeSimilarityDim: "rgba(115, 115, 115, 0.10)",
  fontFamily: LABEL_FONT_FAMILY,
};

let colorProbe: CanvasRenderingContext2D | null = null;

/** Canvas cannot read CSS custom properties, so resolve the theme tokens once. */
function resolveColor(color: string, alpha = 1): string {
  if (!color) return `rgba(120, 120, 120, ${alpha})`;
  colorProbe ??= document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  if (!colorProbe) return color;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = color;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${alpha * (a / 255)})`;
}

/** Blend two CSS colors in sRGB; used for the connection-count ramp. */
function mixColor(from: string, to: string, amount: number): string {
  colorProbe ??= document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  const channels = (color: string) => {
    if (!colorProbe) return [128, 128, 128, 255];
    colorProbe.clearRect(0, 0, 1, 1);
    colorProbe.fillStyle = color;
    colorProbe.fillRect(0, 0, 1, 1);
    return [...colorProbe.getImageData(0, 0, 1, 1).data];
  };
  const [r1, g1, b1, a1] = channels(from);
  const [r2, g2, b2, a2] = channels(to);
  const t = Math.min(1, Math.max(0, amount));
  const value = (start: number, end: number) => Math.round(start + (end - start) * t);
  return `rgba(${value(r1!, r2!)}, ${value(g1!, g2!)}, ${value(b1!, b2!)}, ${((a1! + (a2! - a1!) * t) / 255).toFixed(3)})`;
}

function readPalette(): GraphPalette {
  if (typeof document === "undefined") return FALLBACK_PALETTE;
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  // The engine ships its own defaults (`graph.css`); each token also accepts a
  // host app's name first, so an embedding shell can repaint the map without
  // forking the stylesheet.
  const surface =
    token("--graph-surface") ||
    token("--background-primary") ||
    token("--surface") ||
    FALLBACK_PALETTE.background;
  const fg =
    token("--graph-foreground") ||
    token("--text-normal") ||
    token("--fg") ||
    FALLBACK_PALETTE.foreground;
  const muted = token("--graph-text") || token("--fg-3") || FALLBACK_PALETTE.muted;
  const line = token("--graph-line") || token("--line-strong") || "#737373";
  return {
    segment: token("--graph-node") || muted,
    pattern: token("--graph-node-focused") || muted,
    pool: token("--graph-node-attachment") || muted,
    foreground: fg,
    muted,
    background: surface,
    edge: resolveColor(line, 0.3),
    edgeDim: resolveColor(line, 0.06),
    edgeSelected: resolveColor(line, 0.62),
    // Dashed similarity links read thinner than a solid observation, so their
    // alpha is raised slightly to keep both legible at the same zoom.
    edgeSimilarity: resolveColor(line, 0.4),
    edgeSimilarityDim: resolveColor(line, 0.1),
    fontFamily: token("--graph-font-sans") || LABEL_FONT_FAMILY,
  };
}

/** Similarity links are dashed so a measured proximity never reads as an observation. */
function isSimilarityLink(link: object): boolean {
  const relation = "relation" in link ? link.relation : null;
  return typeof relation === "string" && relation === "similarity";
}

function useReducedMotion() {
  // The first paint must already respect the preference; a false default would
  // animate one settle before the media query's effect runs.
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** The same forces settle the initial layout offscreen and relax node drags. */
function layoutForces() {
  return {
    charge: forceManyBody<NodePoint>().strength(-220).distanceMax(650),
    link: forceLink<NodePoint, LinkPoint>()
      .id((node) => node.id)
      // Similarity links join already-related nodes, so they sit closer than a
      // collected observation; everything else keeps the established spacing.
      .distance((link) => (isSimilarityLink(link) ? 80 : 90))
      .strength(0.3),
    collide: forceCollide<NodePoint>((node) => node.radius + 10).iterations(3),
    x: forceX<NodePoint>(0).strength(0.025),
    y: forceY<NodePoint>(0).strength(0.025),
    center: forceCenter<NodePoint>(0, 0),
  };
}

/**
 * Layout starts from a golden-angle spiral so nodes never share a spot, then a
 * finite simulation settles the graph. Observation and similarity edges both
 * shape it; nothing is positioned by hand.
 */
function makeGraphData(
  sourceNodes: GraphNode[],
  sourceLinks: GraphLink[],
  layoutVersion = 0,
  previous?: CanvasGraph,
): CanvasGraph {
  const oldNodes = new Map(previous?.nodes.map((node) => [node.id, node]));
  const oldLinks = new Map(previous?.links.map((link) => [link.id, link]));
  if (
    previous &&
    sourceNodes.length === previous.nodes.length &&
    sourceLinks.length === previous.links.length &&
    sourceNodes.every((node) => oldNodes.has(node.id)) &&
    sourceLinks.every((link) => {
      const old = oldLinks.get(link.id);
      return (
        old?.relation === link.relation &&
        endpointId(old.source) === link.source &&
        endpointId(old.target) === link.target
      );
    })
  ) {
    // Keep the graph object identity as well as coordinates, so a refresh that
    // only changes scores or labels does not restart the layout. Collision
    // padding reserves room for the bounded score-radius changes.
    for (const node of sourceNodes) Object.assign(oldNodes.get(node.id)!, node);
    for (const link of sourceLinks) oldLinks.get(link.id)!.similarity = link.similarity;
    return previous;
  }
  const graph: CanvasGraph = {
    nodes: sourceNodes.map((node, index) => {
      const old = oldNodes.get(node.id);
      const angle = index * 2.399963229728653 + layoutVersion * 0.41;
      const distance = 24 * Math.sqrt(index + 1);
      return {
        ...node,
        x: old?.x ?? Math.cos(angle) * distance,
        y: old?.y ?? Math.sin(angle) * distance,
        vx: 0,
        vy: 0,
      };
    }),
    links: sourceLinks.map((link) => ({ ...link })),
  };

  const forces = layoutForces();
  const simulation = forceSimulation<NodePoint>(graph.nodes)
    .force("charge", forces.charge)
    .force("link", forces.link)
    .force("collide", forces.collide)
    .force("x", forces.x)
    .force("y", forces.y)
    .force("center", forces.center)
    .stop();
  forces.link.links(graph.links);
  simulation.alphaDecay(0.035).velocityDecay(0.5).tick(300);
  simulation.stop();
  for (const node of graph.nodes) {
    node.vx = 0;
    node.vy = 0;
  }
  // d3 resolves endpoints to objects; the canvas owns its own link resolution.
  graph.links = sourceLinks.map((link) => ({ ...link }));
  return graph;
}

export type Theme = "light" | "dark";

export interface GraphCanvasProps {
  /**
   * Appearance the palette is resolved against. The canvas reads CSS custom
   * properties from `<html>`, so this value only forces a re-read after the
   * theme class flips; the tokens themselves stay in the caller's stylesheet.
   */
  theme: Theme;
  nodes: GraphNode[];
  links: GraphLink[];
  selectedId: string | null;
  activeIds: Set<string>;
  emphasisIds: Set<string>;
  showContextLabels: boolean;
  /**
   * Keep hub labels visible at every zoom level. The map's hubs are viewer
   * segments, and an unlabeled anchor makes the map unreadable.
   */
  labelHubsAlways?: boolean;
  /**
   * Re-frame the camera onto the selection. Correct when the graph is a
   * neighborhood to explore; wrong for a map whose node size encodes a score,
   * because zooming into one node destroys the comparison the view exists for.
   */
  autoFitSelection?: boolean;
  /**
   * Height in CSS pixels that an overlay covers at the bottom of the canvas.
   * Selection framing centres the focused neighbourhood in the remaining
   * space, so a mobile inspector sheet never hides the node it describes.
   */
  selectionBottomInset?: number;
  onSelect: (id: string | null) => void;
}

/**
 * Graph canvas: native canvas rendering, d3-force layout, camera pan/zoom,
 * node dragging and selection. The canvas is visual; a caller's own list is
 * the keyboard and screen-reader path through the same nodes.
 */
export function GraphCanvas({
  theme,
  nodes,
  links,
  selectedId,
  activeIds,
  emphasisIds,
  showContextLabels,
  labelHubsAlways = false,
  autoFitSelection = true,
  selectionBottomInset = 0,
  onSelect,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The camera is owned by refs because gestures update it every frame. */
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const paintRef = useRef<() => void>(() => {});
  const drawFrame = useRef(0);
  const simulationRef = useRef<Simulation<NodePoint, LinkPoint> | null>(null);
  const relaxation = useRef<number | null>(null);
  /** Live pointers, so a second touch can become a pinch instead of a pan. */
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{
    distance: number;
    k: number;
    graphX: number;
    graphY: number;
  } | null>(null);
  const labelHitAreas = useRef<LabelHitArea[]>([]);
  const labelCache = useRef(new Map<string, LabelBitmap>());
  const labelCacheDpr = useRef(0);
  const pointerStart = useRef<{
    x: number;
    y: number;
    hitId: string | null;
    pointerType: string;
  } | null>(null);
  const dragNode = useRef<{
    node: NodePoint;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    active: boolean;
  } | null>(null);
  const wheelZoom = useRef<{
    target: number;
    anchor: { screenX: number; screenY: number; graphX: number; graphY: number };
    raf: number;
    lastFrame: number;
  } | null>(null);
  const panGesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    time: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null>(null);
  const panMomentum = useRef<{
    raf: number;
    time: number;
    vx: number;
    vy: number;
  } | null>(null);
  const cameraAnimation = useRef<{
    raf: number;
    start: number;
    fromX: number;
    fromY: number;
    fromScale: number;
    toX: number;
    toY: number;
    toScale: number;
    duration: number;
  } | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const hoveredIdRef = useRef<string | null>(null);
  const cursorRef = useRef("");
  /** A fresh layout frames itself once its relaxation ends; drags leave the camera alone. */
  const shouldFit = useRef(true);
  const reducedMotion = useReducedMotion();
  /** Media changes must not rebuild a settled simulation. */
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [palette, setPalette] = useState(readPalette);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [fontReady, setFontReady] = useState(false);
  const previousLayout = useRef<{ version: number; data: CanvasGraph } | null>(null);
  const graphData = useMemo(() => {
    const previous = previousLayout.current;
    const data = makeGraphData(
      nodes,
      links,
      layoutVersion,
      previous?.version === layoutVersion ? previous.data : undefined,
    );
    previousLayout.current = { version: layoutVersion, data };
    return data;
  }, [nodes, links, layoutVersion]);
  const nodeIndex = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node])),
    [graphData.nodes],
  );
  const parentHubs = useMemo(() => {
    const parents = new Map<string, string[]>();
    for (const link of graphData.links) {
      // Similarity edges join peers, not a hub to its leaves; label placement
      // only follows observation edges. Endpoints may already be resolved to
      // node objects by the simulation, so compare ids.
      if (link.relation === "similarity") continue;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const list = parents.get(target) ?? [];
      list.push(source);
      parents.set(target, list);
    }
    return parents;
  }, [graphData.links]);

  useEffect(() => {
    shouldFit.current = true;
  }, [layoutVersion]);

  const requestPaint = useCallback(() => {
    if (drawFrame.current) return;
    drawFrame.current = window.requestAnimationFrame(() => {
      drawFrame.current = 0;
      paintRef.current();
    });
  }, []);

  const stopWheelZoom = useCallback(() => {
    const state = wheelZoom.current;
    if (state?.raf) window.cancelAnimationFrame(state.raf);
    wheelZoom.current = null;
  }, []);

  const stopCameraAnimation = useCallback(() => {
    const animation = cameraAnimation.current;
    if (animation?.raf) window.cancelAnimationFrame(animation.raf);
    cameraAnimation.current = null;
    const momentum = panMomentum.current;
    if (momentum) window.cancelAnimationFrame(momentum.raf);
    panMomentum.current = null;
    panGesture.current = null;
  }, []);

  const animateCameraTo = useCallback(
    (x: number, y: number, scale: number, duration = 600) => {
      stopWheelZoom();
      stopCameraAnimation();
      if (duration <= 0) {
        cameraRef.current = { x, y, k: clampZoom(scale) };
        requestPaint();
        return;
      }
      const camera = cameraRef.current;
      const animation = {
        raf: 0,
        start: performance.now(),
        fromX: camera.x,
        fromY: camera.y,
        fromScale: camera.k,
        toX: x,
        toY: y,
        toScale: clampZoom(scale),
        duration,
      };
      cameraAnimation.current = animation;

      const tick = (now: number) => {
        if (cameraAnimation.current !== animation) return;
        const progress = Math.min(1, (now - animation.start) / Math.max(1, animation.duration));
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        cameraRef.current = {
          k: animation.fromScale + (animation.toScale - animation.fromScale) * eased,
          x: animation.fromX + (animation.toX - animation.fromX) * eased,
          y: animation.fromY + (animation.toY - animation.fromY) * eased,
        };
        paintRef.current();
        if (progress < 1) {
          animation.raf = window.requestAnimationFrame(tick);
        } else {
          cameraAnimation.current = null;
        }
      };
      animation.raf = window.requestAnimationFrame(tick);
    },
    [requestPaint, stopCameraAnimation, stopWheelZoom],
  );

  useEffect(
    () => () => {
      stopCameraAnimation();
      stopWheelZoom();
      if (drawFrame.current) window.cancelAnimationFrame(drawFrame.current);
      drawFrame.current = 0;
      const frame = relaxation.current;
      if (frame !== null) window.cancelAnimationFrame(frame);
      relaxation.current = null;
    },
    [stopCameraAnimation, stopWheelZoom],
  );

  useEffect(() => {
    /** Track the pointer, not graph coordinates, so glide feels the same at every zoom. */
    function trackPan(event: PointerEvent) {
      const gesture = panGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId || pinch.current) return;
      const elapsed = event.timeStamp - gesture.time;
      if (elapsed <= 0) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      const blend = 1 - Math.exp(-elapsed / 30);
      gesture.vx += (dx / elapsed - gesture.vx) * blend;
      gesture.vy += (dy / elapsed - gesture.vy) * blend;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      gesture.time = event.timeStamp;
      gesture.moved ||= Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) > 10;
      if (dx || dy) {
        const camera = cameraRef.current;
        cameraRef.current = {
          ...camera,
          x: camera.x - dx / camera.k,
          y: camera.y - dy / camera.k,
        };
        requestPaint();
      }
    }

    /** Release velocity decays exponentially; a held, cancelled or tiny drag never flings. */
    function releasePan(event: PointerEvent) {
      // Gesture bookkeeping belongs to the React pointer handlers, which run
      // after this capture listener; momentum only reads the velocity here.
      const gesture = panGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      panGesture.current = null;
      if (reducedMotion || !gesture.moved || event.timeStamp - gesture.time > 80) return;
      if (pinch.current) return;
      const speed = Math.hypot(gesture.vx, gesture.vy);
      if (speed < 0.05) return;
      const limit = Math.min(1, 2.5 / speed);
      const momentum = {
        raf: 0,
        time: performance.now(),
        vx: gesture.vx * limit,
        vy: gesture.vy * limit,
      };
      panMomentum.current = momentum;
      const tick = (now: number) => {
        if (panMomentum.current !== momentum) return;
        const elapsed = Math.max(0, now - momentum.time);
        momentum.time = now;
        // 280ms time constant: frame-rate-independent friction, no spring or rebound.
        const decay = Math.exp(-elapsed / 280);
        const camera = cameraRef.current;
        const travel = 280 * (1 - decay);
        cameraRef.current = {
          ...camera,
          x: camera.x - (momentum.vx * travel) / camera.k,
          y: camera.y - (momentum.vy * travel) / camera.k,
        };
        paintRef.current();
        momentum.vx *= decay;
        momentum.vy *= decay;
        if (Math.hypot(momentum.vx, momentum.vy) < 0.02) {
          panMomentum.current = null;
          return;
        }
        momentum.raf = window.requestAnimationFrame(tick);
      };
      momentum.raf = window.requestAnimationFrame(tick);
    }

    const stopWhenHidden = () => {
      if (document.hidden) stopCameraAnimation();
    };
    // Capture keeps release velocity accurate outside the canvas. Any new press
    // (including a second touch), zoom/control action, blur or cancellation stops glide.
    window.addEventListener("pointerdown", stopCameraAnimation, true);
    window.addEventListener("pointermove", trackPan, true);
    window.addEventListener("pointerup", releasePan, true);
    window.addEventListener("pointercancel", stopCameraAnimation, true);
    window.addEventListener("blur", stopCameraAnimation);
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      window.removeEventListener("pointerdown", stopCameraAnimation, true);
      window.removeEventListener("pointermove", trackPan, true);
      window.removeEventListener("pointerup", releasePan, true);
      window.removeEventListener("pointercancel", stopCameraAnimation, true);
      window.removeEventListener("blur", stopCameraAnimation);
      document.removeEventListener("visibilitychange", stopWhenHidden);
      stopCameraAnimation();
    };
  }, [reducedMotion, stopCameraAnimation]);

  const getLabelBitmap = useCallback(
    (
      label: string,
      isHub: boolean,
      color: string,
      background: string,
      dpr: number,
      fontFamily: string,
    ) => {
      const key = `${isHub ? 1 : 0}|${dpr}|${color}|${background}|${fontFamily}|${label}`;
      const cached = labelCache.current.get(key);
      if (cached) return cached;
      const bitmap = makeLabelBitmap(label, isHub, color, background, dpr, fontFamily);
      labelCache.current.set(key, bitmap);
      return bitmap;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void document.fonts?.ready
      .then(() => {
        if (!active) return;
        // Font metrics and glyphs changed; rebuild every bitmap once.
        labelCache.current.clear();
        setFontReady(true);
      })
      .catch(() => {
        if (active) setFontReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPalette(readPalette()));
    return () => window.cancelAnimationFrame(frame);
  }, [theme]);

  useEffect(() => {
    labelCache.current.clear();
  }, [palette]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const container = element;

    // A wheel gesture can contain dozens of events. Accumulate one target and
    // drive a single camera loop; restarting a tween per event makes them
    // fight each other and reads as stutter.
    function tick(time: number) {
      const state = wheelZoom.current;
      if (!state) return;
      const camera = cameraRef.current;
      const dt = state.lastFrame ? Math.min(50, Math.max(1, time - state.lastFrame)) : 16;
      state.lastFrame = time;
      const ease = 1 - Math.exp(-dt / 55);
      const next =
        Math.abs(state.target - camera.k) < 0.0004
          ? state.target
          : camera.k + (state.target - camera.k) * ease;

      const { width, height } = sizeRef.current;
      const centerX = state.anchor.graphX - (state.anchor.screenX - width / 2) / next;
      const centerY = state.anchor.graphY - (state.anchor.screenY - height / 2) / next;
      cameraRef.current = { x: centerX, y: centerY, k: next };
      paintRef.current();

      if (Math.abs(state.target - next) < 0.0007) {
        state.raf = 0;
        wheelZoom.current = null;
        return;
      }
      state.raf = window.requestAnimationFrame(tick);
    }

    function onWheel(event: WheelEvent) {
      if (!isGraphSurface(event.target)) return;
      event.preventDefault();
      stopCameraAnimation();

      const rect = container.getBoundingClientRect();
      const { width, height } = sizeRef.current;
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const delta =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * 400
            : event.deltaY;
      // One wheel notch (about 100px) moves roughly 1.6x; the accumulated
      // target below is eased into, so the larger step never snaps.
      const factor = Math.exp(-delta * 0.0045);
      if (!Number.isFinite(factor) || factor === 1) return;

      let state = wheelZoom.current;
      if (!state) {
        const camera = cameraRef.current;
        const anchor = screenToGraph(camera, width, height, screenX, screenY);
        state = {
          target: camera.k,
          anchor: {
            screenX,
            screenY,
            graphX: anchor.x,
            graphY: anchor.y,
          },
          raf: 0,
          lastFrame: 0,
        };
        wheelZoom.current = state;
      } else if (Math.hypot(screenX - state.anchor.screenX, screenY - state.anchor.screenY) > 8) {
        const anchor = screenToGraph(cameraRef.current, width, height, screenX, screenY);
        state.anchor = {
          screenX,
          screenY,
          graphX: anchor.x,
          graphY: anchor.y,
        };
      }

      state.target = clampZoom(state.target * factor);
      if (!state.raf) state.raf = window.requestAnimationFrame(tick);
    }

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      const state = wheelZoom.current;
      if (state?.raf) window.cancelAnimationFrame(state.raf);
      wheelZoom.current = null;
    };
  }, [stopCameraAnimation]);

  const compact = size.width < 700 || size.height < 560;
  const nodesRef = useRef(graphData.nodes);
  useEffect(() => {
    nodesRef.current = graphData.nodes;
    sizeRef.current = size;
  }, [graphData.nodes, size]);

  /**
   * Frame every node with the same padding the previous engine used. Reads
   * live positions and viewport through refs, so resizing or a data refresh
   * never restarts the layout just because this callback changed identity.
   */
  const fitAll = useCallback(
    (duration: number) => {
      const { width: viewWidth, height: viewHeight } = sizeRef.current;
      const nodes = nodesRef.current;
      if (!viewWidth || !viewHeight || !nodes.length) return;
      const padding = viewWidth < 700 || viewHeight < 560 ? 44 : 92;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const node of nodes) {
        if (typeof node.x !== "number" || typeof node.y !== "number") continue;
        const radius = node.radius ?? 4;
        minX = Math.min(minX, node.x - radius);
        minY = Math.min(minY, node.y - radius);
        maxX = Math.max(maxX, node.x + radius);
        maxY = Math.max(maxY, node.y + radius);
      }
      if (!Number.isFinite(minX)) return;
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const k = clampZoom(
        Math.min(
          Math.max(1e-12, (viewWidth - padding * 2) / width),
          Math.max(1e-12, (viewHeight - padding * 2) / height),
        ),
      );
      animateCameraTo((minX + maxX) / 2, (minY + maxY) / 2, k, duration);
    },
    [animateCameraTo],
  );

  // Resize the camera, not the simulation, when the sidebar, inspector or
  // viewport changes. A desktop zoom carried onto a phone crops most nodes.
  useEffect(() => {
    if (size.width > 0 && size.height > 0) fitAll(0);
  }, [fitAll, size.width, size.height]);

  /**
   * Ease the camera to a box containing the selected node and its direct
   * relationships. `selectionBottomInset` is subtracted from the usable
   * viewport so a caller's overlay never covers the framed group.
   */
  const fitSelectionCamera = useCallback(
    (duration: number) => {
      if (!selectedId || !size.width || !size.height) return;
      const byId = new Map(graphData.nodes.map((node) => [node.id, node]));
      const selected = byId.get(selectedId);
      if (!selected) return;

      const focus = [selected];
      const seen = new Set([selected.id]);
      for (const connection of connectionsFor(selectedId, graphData)) {
        const node = byId.get(connection.node.id);
        if (node && !seen.has(node.id)) {
          seen.add(node.id);
          focus.push(node);
        }
      }

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const node of focus) {
        if (typeof node.x !== "number" || typeof node.y !== "number") continue;
        const radius = (node.radius ?? 5) + 8;
        minX = Math.min(minX, node.x - radius);
        minY = Math.min(minY, node.y - radius);
        maxX = Math.max(maxX, node.x + radius);
        maxY = Math.max(maxY, node.y + radius);
      }
      if (!Number.isFinite(minX)) return;

      // Never let the inset consume the whole viewport; the camera still has
      // to show the group it was asked to frame.
      const bottomInset = Math.min(Math.max(0, selectionBottomInset), size.height * 0.6);
      const padding = compact ? 42 : 92;
      const availableWidth = Math.max(1, size.width - padding * 2);
      const availableHeight = Math.max(1, size.height - bottomInset - padding * 2);
      const bboxWidth = Math.max(1, maxX - minX);
      const bboxHeight = Math.max(1, maxY - minY);
      // "Just enough": a single node and its neighbours would otherwise fill
      // the viewport at the maximum zoom, losing the surrounding context.
      const scale = Math.min(
        2.2,
        clampZoom(Math.min(availableWidth / bboxWidth, availableHeight / bboxHeight)),
      );
      const targetX = (minX + maxX) / 2;
      const targetScreenY = (size.height - bottomInset) / 2;
      const targetY = (minY + maxY) / 2 + (size.height / 2 - targetScreenY) / scale;
      animateCameraTo(targetX, targetY, scale, duration);
    },
    [
      animateCameraTo,
      compact,
      graphData,
      selectedId,
      selectionBottomInset,
      size.height,
      size.width,
    ],
  );

  useEffect(() => {
    if (!selectedId || !autoFitSelection) return;
    fitSelectionCamera(620);
  }, [autoFitSelection, fitSelectionCamera, selectedId]);

  /**
   * The layout ticks only while it is asked to: a rebuild relaxes for at most
   * two seconds, and a node drag keeps it warm until the node is released.
   * No animation frame survives a settled graph.
   */
  const runRelaxation = useCallback((mode: "settle" | "drag") => {
    const simulation = simulationRef.current;
    if (!simulation) return;
    const previous = relaxation.current;
    if (previous !== null) window.cancelAnimationFrame(previous);
    const startedAt = performance.now();
    let ticks = 0;
    const step = (now: number) => {
      relaxation.current = null;
      if (simulationRef.current !== simulation) return;
      if (mode === "drag" && !dragNode.current?.active) {
        // The drag ended between frames; settle handles the rest.
        return;
      }
      simulation.tick();
      ticks += 1;
      paintRef.current();
      if (
        mode === "settle" &&
        (ticks >= MAX_RELAX_TICKS ||
          now - startedAt >= MAX_RELAX_MS ||
          simulation.alpha() < simulation.alphaMin())
      ) {
        // The layout is at rest; nothing more is scheduled.
        if (shouldFit.current) {
          shouldFit.current = false;
          fitAll(0);
        }
        return;
      }
      relaxation.current = window.requestAnimationFrame(step);
    };
    relaxation.current = window.requestAnimationFrame(step);
  }, []);

  const stopRelaxation = useCallback(() => {
    const frame = relaxation.current;
    if (frame !== null) window.cancelAnimationFrame(frame);
    relaxation.current = null;
  }, []);

  const mountedGraph = size.width > 0;
  useEffect(() => {
    if (!mountedGraph) return;
    const simulation = forceSimulation<NodePoint, LinkPoint>(graphData.nodes)
      .alphaDecay(0.035)
      .velocityDecay(0.5)
      .stop();
    const forces = layoutForces();
    simulation
      .force("charge", forces.charge)
      .force("link", forces.link)
      .force("collide", forces.collide)
      .force("x", forces.x)
      .force("y", forces.y)
      .force("center", forces.center);
    // Resolving endpoints through the link force keeps the nodes' own ids in
    // place, which the hit tests and label placement rely on.
    forces.link.links(graphData.links);
    simulationRef.current = simulation;
    if (reducedMotionRef.current) {
      // Reduced motion keeps the pre-settled layout untouched.
      if (shouldFit.current) {
        shouldFit.current = false;
        fitAll(0);
      }
      requestPaint();
    } else {
      // Frame the pre-settled spiral immediately so the first paint is not a
      // cropped close-up; the settled layout is framed again when it comes to
      // rest. A data refresh leaves the user's camera alone.
      if (shouldFit.current) fitAll(0);
      simulation.alpha(1);
      runRelaxation("settle");
    }
    return () => {
      stopRelaxation();
      simulation.stop();
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [fitAll, graphData, mountedGraph, runRelaxation, stopRelaxation]);

  const reheat = useCallback(() => {
    const simulation = simulationRef.current;
    if (!simulation || reducedMotionRef.current) return;
    simulation.alphaTarget(0).alpha(1);
    runRelaxation("settle");
  }, [runRelaxation]);

  const updateHovered = useCallback((id: string | null) => {
    if (hoveredIdRef.current === id) return;
    hoveredIdRef.current = id;
    setHoveredId(id);
  }, []);

  const setGraphCursor = useCallback((cursor: string) => {
    if (cursorRef.current === cursor) return;
    cursorRef.current = cursor;
    if (canvasRef.current) canvasRef.current.style.cursor = cursor;
  }, []);

  /**
   * Resolve the current node under a pointer from the last painted labels and
   * live node positions. Labels win because they are the larger, labelled
   * target users naturally aim at.
   */
  const findHitAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      // Paint measures in rounded CSS pixels, so hit testing must use the same
      // viewport instead of the fractional layout box.
      const { width, height } = sizeRef.current;

      for (const area of labelHitAreas.current) {
        if (x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) {
          return area.id;
        }
      }

      const camera = cameraRef.current;
      let closest: string | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const node of graphData.nodes) {
        if (typeof node.x !== "number" || typeof node.y !== "number") continue;
        const point = graphToScreen(camera, width, height, node.x, node.y);
        const radius = (node.radius ?? 5) * camera.k + (node.hub ? 14 : 11);
        const distance = Math.hypot(x - point.x, y - point.y);
        if (distance <= radius && distance < closestDistance) {
          closest = node.id;
          closestDistance = distance;
        }
      }
      return closest;
    },
    [graphData],
  );

  const toGraphPoint = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    return screenToGraph(cameraRef.current, width, height, clientX - rect.left, clientY - rect.top);
  }, []);

  const finishNodeDrag = useCallback(() => {
    const drag = dragNode.current;
    if (!drag) return false;
    dragNode.current = null;
    if (!drag.active) return false;
    const { node } = drag;
    // Let the force layout reclaim the node; it should drift back rather than
    // sticking to the drop point.
    node.fx = undefined;
    node.fy = undefined;
    // The drag held the layout warm; release it back to its resting target.
    const simulation = simulationRef.current;
    if (simulation) simulation.alphaTarget(0);
    reheat();
    return true;
  }, [reheat]);

  /** Interrupt camera motion whenever a direct gesture starts. */
  function beginPointer(event: ReactPointerEvent<HTMLDivElement>) {
    stopWheelZoom();
    stopCameraAnimation();
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; the handlers still receive moves.
    }
  }

  /**
   * Two touches become a pinch around their midpoint. The first finger's press
   * already armed a pan; the pinch takes over and cancels it.
   */
  function beginPinch() {
    const [first, second] = [...activePointers.current.values()];
    if (!first || !second) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    const midpointX = (first.x + second.x) / 2 - rect.left;
    const midpointY = (first.y + second.y) / 2 - rect.top;
    const camera = cameraRef.current;
    const anchor = screenToGraph(camera, width, height, midpointX, midpointY);
    pinch.current = {
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      k: camera.k,
      graphX: anchor.x,
      graphY: anchor.y,
    };
    panGesture.current = null;
    pointerStart.current = null;
    // A pen drag already fixed a node; release that fix before the pinch owns
    // the gesture or the node would stay pinned.
    finishNodeDrag();
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !isGraphSurface(event.target)) {
      pointerStart.current = null;
      return;
    }
    beginPointer(event);
    if (activePointers.current.size > 1) {
      beginPinch();
      return;
    }
    const hitId = findHitAt(event.clientX, event.clientY);
    pointerStart.current = {
      x: event.clientX,
      y: event.clientY,
      hitId,
      pointerType: event.pointerType,
    };
    // Reduced motion still pans; only its release glide is suppressed.
    if (event.isPrimary && (!hitId || event.pointerType === "touch")) {
      panGesture.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        time: event.timeStamp,
        vx: 0,
        vy: 0,
        moved: false,
      };
    }

    // Mouse/pen node drags are handled directly against live screen geometry.
    // Touch keeps two-finger work for the pinch and single-finger pan.
    if (event.pointerType !== "touch" && hitId) {
      const node = graphData.nodes.find((candidate) => candidate.id === hitId);
      const point = toGraphPoint(event.clientX, event.clientY);
      if (node && point && typeof node.x === "number" && typeof node.y === "number") {
        dragNode.current = {
          node,
          pointerId: event.pointerId,
          offsetX: node.x - point.x,
          offsetY: node.y - point.y,
          active: false,
        };
      }
    }
    setGraphCursor("grabbing");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const tracked = activePointers.current.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }
    if (!isGraphSurface(event.target)) {
      updateHovered(null);
      setGraphCursor("");
      return;
    }
    const container = containerRef.current;
    const pinchState = pinch.current;
    if (pinchState && container && activePointers.current.size > 1) {
      const [first, second] = [...activePointers.current.values()];
      if (first && second) {
        const rect = container.getBoundingClientRect();
        const { width, height } = sizeRef.current;
        const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
        const k = clampZoom((pinchState.k * distance) / pinchState.distance);
        const midpointX = (first.x + second.x) / 2 - rect.left;
        const midpointY = (first.y + second.y) / 2 - rect.top;
        // Keep the graph point that was between the fingers between them.
        cameraRef.current = {
          k,
          x: pinchState.graphX - (midpointX - width / 2) / k,
          y: pinchState.graphY - (midpointY - height / 2) / k,
        };
        requestPaint();
      }
      return;
    }
    const start = pointerStart.current;
    if (!start && panGesture.current) {
      // A pinch released one finger; that finger is panning, not hovering.
      updateHovered(null);
      setGraphCursor("grabbing");
      return;
    }
    const threshold = event.pointerType === "touch" ? 10 : 5;
    if (start) {
      // A background press is already a camera pan; skip hit testing until it
      // ends. Only node/label drags need pointer-follow work.
      if (!start.hitId) {
        updateHovered(null);
        setGraphCursor("grabbing");
        return;
      }
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > threshold;
      if (moved) {
        const drag = dragNode.current;
        if (drag && drag.pointerId === event.pointerId) {
          const point = toGraphPoint(event.clientX, event.clientY);
          if (point) {
            if (!drag.active) {
              drag.active = true;
              if (!reducedMotionRef.current) {
                const simulation = simulationRef.current;
                if (simulation) simulation.alphaTarget(0.3);
                runRelaxation("drag");
              }
            }
            drag.node.x = point.x + drag.offsetX;
            drag.node.y = point.y + drag.offsetY;
            drag.node.fx = drag.node.x;
            drag.node.fy = drag.node.y;
            requestPaint();
          }
          updateHovered(null);
          setGraphCursor("grabbing");
          return;
        }
        // A camera pan owns the gesture. Resolving nodes on every move would
        // churn labels and React state under the pointer.
        updateHovered(null);
        setGraphCursor("grabbing");
        return;
      }
    }
    const hitId = findHitAt(event.clientX, event.clientY);
    updateHovered(hitId);
    setGraphCursor(hitId ? "pointer" : "grab");
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    activePointers.current.delete(event.pointerId);
    if (pinch.current && activePointers.current.size < 2) {
      // A finger left the pinch. The remaining touch becomes a fresh pan; the
      // last finger leaving ends the gesture without selecting.
      pinch.current = null;
      pointerStart.current = null;
      const remaining = [...activePointers.current.entries()].at(0);
      if (remaining && !reducedMotionRef.current) {
        const [remainingId, position] = remaining;
        panGesture.current = {
          pointerId: remainingId,
          x: position.x,
          y: position.y,
          startX: position.x,
          startY: position.y,
          time: event.timeStamp,
          vx: 0,
          vy: 0,
          moved: false,
        };
      }
    }
    const start = pointerStart.current;
    pointerStart.current = null;
    const dragged = finishNodeDrag();
    if (dragged) {
      const hitId = findHitAt(event.clientX, event.clientY);
      updateHovered(hitId);
      setGraphCursor(hitId ? "pointer" : "grab");
      return;
    }
    if (!start) return;
    if (!isGraphSurface(event.target)) {
      setGraphCursor("");
      return;
    }
    const threshold = start.pointerType === "touch" ? 10 : 5;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved > threshold) {
      const hitId = findHitAt(event.clientX, event.clientY);
      updateHovered(hitId);
      setGraphCursor(hitId ? "pointer" : "grab");
      return;
    }
    onSelect(start.hitId);
    updateHovered(start.hitId);
    setGraphCursor(start.hitId ? "pointer" : "grab");
  }

  function handlePointerLeave() {
    updateHovered(null);
    setGraphCursor("");
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    activePointers.current.delete(event.pointerId);
    pinch.current = null;
    finishNodeDrag();
    pointerStart.current = null;
    setGraphCursor("");
  }

  useEffect(() => {
    function releaseOutside(event: PointerEvent) {
      // Pointer capture routes canvas releases through the React handlers. This
      // is the fallback for browsers that drop capture, and for gestures that
      // ended outside the graph.
      activePointers.current.delete(event.pointerId);
      if (activePointers.current.size < 2) pinch.current = null;
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) return;
      pointerStart.current = null;
      finishNodeDrag();
      updateHovered(null);
      setGraphCursor("");
    }
    window.addEventListener("pointerup", releaseOutside);
    window.addEventListener("pointercancel", releaseOutside);
    return () => {
      window.removeEventListener("pointerup", releaseOutside);
      window.removeEventListener("pointercancel", releaseOutside);
    };
  }, [finishNodeDrag, setGraphCursor, updateHovered]);

  /**
   * Connection count drives hue: leaves stay near the surface, and the more
   * links a node has the deeper the accent. The caller already owns radius, so
   * colour never repeats size.
   */
  const nodeColor = useCallback(
    (node: NodePoint) => {
      if (node.hub) return node.kind === "pool" ? palette.pool : palette.segment;
      // A single link stays almost white; the ramp saturates as links gather.
      const weight = Math.min(1, Math.max(0, (node.degree - 1) / 4));
      return mixColor(palette.background, palette.pattern, 0.12 + weight * 0.88);
    },
    [palette],
  );

  const paintNode = useCallback(
    (ctx: CanvasRenderingContext2D, node: NodePoint) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const selected = node.id === selectedId;
      const hovered = node.id === hoveredId;
      const active = activeIds.has(node.id);
      const emphasis = emphasisIds.has(node.id);
      const dim = !active;
      const radius = node.radius + (hovered ? 0.8 : 0);
      const shape = shapeFor(node.media);
      const fill = selected || hovered ? palette.pattern : nodeColor(node);

      ctx.save();
      ctx.globalAlpha = dim ? 0.16 : 1;

      // A selected or hovered node gets a soft halo; everything else stays flat
      // so the map's colour encoding is never mistaken for emphasis.
      if (selected || hovered) {
        nodePath(ctx, x, y, radius + 8, shape);
        ctx.fillStyle = palette.pattern;
        ctx.globalAlpha = dim ? 0.06 : 0.16;
        ctx.fill();
        ctx.globalAlpha = dim ? 0.16 : 1;
      }

      nodePath(ctx, x, y, radius, shape);
      // A pattern's fill is the ramp itself; a hub keeps its kind colour so the
      // map's anchors never read as a claim.
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = palette.background;
      ctx.stroke();

      if (selected || hovered) {
        nodePath(ctx, x, y, radius + 4, shape);
        ctx.lineWidth = 1;
        ctx.strokeStyle = selected ? palette.foreground : palette.muted;
        ctx.stroke();
      } else if (emphasis) {
        nodePath(ctx, x, y, radius + 3.5, shape);
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = palette.pattern;
        ctx.stroke();
      }

      ctx.restore();
    },
    [activeIds, emphasisIds, hoveredId, nodeColor, palette, selectedId],
  );

  /**
   * Labels paint over the graph in screen space, so their size stays stable
   * while the graph zooms. Colliding labels are skipped except for the active
   * selection.
   */
  const drawLabels = useCallback(
    (context: CanvasRenderingContext2D, camera: Camera, dpr: number) => {
      if (!size.width || !size.height) {
        labelHitAreas.current = [];
        return;
      }
      if (labelCacheDpr.current !== dpr) {
        labelCache.current.clear();
        labelCacheDpr.current = dpr;
      }
      context.save();
      // Labels are positioned in screen space, so draw them with the plain
      // CSS-pixel transform the canvas starts with.
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.globalAlpha = 1;

      const zoom = camera.k;
      // Labels describe detail, so they belong to closer zoom levels. Anchors
      // stay named through the default overview (fit ≈ 0.8) and fade only when
      // the whole map shrinks further; leaves need a closer view to appear.
      const leafFade = smoothstep(0.95, 1.25, zoom);
      const hubFade = smoothstep(0.45, 0.7, zoom);
      const positions = new Map<string, { x: number; y: number }>();
      for (const node of graphData.nodes) {
        if (typeof node.x !== "number" || typeof node.y !== "number") continue;
        positions.set(node.id, graphToScreen(camera, size.width, size.height, node.x, node.y));
      }
      const placed: { left: number; top: number; right: number; bottom: number }[] = [];
      const hitAreas: LabelHitArea[] = [];
      const labels = graphData.nodes
        .filter((node) => {
          if (!activeIds.has(node.id) && node.id !== hoveredId) return false;
          if (node.id === selectedId || node.id === hoveredId || showContextLabels) return true;
          if (labelHubsAlways && node.hub) return true;
          return node.hub ? hubFade > 0.01 : leafFade > 0.01;
        })
        .toSorted((a, b) => {
          // Hub labels are drawn last so pattern circles cannot paint over the
          // anchor names; without this a dense cluster hides "Discover".
          const priority = (node: NodePoint) =>
            node.id === selectedId || node.id === hoveredId
              ? 3
              : node.hub
                ? 1.5
                : node.degree > 2
                  ? 2
                  : 1;
          return priority(b) - priority(a);
        });

      for (const node of labels) {
        const point = positions.get(node.id);
        if (!point) continue;
        const isHub = node.hub === true;
        const selected = node.id === selectedId;
        const hovered = node.id === hoveredId;
        const fade =
          selected || hovered || showContextLabels || (labelHubsAlways && isHub)
            ? 1
            : isHub
              ? hubFade
              : leafFade;
        if (fade < 0.02) continue;
        const fontSize = isHub ? 12 : 11;
        const labelColor = selected || hovered ? palette.foreground : palette.muted;
        const bitmap = getLabelBitmap(
          node.label,
          isHub,
          labelColor,
          palette.background,
          dpr,
          palette.fontFamily,
        );
        const textWidth = bitmap.textWidth;
        let labelX = point.x;
        // Hubs carry the map's frame and are flanked by their own leaves, so
        // their names sit further out than a leaf label would.
        let labelY = point.y + node.radius * zoom + (isHub ? 22 : 12);

        if (!isHub) {
          const parents = (parentHubs.get(node.id) ?? [])
            .map((id) => positions.get(id))
            .filter((parent): parent is { x: number; y: number } => Boolean(parent));
          let directionX = 1;
          let directionY = 0;
          if (parents.length) {
            const centerX = parents.reduce((sum, parent) => sum + parent.x, 0) / parents.length;
            const centerY = parents.reduce((sum, parent) => sum + parent.y, 0) / parents.length;
            const dx = point.x - centerX;
            const dy = point.y - centerY;
            const length = Math.hypot(dx, dy);
            if (length > 1) {
              directionX = dx / length;
              directionY = dy / length;
            }
          }
          // Wide labels are centered beneath the node instead of pushed out
          // radially: a long sentence offset by half its own width otherwise
          // reads as detached from the circle it describes.
          if (textWidth > 96) {
            labelX = point.x;
            labelY = point.y + node.radius * zoom + 12;
          } else {
            const distance = node.radius * zoom + 7 + textWidth / 2;
            labelX = point.x + directionX * distance;
            labelY = point.y + directionY * distance;
          }
        }

        // Hub names are the map's frame and sit beside their circle; a narrow
        // inset let "News" and "Game dev" run into each other when hubs were
        // close. Hub labels get a wider margin so they stay legible.
        const inset = textWidth / 2 + (isHub ? 26 : 12);
        const minX = inset;
        const maxX = size.width - inset;
        const maxY = size.height - (size.width < 640 ? 10 : 58);
        if (minX > maxX) continue;
        labelX = Math.min(Math.max(labelX, minX), maxX);
        labelY = Math.min(Math.max(labelY, fontSize / 2 + 8), maxY);

        const pad = 3;
        const left = labelX - textWidth / 2 - pad;
        const right = labelX + textWidth / 2 + pad;
        const top = labelY - fontSize / 2 - pad * 0.5;
        const bottom = labelY + fontSize / 2 + pad * 0.5;

        // Hub names are the frame of the map; nothing may paint over them, not
        // even the selected label. Selection is already shown by the ring and
        // the detail panel.
        if (!isHub) {
          const coversHub = graphData.nodes.some((other) => {
            if (!other.hub) return false;
            const hub = positions.get(other.id);
            if (!hub) return false;
            const nearestX = Math.max(left, Math.min(hub.x, right));
            const nearestY = Math.max(top, Math.min(hub.y, bottom));
            return Math.hypot(hub.x - nearestX, hub.y - nearestY) < other.radius * zoom + 2;
          });
          if (coversHub) continue;
        }

        const collides = placed.some(
          (box) => left < box.right && right > box.left && top < box.bottom && bottom > box.top,
        );
        // Hubs stay eligible at every zoom, but cannot overprint another name.
        // Suppressed names remain reachable through the caller's own list.
        if (collides && !selected && !hovered) continue;

        if (fade >= 0.3) {
          hitAreas.push({
            id: node.id,
            left: left - 2,
            top: top - 2,
            right: right + 2,
            bottom: bottom + 2,
          });
        }
        const drawX = Math.round((labelX - bitmap.width / 2) * dpr) / dpr;
        const drawY = Math.round((labelY - bitmap.height / 2) * dpr) / dpr;
        context.globalAlpha = fade;
        context.drawImage(bitmap.canvas, drawX, drawY, bitmap.width, bitmap.height);
        context.globalAlpha = 1;
        placed.push({ left, top, right, bottom });
      }
      labelHitAreas.current = hitAreas;
      context.restore();
    },
    [
      activeIds,
      getLabelBitmap,
      graphData.nodes,
      hoveredId,
      labelHubsAlways,
      palette,
      parentHubs,
      selectedId,
      showContextLabels,
      size.height,
      size.width,
    ],
  );

  /** Links are stroked per colour/width/dash group to keep one path per style. */
  const linkStyle = useCallback(
    (link: LinkPoint) => {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const sourceActive = activeIds.has(source);
      const targetActive = activeIds.has(target);
      const similar = link.relation === "similarity";
      const selectedEdge = selectedId !== null && (source === selectedId || target === selectedId);
      const otherActive = selectedEdge
        ? source === selectedId
          ? targetActive
          : sourceActive
        : false;

      let color: string;
      if (selectedEdge) {
        color = otherActive
          ? similar
            ? palette.edgeSimilarity
            : palette.edgeSelected
          : similar
            ? palette.edgeSimilarityDim
            : palette.edgeDim;
      } else if (sourceActive && targetActive) {
        color = similar ? palette.edgeSimilarity : palette.edge;
      } else {
        color = similar ? palette.edgeSimilarityDim : palette.edgeDim;
      }

      const width = similar
        ? selectedEdge && otherActive
          ? 1
          : 0.7
        : selectedEdge && otherActive
          ? 1.4
          : 0.9;
      return { color, width, dash: similar };
    },
    [activeIds, palette, selectedId],
  );

  /**
   * One frame: clear, draw links in the camera transform, draw nodes and the
   * label overlay, then stop. Nothing schedules another frame.
   */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(size.width * dpr));
    const pixelHeight = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
    }

    const camera = cameraRef.current;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.save();
    context.translate(size.width / 2, size.height / 2);
    context.scale(camera.k, camera.k);
    context.translate(-camera.x, -camera.y);

    // A fresh layout resolves endpoints lazily; the index lets the very first
    // frame after a data change already draw its edges.
    const groups = new Map<string, { color: string; width: number; dash: boolean; path: Path2D }>();
    for (const link of graphData.links) {
      const source =
        typeof link.source === "object" ? link.source : nodeIndex.get(String(link.source));
      const target =
        typeof link.target === "object" ? link.target : nodeIndex.get(String(link.target));
      if (!source || !target) continue;
      if (typeof source.x !== "number" || typeof source.y !== "number") continue;
      if (typeof target.x !== "number" || typeof target.y !== "number") continue;
      const style = linkStyle(link);
      const key = `${style.color}|${style.width}|${style.dash ? 1 : 0}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          color: style.color,
          // Stroke widths are declared in screen pixels; the transform is zoomed.
          width: style.width / camera.k,
          dash: style.dash,
          path: new Path2D(),
        };
        groups.set(key, group);
      }
      group.path.moveTo(source.x, source.y);
      group.path.lineTo(target.x, target.y);
    }
    for (const group of groups.values()) {
      context.strokeStyle = group.color;
      context.lineWidth = group.width;
      context.setLineDash(group.dash ? [3, 3] : []);
      context.stroke(group.path);
    }
    context.setLineDash([]);

    for (const node of graphData.nodes) paintNode(context, node);
    context.restore();

    drawLabels(context, camera, dpr);
  }, [
    drawLabels,
    graphData.links,
    graphData.nodes,
    linkStyle,
    nodeIndex,
    paintNode,
    size.height,
    size.width,
  ]);

  useEffect(() => {
    paintRef.current = paint;
    requestPaint();
  }, [paint, requestPaint]);

  useEffect(() => {
    setGraphCursor("grab");
  }, [setGraphCursor]);

  // Hover, selection, palette, size and font readiness rebuild `paint`. Radius
  // and score updates mutate the existing graph object, so the incoming data
  // props must request a frame on their own.
  useEffect(() => {
    requestPaint();
  }, [fontReady, nodes, links, paint, requestPaint]);

  /** A DPR change (moving between displays) must resize and repaint the canvas. */
  useEffect(() => {
    let media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
      media.removeEventListener("change", onChange);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onChange);
      requestPaint();
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [requestPaint]);

  function zoomBy(factor: number) {
    stopWheelZoom();
    stopCameraAnimation();
    const camera = cameraRef.current;
    animateCameraTo(camera.x, camera.y, camera.k * factor, reducedMotion ? 0 : 250);
  }

  function resetLayout() {
    stopWheelZoom();
    stopCameraAnimation();
    setLayoutVersion((version) => version + 1);
  }

  return (
    <div
      ref={containerRef}
      className="graph-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onMouseDownCapture={(event) => {
        // A node drag owns the gesture; stop the browser from starting a
        // selection while the pointer is over the map.
        if (
          event.button === 0 &&
          isGraphSurface(event.target) &&
          findHitAt(event.clientX, event.clientY)
        ) {
          event.preventDefault();
        }
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="graph-canvas__surface" />

      <div role="group" aria-label="Graph view controls" className="graph-canvas__toolbar">
        <button
          type="button"
          className="graph-canvas__control"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomBy(0.8)}
        >
          <Minus />
        </button>
        <button
          type="button"
          className="graph-canvas__control"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomBy(1.25)}
        >
          <Plus />
        </button>
        <button
          type="button"
          className="graph-canvas__control"
          aria-label="Fit graph to view"
          title="Fit graph to view"
          onClick={() => fitAll(reducedMotion ? 0 : 300)}
        >
          <Maximize2 />
        </button>
        {selectedId && (
          <button
            type="button"
            className="graph-canvas__control"
            aria-label="Focus selected node"
            title="Focus selected node"
            onClick={() => fitSelectionCamera(reducedMotion ? 0 : 450)}
          >
            <Crosshair />
          </button>
        )}
        <button
          type="button"
          className="graph-canvas__control"
          aria-label="Restart layout"
          title="Restart layout"
          onClick={resetLayout}
        >
          <RotateCcw />
        </button>
      </div>
    </div>
  );
}
