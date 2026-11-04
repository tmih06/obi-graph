import { forceSimulation, type Simulation } from "d3-force";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import {
  connectionsFor,
  endpointId,
  type GraphLink,
  type GraphNode,
  type NodeShape,
} from "./model.ts";
import { resolveConfig, type GraphConfig } from "./config.ts";
import {
  layoutForces,
  makeGraphData,
  type NodePoint,
  type LinkPoint,
  type CanvasGraph,
} from "./layout.ts";
import { ScreenGrid } from "./screen-grid.ts";
import { HighlightTransition, type HighlightStyle } from "./highlight-transition.ts";

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

interface LabelBitmap {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Default label face; `--graph-font-sans` overrides it from the stylesheet. */
const LABEL_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Build one node outline. Polygons get optically rounded corners: each vertex
 * is replaced by a short quadratic curve, so the square and triangle still read
 * as their shape instead of losing their silhouette to a large radius.
 */
const POLYGONS = Object.fromEntries(
  (["square", "triangle", "diamond", "pentagon"] as const).map((shape) => {
    const sides = shape === "triangle" ? 3 : shape === "pentagon" ? 5 : 4;
    const rotation = shape === "triangle" ? -Math.PI / 2 : shape === "square" ? Math.PI / 4 : 0;
    return [
      shape,
      Array.from({ length: sides }, (_, index) => {
        const angle = rotation + (index / sides) * Math.PI * 2;
        return { x: Math.cos(angle), y: Math.sin(angle) };
      }),
    ];
  }),
) as Record<Exclude<NodeShape, "circle">, { x: number; y: number }[]>;

function nodePath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  shape: NodeShape,
  begin = true,
) {
  if (begin) context.beginPath();
  if (shape === "circle") {
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  const points = POLYGONS[shape];
  const first = points[0]!;
  const second = points[1]!;
  const edgeLength = Math.hypot(second.x - first.x, second.y - first.y) * radius;
  const t = Math.min(0.5, Math.min(radius * 0.35, 2.2) / (edgeLength || 1));
  context.moveTo(
    x + (first.x + (second.x - first.x) * t) * radius,
    y + (first.y + (second.y - first.y) * t) * radius,
  );
  for (let index = 1; index <= points.length; index += 1) {
    const vertex = points[index % points.length]!;
    const previous = points[(index - 1) % points.length]!;
    const next = points[(index + 1) % points.length]!;
    context.lineTo(
      x + (vertex.x + (previous.x - vertex.x) * t) * radius,
      y + (vertex.y + (previous.y - vertex.y) * t) * radius,
    );
    context.quadraticCurveTo(
      x + vertex.x * radius,
      y + vertex.y * radius,
      x + (vertex.x + (next.x - vertex.x) * t) * radius,
      y + (vertex.y + (next.y - vertex.y) * t) * radius,
    );
  }
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
  fontSize: number,
  textWidth: number,
): LabelBitmap {
  const font = `${isHub ? 500 : 400} ${fontSize}px ${fontFamily}`;
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
  return { canvas, width, height };
}

const INTERACTIVE_TARGET = "button, a, input, select, textarea, [role='dialog']";

/** Pointer events over graph chrome must not become graph clicks. */
function isGraphSurface(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest(INTERACTIVE_TARGET));
}

interface GraphPalette {
  accent: string;
  node: string;
  foreground: string;
  muted: string;
  background: string;
  edge: string;
  /** Resolved once with the colours so labels never re-read the stylesheet. */
  fontFamily: string;
}

const FALLBACK_PALETTE: GraphPalette = {
  accent: "#7048e8",
  node: "#bfc3c9",
  foreground: "#0a0a0a",
  muted: "#737373",
  background: "#ffffff",
  edge: "rgba(115, 115, 115, 0.30)",
  fontFamily: LABEL_FONT_FAMILY,
};

let colorProbe: CanvasRenderingContext2D | null = null;

/** Canvas cannot read CSS custom properties, so resolve the theme tokens once. */
function resolveColor(color: string, alpha = 1): string {
  if (!color) return `rgba(120, 120, 120, ${alpha})`;
  if (typeof document === "undefined") return color;
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

function readPalette(element?: HTMLElement | null): GraphPalette {
  if (typeof document === "undefined" || !element) return FALLBACK_PALETTE;
  const styles = getComputedStyle(element);
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
    accent: token("--graph-accent") || FALLBACK_PALETTE.accent,
    node: token("--graph-node") || FALLBACK_PALETTE.node,
    foreground: fg,
    muted,
    background: surface,
    edge: resolveColor(line, 0.3),
    fontFamily: token("--graph-font-sans") || LABEL_FONT_FAMILY,
  };
}

