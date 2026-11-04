import type { GraphLink, GraphNode, NodeShape } from "./model.ts";

/** A fixed value, or a function of the item it applies to. */
export type GraphValue<T, V> = V | ((item: T) => V);

export interface GraphPhysicsConfig {
  charge: number;
  chargeDistance: number;
  linkDistance: number;
  linkStrength: number;
  collisionPadding: number;
  collisionStrength: number;
  collisionIterations: number;
  centerStrength: number;
  alphaDecay: number;
  velocityDecay: number;
  warmupTicks: number;
  settleTicks: number;
  settleMs: number;
}

export interface GraphNodesConfig<N = unknown> {
  radius: GraphValue<GraphNode<N>, number>;
  color: GraphValue<GraphNode<N>, string>;
  shape: GraphValue<GraphNode<N>, NodeShape>;
  charge: GraphValue<GraphNode<N>, number>;
  dimOpacity: number;
}

export interface GraphLinksConfig<L = unknown> {
  color: GraphValue<GraphLink<L>, string>;
  width: GraphValue<GraphLink<L>, number>;
  dashed: GraphValue<GraphLink<L>, boolean>;
  distance: GraphValue<GraphLink<L>, number>;
  strength: GraphValue<GraphLink<L>, number>;
}

export interface GraphLabelsConfig {
  visible: boolean;
  alwaysVisible: boolean;
  hubLabelsAlways: boolean;
  fontSize: number;
  hubFontSize: number;
  /** CSS color; absent means the resolved palette text color. */
  color: string;
  /** Font stack; absent means the stylesheet's `--graph-font-sans`. */
  fontFamily: string;
  /** Minimum zoom for every title; Fit View also applies a shared overview floor. */
  zoomThreshold: number;
  fadeRange: number;
}

export interface GraphCameraConfig {
  minZoom: number;
  maxZoom: number;
  fitPadding: number;
  autoFitSelection: boolean;
  selectionBottomInset: number;
}

export interface GraphInteractionConfig {
  dragNodes: boolean;
  pan: boolean;
  zoom: boolean;
  inertia: boolean;
  /**
   * Zoom below which hovering stops selecting nodes: the pointer stays neutral
   * and nothing dims. Zero disables the threshold.
   */
  hoverMinZoom: number;
}

export interface GraphRenderingConfig {
  /** Canvas pixel ratio; absent means the device's `devicePixelRatio`. */
  pixelRatio: number;
}

/**
 * Appearance and behaviour knobs for the canvas. Every group and every member
 * is optional; {@link resolveConfig} fills in the engine defaults.
 *
 * Precedence is always: explicit item property, then the configured value or
 * accessor, then the default.
 */
export interface GraphConfig<N = unknown, L = unknown> {
  physics?: Partial<GraphPhysicsConfig>;
  nodes?: Partial<GraphNodesConfig<N>>;
  links?: Partial<GraphLinksConfig<L>>;
  labels?: Partial<GraphLabelsConfig>;
  camera?: Partial<GraphCameraConfig>;
  interaction?: Partial<GraphInteractionConfig>;
  rendering?: Partial<GraphRenderingConfig>;
  controls?: boolean;
}

export interface ResolvedGraphNodesConfig<N = unknown> {
  radius: GraphValue<GraphNode<N>, number>;
  /** Absent: the renderer's CSS palette paints nodes. */
  color: GraphValue<GraphNode<N>, string> | undefined;
  shape: GraphValue<GraphNode<N>, NodeShape>;
  /** Absent: `physics.charge` applies. */
  charge: GraphValue<GraphNode<N>, number> | undefined;
  dimOpacity: number;
}

export interface ResolvedGraphLinksConfig<L = unknown> {
  /** Absent: the renderer's CSS palette paints links. */
  color: GraphValue<GraphLink<L>, string> | undefined;
  width: GraphValue<GraphLink<L>, number>;
  dashed: GraphValue<GraphLink<L>, boolean>;
  /** Absent: `physics.linkDistance` applies. */
  distance: GraphValue<GraphLink<L>, number> | undefined;
  /** Absent: `physics.linkStrength` applies. */
  strength: GraphValue<GraphLink<L>, number> | undefined;
}