function useReducedMotion() {
  // The first paint must already respect the preference; a false default would
  // animate one settle before the media query's effect runs.
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
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

export type Theme = "light" | "dark";

export interface GraphCanvasProps<N = unknown, L = unknown> {
  nodes: readonly GraphNode<N>[];
  links: readonly GraphLink<L>[];
  config?: GraphConfig<N, L>;
  theme?: Theme;
  /** Omit for internal selection state; null explicitly clears controlled selection. */
  selectedId?: string | null;
  defaultSelectedId?: string | null;
  /** Omit to keep every node active. */
  activeIds?: ReadonlySet<string>;
  emphasisIds?: ReadonlySet<string>;
  onSelect?: (id: string | null, node: GraphNode<N> | null) => void;
  onNodeHover?: (node: GraphNode<N> | null) => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

/**
 * Graph canvas: native canvas rendering, d3-force layout, camera pan/zoom,
 * node dragging and selection. The canvas is visual; a caller's own list is
 * the keyboard and screen-reader path through the same nodes.
 */
export function GraphCanvas<N = unknown, L = unknown>({
  theme = "light",
  nodes,
  links,
  config,
  selectedId: controlledSelectedId,
  defaultSelectedId = null,
  activeIds: providedActiveIds,
  emphasisIds = EMPTY_IDS,
  onSelect,
  onNodeHover,
  className,
  style,
  ariaLabel = "Interactive node graph",
}: GraphCanvasProps<N, L>) {
  const settings = useMemo(() => resolveConfig(config), [config]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const clampZoom = useCallback(
    (scale: number) => Math.min(settings.camera.maxZoom, Math.max(settings.camera.minZoom, scale)),
    [settings.camera.minZoom, settings.camera.maxZoom],
  );
  const [internalSelectedId, setInternalSelectedId] = useState(defaultSelectedId);
  const selectedId = controlledSelectedId === undefined ? internalSelectedId : controlledSelectedId;
  const activeIds = useMemo(
    () => providedActiveIds ?? new Set(nodes.map((node) => node.id)),
    [providedActiveIds, nodes],
  );
  const sourceNodeIndex = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const showContextLabels = settings.labels.alwaysVisible;
  const labelHubsAlways = settings.labels.hubLabelsAlways;
  const autoFitSelection = settings.camera.autoFitSelection;
  const selectionBottomInset = settings.camera.selectionBottomInset;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The camera is owned by refs because gestures update it every frame. */
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const fitZoomRef = useRef(1);
  const paintRef = useRef<() => void>(() => {});
  const drawFrame = useRef(0);
  const simulationRef = useRef<Simulation<NodePoint, LinkPoint> | null>(null);
  const retainedAlpha = useRef(0);
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
  /** Only the first layout may auto-fit on settling; explicit camera work cancels it. */
  const initialFitPending = useRef(true);
  const reducedMotion = useReducedMotion();
  /** Media changes must not rebuild a settled simulation. */
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [palette, setPalette] = useState<GraphPalette>(FALLBACK_PALETTE);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const focusedId = hoveredId ?? selectedId;
  const [fontReady, setFontReady] = useState(false);
  const previousLayout = useRef<{ version: number; data: CanvasGraph } | null>(null);
  const graphData = useMemo(() => {
    const previous = previousLayout.current;
    const data = makeGraphData(
      nodes,
      links,
      settings,
      layoutVersion,
      previous?.version === layoutVersion ? previous.data : undefined,
    );
    return data;
  }, [nodes, links, settings, layoutVersion]);
  useEffect(() => {
    // Publish only the committed graph. Strict Mode may discard memo calculations;
    // retaining one of those copies would rewind the next update to stale positions.
    previousLayout.current = { version: layoutVersion, data: graphData };
  }, [graphData, layoutVersion]);
  const nodeIndex = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node])),
    [graphData.nodes],
  );
  useEffect(() => {
    const drag = dragNode.current;
    if (!drag) return;
    const current = nodeIndex.get(drag.node.id);
    if (current) drag.node = current;
    else dragNode.current = null;
  }, [nodeIndex]);

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
      if (duration <= 0 || reducedMotionRef.current) {
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
    [clampZoom, requestPaint, stopCameraAnimation, stopWheelZoom],
  );

  useEffect(() => {
    stopWheelZoom();
    stopCameraAnimation();
    cameraRef.current.k = clampZoom(cameraRef.current.k);
    requestPaint();
  }, [clampZoom, requestPaint, stopCameraAnimation, stopWheelZoom]);

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
      if (
        reducedMotion ||
        !settings.interaction.inertia ||
        !gesture.moved ||
        event.timeStamp - gesture.time > 80
      )
        return;
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
  }, [reducedMotion, settings.interaction.inertia, stopCameraAnimation, requestPaint]);

  const getLabelBitmap = useCallback(
    (
      label: string,
      isHub: boolean,
      color: string,
      background: string,
      dpr: number,
      fontFamily: string,
      fontSize: number,
      textWidth: number,
    ) => {
      const key = `${isHub ? 1 : 0}|${dpr}|${color}|${background}|${fontFamily}|${fontSize}|${label}`;
      const cached = labelCache.current.get(key);
      if (cached) return cached;
      const bitmap = makeLabelBitmap(
        label,
        isHub,
        color,
        background,
        dpr,
        fontFamily,
        fontSize,
        textWidth,
      );
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
    const frame = window.requestAnimationFrame(() => setPalette(readPalette(containerRef.current)));
    return () => window.cancelAnimationFrame(frame);
  }, [theme, className, style]);

  useEffect(() => {
    labelCache.current.clear();
    labelHitAreas.current = [];
  }, [
    palette,
    nodes,
    settings.labels.color,
    settings.labels.fontSize,
    settings.labels.hubFontSize,
    settings.labels.fontFamily,
  ]);

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
      if (!settings.interaction.zoom) return;
      event.preventDefault();
      initialFitPending.current = false;
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
  }, [clampZoom, settings.interaction.zoom, stopCameraAnimation]);

  const nodesRef = useRef(graphData.nodes);
  useEffect(() => {
    nodesRef.current = graphData.nodes;
    sizeRef.current = size;
  }, [graphData.nodes, size]);

  /** Frame live positions without rebuilding the force layout. */
  const fitAll = useCallback(
    (duration: number) => {
      const { width: viewWidth, height: viewHeight } = sizeRef.current;
      const nodes = nodesRef.current;
      if (!viewWidth || !viewHeight || !nodes.length) return;
      const padding = settings.camera.fitPadding;
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
      fitZoomRef.current = k;
    },
    [animateCameraTo, clampZoom, settings.camera.fitPadding],
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
      const padding = settings.camera.fitPadding;
      const availableWidth = Math.max(1, size.width - padding * 2);
      const availableHeight = Math.max(1, size.height - bottomInset - padding * 2);
      const bboxWidth = Math.max(1, maxX - minX);
      const bboxHeight = Math.max(1, maxY - minY);
      // "Just enough": a single node and its neighbours would otherwise fill
      // the viewport at the maximum zoom, losing the surrounding context.
      const scale = Math.min(
        settings.camera.maxZoom,
        clampZoom(Math.min(availableWidth / bboxWidth, availableHeight / bboxHeight)),
      );
      const targetX = (minX + maxX) / 2;
      const targetScreenY = (size.height - bottomInset) / 2;
      const targetY = (minY + maxY) / 2 + (size.height / 2 - targetScreenY) / scale;
      animateCameraTo(targetX, targetY, scale, duration);
    },
    [
      animateCameraTo,
      clampZoom,
      settings.camera.fitPadding,
      settings.camera.maxZoom,
      graphData,
      selectedId,
      selectionBottomInset,
      size.height,
      size.width,
    ],
  );

  const fitSelectionRef = useRef(fitSelectionCamera);
  fitSelectionRef.current = fitSelectionCamera;
  useEffect(() => {
    if (!selectedId || !autoFitSelection) return;
    initialFitPending.current = false;
    fitSelectionRef.current(620);
  }, [autoFitSelection, selectedId]);

  /**
   * The layout ticks only while it is asked to: a rebuild relaxes for at most
   * two seconds, and a node drag keeps it warm until the node is released.
   * No animation frame survives a settled graph.
   */
  const runRelaxation = useCallback(
    (mode: "settle" | "drag") => {
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
          (ticks >= settingsRef.current.physics.settleTicks ||
            now - startedAt >= settingsRef.current.physics.settleMs ||
            simulation.alpha() < simulation.alphaMin())
        ) {
          // The layout is at rest; nothing more is scheduled.
          if (initialFitPending.current) {
            initialFitPending.current = false;
            fitAll(0);
          }
          return;
        }
        relaxation.current = window.requestAnimationFrame(step);
      };
      relaxation.current = window.requestAnimationFrame(step);
    },
    [fitAll],
  );

  const stopRelaxation = useCallback(() => {
    const frame = relaxation.current;
    if (frame !== null) window.cancelAnimationFrame(frame);
    relaxation.current = null;
  }, []);

  const mountedGraph = size.width > 0;
  useEffect(() => {
    if (!mountedGraph) return;
    const simulation = forceSimulation<NodePoint, LinkPoint>(graphData.nodes)
      .alphaDecay(settings.physics.alphaDecay)
      .velocityDecay(settings.physics.velocityDecay)
      .stop();
    const forces = layoutForces(settings);
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
    if (reducedMotionRef.current || (!graphData.layoutChanged && retainedAlpha.current === 0)) {
      simulation.alpha(0);
      if (initialFitPending.current) {
        initialFitPending.current = false;
        fitAll(0);
      }
      requestPaint();
    } else {
      // Only the initial graph frames itself automatically. Tuning and restarts
      // preserve the camera, including gestures made while the solver is active.
      if (initialFitPending.current) fitAll(0);
      // Keep cooling/velocity through tuning instead of kicking every slider step
      // back to the full-energy initial layout.
      simulation.alpha(graphData.topologyChanged ? 1 : Math.max(retainedAlpha.current, 0.12));
      requestPaint();
      runRelaxation("settle");
    }
    return () => {
      retainedAlpha.current = relaxation.current === null ? 0 : simulation.alpha();
      stopRelaxation();
      simulation.stop();
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [fitAll, graphData, settings, mountedGraph, requestPaint, runRelaxation, stopRelaxation]);

  const reheat = useCallback(() => {
    const simulation = simulationRef.current;
    if (!simulation || reducedMotionRef.current) return;
    simulation.alphaTarget(0).alpha(1);
    runRelaxation("settle");
  }, [runRelaxation]);

  const updateHovered = useCallback(
    (id: string | null) => {
      if (hoveredIdRef.current === id) return;
      hoveredIdRef.current = id;
      setHoveredId(id);
      onNodeHover?.(id === null ? null : (sourceNodeIndex.get(id) ?? null));
    },
    [onNodeHover, sourceNodeIndex],
  );

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
      if (x < 0 || y < 0 || x > width || y > height) return null;

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
    // Restore caller pins after a drag; otherwise release back to the layout.
    const source = sourceNodeIndex.get(node.id);
    node.fx = source?.fx ?? undefined;
    node.fy = source?.fy ?? undefined;
    // The drag held the layout warm; release it back to its resting target.
    const simulation = simulationRef.current;
    if (simulation) simulation.alphaTarget(0);
    reheat();
    return true;
  }, [reheat, sourceNodeIndex]);

  /** Interrupt camera motion whenever a direct gesture starts. */
  function beginPointer(event: ReactPointerEvent<HTMLDivElement>) {
    initialFitPending.current = false;
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
    if (!settings.interaction.zoom) return;
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
    updateHovered(null);
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
    if (
      settings.interaction.pan &&
      event.isPrimary &&
      (!hitId || !settings.interaction.dragNodes || event.pointerType === "touch")
    ) {
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
    if (settings.interaction.dragNodes && event.pointerType !== "touch" && hitId) {
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
        updateHovered(node.id);
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
    if (!isGraphSurface(event.target) && dragNode.current?.pointerId !== event.pointerId) {
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
          updateHovered(drag.node.id);
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
      if (remaining && settings.interaction.pan) {
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
    if (controlledSelectedId === undefined) setInternalSelectedId(start.hitId);
    onSelect?.(
      start.hitId,
      start.hitId === null ? null : (sourceNodeIndex.get(start.hitId) ?? null),
    );
    updateHovered(start.hitId);
    setGraphCursor(start.hitId ? "pointer" : "grab");
  }

  function handlePointerLeave() {
    if (dragNode.current) return;
    updateHovered(null);
    setGraphCursor("");
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    activePointers.current.delete(event.pointerId);
    pinch.current = null;
    finishNodeDrag();
    updateHovered(null);
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

  const focusNeighborhood = useMemo(() => {
    if (focusedId === null) return null;
    const ids = new Set([focusedId]);
    for (const link of graphData.links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (source === focusedId) ids.add(target);
      if (target === focusedId) ids.add(source);
    }
    return ids;
  }, [graphData.links, focusedId]);

  const previousHighlight = useRef<HighlightTransition | null>(null);
  const highlight = useMemo(() => {
    const transition = new HighlightTransition(performance.now(), reducedMotion ? 0 : 240);
    const previous = previousHighlight.current;
    for (const node of graphData.nodes) {
      const key = `node:${node.id}`;
      const active = focusNeighborhood ? focusNeighborhood.has(node.id) : activeIds.has(node.id);
      transition.add(
        key,
        {
          opacity: active ? 1 : settings.nodes.dimOpacity,
          highlight: focusNeighborhood?.has(node.id) ? 1 : 0,
          accent: node.id === focusedId ? 1 : 0,
          title: focusNeighborhood?.has(node.id) ? 1 : 0,
          width: 0,
          labelScale: node.id === focusedId ? FOCUS_LABEL_SCALE : 1,
        },
        previous?.entries.get(key),
      );
    }
    for (const link of graphData.links) {
      const key = `link:${link.id}`;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const incident = focusedId !== null && (source === focusedId || target === focusedId);
      const active = focusedId !== null ? incident : activeIds.has(source) && activeIds.has(target);
      transition.add(
        key,
        {
          opacity: active ? 1 : settings.nodes.dimOpacity,
          highlight: incident ? 1 : 0,
          accent: incident ? 1 : 0,
          title: 0,
          width: link.width * (incident ? 1.6 : 1),
          labelScale: 1,
        },
        previous?.entries.get(key),
      );
    }
    return transition;
  }, [
    graphData,
    focusNeighborhood,
    focusedId,
    activeIds,
    settings.nodes.dimOpacity,
    reducedMotion,
  ]);
  useEffect(() => {
    previousHighlight.current = highlight;
  }, [highlight]);

  const paintNode = useCallback(
    (ctx: CanvasRenderingContext2D, node: NodePoint) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const visual = highlight.entries.get(`node:${node.id}`)!;
      const emphasis = emphasisIds.has(node.id);
      const radius = node.radius;
      const shape = node.shape;
      const fill = node.color ?? palette.node;

      ctx.save();
      ctx.globalAlpha = visual.opacity;

      nodePath(ctx, x, y, radius, shape);
      if (visual.highlight < 1) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (visual.highlight > 0 && visual.accent < 1) {
        ctx.globalAlpha = visual.opacity * visual.highlight;
        ctx.fillStyle = palette.foreground;
        ctx.fill();
      }
      if (visual.accent > 0) {
        ctx.globalAlpha = visual.opacity * visual.accent;
        ctx.fillStyle = palette.accent;
        ctx.fill();
      }
      ctx.globalAlpha = visual.opacity;
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = palette.background;
      ctx.stroke();

      ctx.globalAlpha *= 1 - visual.title;
      if (emphasis) {
        nodePath(ctx, x, y, radius + 3.5, shape);
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = palette.accent;
        ctx.stroke();
      }

      ctx.restore();
    },
    [emphasisIds, highlight, palette],
  );

  const nodeBatches = useMemo(() => {
    const groups = new Map<string, { color: string; visual: HighlightStyle; nodes: NodePoint[] }>();
    const decorated: NodePoint[] = [];
    for (const node of graphData.nodes) {
      if (emphasisIds.has(node.id)) {
        decorated.push(node);
        continue;
      }
      const color = node.color ?? palette.node;
      const visual = highlight.entries.get(`node:${node.id}`)!;
      const key = `${color}|${visual.id}`;
      let group = groups.get(key);
      if (!group) {
        group = { color, visual, nodes: [] };
        groups.set(key, group);
      }
      group.nodes.push(node);
    }
    return { groups: [...groups.values()], decorated };
  }, [graphData.nodes, emphasisIds, highlight, palette.node]);

  const labelLayout = useMemo(() => {
    const entries = graphData.nodes.map((node) => ({
      node,
      x: 0,
      y: 0,
      visible: false,
      textWidth: -1,
      box: { left: 0, top: 0, right: 0, bottom: 0 },
      hubBox: { left: 0, top: 0, right: 0, bottom: 0, radius: 0 },
      hit: { id: node.id, left: 0, top: 0, right: 0, bottom: 0 },
    }));
    return {
      entries,
      placed: new ScreenGrid(),
      hubs: new ScreenGrid(),
    };
  }, [
    graphData.nodes,
    settings.labels.fontSize,
    settings.labels.hubFontSize,
    settings.labels.fontFamily,
    palette.fontFamily,
    fontReady,
  ]);
  const labelCandidates = useMemo(() => {
    const priority = (node: NodePoint) =>
      node.id === focusedId ? 3 : node.hub ? 1.5 : node.degree > 2 ? 2 : 1;
    return labelLayout.entries
      .filter(
        ({ node }) =>
          activeIds.has(node.id) ||
          focusNeighborhood?.has(node.id) ||
          (highlight.entries.get(`node:${node.id}`)?.from.title ?? 0) > 0,
      )
      .sort((a, b) => priority(b.node) - priority(a.node));
  }, [labelLayout, activeIds, focusedId, focusNeighborhood, highlight]);

  /**
   * Labels paint over the graph in screen space, so their size stays stable
   * while the graph zooms. Colliding labels are skipped except for the active
   * selection.
   */
  const drawLabels = useCallback(
    (context: CanvasRenderingContext2D, camera: Camera, dpr: number) => {
      if (!settings.labels.visible || !size.width || !size.height) {
        labelHitAreas.current.length = 0;
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
      // All titles share one threshold. A fitted overview stays label-free;
      // hover and explicit always-visible options are the only exceptions.
      const threshold = Math.max(settings.labels.zoomThreshold, fitZoomRef.current * 1.15);
      const labelFade = smoothstep(threshold, threshold + settings.labels.fadeRange, zoom);
      const { entries, placed, hubs } = labelLayout;
      placed.reset(size.width, size.height);
      hubs.reset(size.width, size.height);
      for (const entry of entries) {
        const { node } = entry;
        entry.visible = typeof node.x === "number" && typeof node.y === "number";
        if (!entry.visible) continue;
        entry.x = ((node.x ?? 0) - camera.x) * zoom + size.width / 2;
        entry.y = ((node.y ?? 0) - camera.y) * zoom + size.height / 2;
        const radius = node.radius * zoom + 2;
        entry.visible =
          entry.x + radius >= 0 &&
          entry.x - radius <= size.width &&
          entry.y + radius >= 0 &&
          entry.y - radius <= size.height;
        if (node.hub && entry.visible) {
          const box = entry.hubBox;
          box.left = entry.x - radius;
          box.right = entry.x + radius;
          box.top = entry.y - radius;
          box.bottom = entry.y + radius;
          box.radius = radius;
          hubs.insert(box);
        }
      }
      const hitAreas = labelHitAreas.current;
      hitAreas.length = 0;
      for (const point of labelCandidates) {
        if (!point.visible) continue;
        const { node } = point;
        const isHub = node.hub === true;
        const visual = highlight.entries.get(`node:${node.id}`)!;
        const fade =
          Math.max(visual.title, showContextLabels || (labelHubsAlways && isHub) ? 1 : labelFade) *
          visual.opacity;
        if (fade < 0.02) continue;
        const baseFontSize = isHub ? settings.labels.hubFontSize : settings.labels.fontSize;
        const fontSize = baseFontSize * visual.labelScale;
        if (point.textWidth < 0) {
          context.font = `${isHub ? 500 : 400} ${baseFontSize}px ${settings.labels.fontFamily ?? palette.fontFamily}`;
          point.textWidth = context.measureText(node.label).width;
        }
        const textWidth = point.textWidth * visual.labelScale;
        let labelX = point.x;
        // Keep labels close; the current focus eases six pixels farther down
        // so its larger title clears the pointer without moving neighbours.
        let labelY =
          point.y +
          node.radius * zoom +
          (Math.ceil(baseFontSize + 8) * visual.labelScale) / 2 +
          3 +
          6 * visual.accent;

        const inset = textWidth / 2 + 4;
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

        if (!isHub && visual.title <= 0 && hubs.intersects(left, top, right, bottom)) continue;
        const collides = placed.intersects(left, top, right, bottom);
        // Hubs stay eligible at every zoom, but cannot overprint another name.
        // Suppressed names remain reachable through the caller's own list.
        if (collides && visual.title <= 0) continue;

        if (fade >= 0.3) {
          const hit = point.hit;
          hit.left = left - 2;
          hit.top = top - 2;
          hit.right = right + 2;
          hit.bottom = bottom + 2;
          hitAreas.push(hit);
        }
        // Only accepted labels allocate a raster; hidden labels retain cheap metrics.
        const bitmap = getLabelBitmap(
          node.label,
          isHub,
          visual.title >= 1 ? palette.foreground : (settings.labels.color ?? palette.muted),
          palette.background,
          dpr * FOCUS_LABEL_SCALE,
          settings.labels.fontFamily ?? palette.fontFamily,
          baseFontSize,
          point.textWidth,
        );
        const drawWidth = bitmap.width * visual.labelScale;
        const drawHeight = bitmap.height * visual.labelScale;
        const drawX = Math.round((labelX - drawWidth / 2) * dpr) / dpr;
        const drawY = Math.round((labelY - drawHeight / 2) * dpr) / dpr;
        context.globalAlpha = fade;
        context.drawImage(bitmap.canvas, drawX, drawY, drawWidth, drawHeight);
        if (visual.title > 0 && visual.title < 1) {
          const bright = getLabelBitmap(
            node.label,
            isHub,
            palette.foreground,
            palette.background,
            dpr * FOCUS_LABEL_SCALE,
            settings.labels.fontFamily ?? palette.fontFamily,
            baseFontSize,
            point.textWidth,
          );
          context.globalAlpha = fade * visual.title;
          context.drawImage(
            bright.canvas,
            drawX,
            drawY,
            bright.width * visual.labelScale,
            bright.height * visual.labelScale,
          );
        }
        context.globalAlpha = 1;
        const box = point.box;
        box.left = left;
        box.top = top;
        box.right = right;
        box.bottom = bottom;
        placed.insert(box);
      }
      context.restore();
    },
    [
      labelLayout,
      labelCandidates,
      getLabelBitmap,
      highlight,
      labelHubsAlways,
      palette,
      showContextLabels,
      size.height,
      size.width,
      settings.labels,
    ],
  );

  /** Batch resolved links outside the animation loop; frames only read positions. */
  const linkGroups = useMemo(() => {
    type Group = {
      color: string;
      visual: HighlightStyle;
      dash: boolean;
      segments: { source: NodePoint; target: NodePoint }[];
    };
    const groups = new Map<string, Group>();
    for (const link of graphData.links) {
      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);
      const source = nodeIndex.get(sourceId);
      const target = nodeIndex.get(targetId);
      if (!source || !target) continue;
      const color = link.color ?? palette.edge;
      const visual = highlight.entries.get(`link:${link.id}`)!;
      const key = `${color}|${visual.id}|${link.dashed}`;
      let group = groups.get(key);
      if (!group) {
        group = { color, visual, dash: link.dashed, segments: [] };
        groups.set(key, group);
      }
      group.segments.push({ source, target });
    }
    return [...groups.values()];
  }, [graphData.links, nodeIndex, palette, highlight]);

  /**
   * One frame: clear, draw links in the camera transform, draw nodes and the
   * label overlay, then stop. Nothing schedules another frame.
   */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = settings.rendering.pixelRatio ?? (window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(size.width * dpr));
    const pixelHeight = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
    }

    const camera = cameraRef.current;
    const left = camera.x - size.width / (2 * camera.k);
    const right = camera.x + size.width / (2 * camera.k);
    const top = camera.y - size.height / (2 * camera.k);
    const bottom = camera.y + size.height / (2 * camera.k);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.save();
    context.translate(size.width / 2, size.height / 2);
    context.scale(camera.k, camera.k);
    context.translate(-camera.x, -camera.y);

    const animatingHighlight = highlight.advance(performance.now());
    for (const group of linkGroups) {
      const path = new Path2D();
      const margin = group.visual.width / camera.k;
      for (const { source, target } of group.segments) {
        if (typeof source.x !== "number" || typeof source.y !== "number") continue;
        if (typeof target.x !== "number" || typeof target.y !== "number") continue;
        if (
          Math.max(source.x, target.x) + margin < left ||
          Math.min(source.x, target.x) - margin > right ||
          Math.max(source.y, target.y) + margin < top ||
          Math.min(source.y, target.y) - margin > bottom
        )
          continue;
        path.moveTo(source.x, source.y);
        path.lineTo(target.x, target.y);
      }
      context.lineWidth = group.visual.width / camera.k;
      context.setLineDash(group.dash ? DASHED_LINE : SOLID_LINE);
      if (group.visual.highlight < 1) {
        context.globalAlpha = group.visual.opacity;
        context.strokeStyle = group.color;
        context.stroke(path);
      }
      if (group.visual.accent > 0) {
        context.globalAlpha = group.visual.opacity * group.visual.accent;
        context.strokeStyle = palette.accent;
        context.stroke(path);
      }
    }
    context.setLineDash(SOLID_LINE);

    context.strokeStyle = palette.background;
    context.lineWidth = 0.7;
    for (const group of nodeBatches.groups) {
      context.beginPath();
      let visible = false;
      for (const node of group.nodes) {
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        if (
          x + node.radius < left ||
          x - node.radius > right ||
          y + node.radius < top ||
          y - node.radius > bottom
        )
          continue;
        nodePath(context, x, y, node.radius, node.shape, false);
        visible = true;
      }
      if (!visible) continue;
      if (group.visual.highlight < 1) {
        context.globalAlpha = group.visual.opacity;
        context.fillStyle = group.color;
        context.fill();
      }
      if (group.visual.highlight > 0 && group.visual.accent < 1) {
        context.globalAlpha = group.visual.opacity * group.visual.highlight;
        context.fillStyle = palette.foreground;
        context.fill();
      }
      if (group.visual.accent > 0) {
        context.globalAlpha = group.visual.opacity * group.visual.accent;
        context.fillStyle = palette.accent;
        context.fill();
      }
      context.globalAlpha = group.visual.opacity;
      context.stroke();
    }
    context.globalAlpha = 1;
    for (const node of nodeBatches.decorated) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = node.radius + 9;
      if (x + radius < left || x - radius > right || y + radius < top || y - radius > bottom)
        continue;
      paintNode(context, node);
    }
    context.restore();

    drawLabels(context, camera, dpr);
    if (animatingHighlight) requestPaint();
  }, [
    drawLabels,
    nodeBatches,
    palette,
    highlight,
    requestPaint,
    linkGroups,
    paintNode,
    size.height,
    size.width,
    settings.rendering.pixelRatio,
  ]);

  useEffect(() => {
    paintRef.current = paint;
    requestPaint();
  }, [paint, requestPaint]);

  useEffect(() => {
    setGraphCursor("grab");
  }, [setGraphCursor]);

  // Font readiness and incoming data require a repaint even with a stable camera.
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
    initialFitPending.current = false;
    stopWheelZoom();
    stopCameraAnimation();
    const camera = cameraRef.current;
    animateCameraTo(camera.x, camera.y, camera.k * factor, reducedMotion ? 0 : 250);
  }

  function resetLayout() {
    initialFitPending.current = false;
    stopWheelZoom();
    stopCameraAnimation();
    setLayoutVersion((version) => version + 1);
  }

  return (
    <div
      ref={containerRef}
      className={className ? `graph-canvas ${className}` : "graph-canvas"}
      style={style}
      data-theme={theme}
      role="group"
      aria-label={ariaLabel}
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

      {settings.controls && (
        <div role="group" aria-label="Graph view controls" className="graph-canvas__toolbar">
          <button
            type="button"
            className="graph-canvas__control"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => zoomBy(0.8)}
          >
            <ControlIcon name="minus" />
          </button>
          <button
            type="button"
            className="graph-canvas__control"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => zoomBy(1.25)}
          >
            <ControlIcon name="plus" />
          </button>
          <button
            type="button"
            className="graph-canvas__control"
            aria-label="Fit graph to view"
            title="Fit graph to view"
            onClick={() => {
              initialFitPending.current = false;
              fitAll(reducedMotion ? 0 : 300);
            }}
          >
            <ControlIcon name="fit" />
          </button>
          {selectedId && (
            <button
              type="button"
              className="graph-canvas__control"
              aria-label="Focus selected node"
              title="Focus selected node"
              onClick={() => fitSelectionCamera(reducedMotion ? 0 : 450)}
            >
              <ControlIcon name="focus" />
            </button>
          )}
          <button
            type="button"
            className="graph-canvas__control"
            aria-label="Restart layout"
            title="Restart layout"
            onClick={resetLayout}
          >
            <ControlIcon name="reset" />
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
const DASHED_LINE = [3, 3];
const SOLID_LINE: number[] = [];

const CONTROL_PATHS = {
  minus: "M5 12h14",
  plus: "M5 12h14M12 5v14",
  fit: "M8 3H3v5M16 3h5v5M3 16v5h5M16 21h5v-5",
  focus: "M12 2v4M12 18v4M2 12h4M18 12h4M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  reset: "M3 4v6h6M3 10a9 9 0 1 1 2 8",
};

function ControlIcon({ name }: { name: keyof typeof CONTROL_PATHS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={CONTROL_PATHS[name]} />
    </svg>
  );
}
const FOCUS_LABEL_SCALE = 1.25;