export interface ResolvedGraphLabelsConfig {
  visible: boolean;
  alwaysVisible: boolean;
  hubLabelsAlways: boolean;
  fontSize: number;
  hubFontSize: number;
  /** Absent: the resolved palette text color. */
  color: string | undefined;
  /** Absent: the stylesheet's `--graph-font-sans` token. */
  fontFamily: string | undefined;
  zoomThreshold: number;
  fadeRange: number;
}

export interface ResolvedGraphRenderingConfig {
  /** Absent: the canvas uses `devicePixelRatio`. */
  pixelRatio: number | undefined;
}

export interface ResolvedGraphConfig<N = unknown, L = unknown> {
  physics: GraphPhysicsConfig;
  nodes: ResolvedGraphNodesConfig<N>;
  links: ResolvedGraphLinksConfig<L>;
  labels: ResolvedGraphLabelsConfig;
  camera: GraphCameraConfig;
  interaction: GraphInteractionConfig;
  rendering: ResolvedGraphRenderingConfig;
  controls: boolean;
}

/**
 * The engine defaults, in the shape {@link resolveConfig} returns. The
 * generics are open because a default is independent of the item payload.
 */
export const DEFAULT_GRAPH_CONFIG: ResolvedGraphConfig<any, any> = {
  physics: {
    charge: -600,
    chargeDistance: 650,
    linkDistance: 200,
    linkStrength: 0.3,
    collisionPadding: 10,
    collisionStrength: 1,
    collisionIterations: 3,
    centerStrength: 0.025,
    alphaDecay: 0.035,
    velocityDecay: 0.5,
    // No blocking pre-solve before first paint: the bounded animated settle
    // shapes the graph instead.
    warmupTicks: 0,
    settleTicks: 100,
    settleMs: 2_000,
  },
  nodes: {
    radius: 3.25,
    color: undefined,
    shape: "circle",
    charge: undefined,
    dimOpacity: 0.16,
  },
  links: {
    color: undefined,
    width: 0.9,
    dashed: false,
    distance: undefined,
    strength: undefined,
  },
  labels: {
    visible: true,
    alwaysVisible: false,
    hubLabelsAlways: false,
    fontSize: 11,
    hubFontSize: 12,
    color: undefined,
    fontFamily: undefined,
    zoomThreshold: 1.25,
    fadeRange: 0.3,
  },
  camera: {
    minZoom: 0.04,
    maxZoom: 8,
    fitPadding: 92,
    autoFitSelection: true,
    selectionBottomInset: 0,
  },
  interaction: {
    dragNodes: true,
    pan: true,
    zoom: true,
    inertia: true,
    hoverMinZoom: 0,
  },
  rendering: {
    pixelRatio: undefined,
  },
  controls: true,
};

/** Copy only the members the caller actually set, so `undefined` keeps defaults. */
function defined<T extends object>(input: Partial<T> | undefined): Partial<T> {
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Merge caller input over the defaults. The returned groups are concrete, so
 * the render loop and layout never repeat fallbacks for the common case.
 */
export function resolveConfig<N = unknown, L = unknown>(
  input?: GraphConfig<N, L>,
): ResolvedGraphConfig<N, L> {
  // Built with open payload generics: a default is independent of the item,
  // and a caller accessor accepts the caller's own item type.
  const config: ResolvedGraphConfig<any, any> = {
    physics: { ...DEFAULT_GRAPH_CONFIG.physics, ...defined(input?.physics) },
    nodes: { ...DEFAULT_GRAPH_CONFIG.nodes, ...defined(input?.nodes) },
    links: { ...DEFAULT_GRAPH_CONFIG.links, ...defined(input?.links) },
    labels: { ...DEFAULT_GRAPH_CONFIG.labels, ...defined(input?.labels) },
    camera: { ...DEFAULT_GRAPH_CONFIG.camera, ...defined(input?.camera) },
    interaction: { ...DEFAULT_GRAPH_CONFIG.interaction, ...defined(input?.interaction) },
    rendering: { ...DEFAULT_GRAPH_CONFIG.rendering, ...defined(input?.rendering) },
    controls: input?.controls ?? DEFAULT_GRAPH_CONFIG.controls,
  };
  return config;
}
