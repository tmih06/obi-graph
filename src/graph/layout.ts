/**
 * Internal layout: normalizes the public model into render-ready points, owns
 * the d3-force configuration and runs the offscreen warmup.
 *
 * The public model stays generic and sparse; the canvas wants every visual
 * value present. Resolution happens once per data change, never inside a
 * frame loop.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceCenter,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphValue, ResolvedGraphConfig } from "./config.ts";
import { endpointId, type GraphLink, type GraphNode, type NodeShape } from "./model.ts";

/** A node with every value the renderer reads already resolved. */
export interface NodePoint extends SimulationNodeDatum {
  id: string;
  label: string;
  radius: number;
  shape: NodeShape;
  degree: number;
  /** Absent when neither the node nor the config names a color. */
  color?: string;
  /** Many-body strength; already includes the config/default fallback. */
  charge: number;
  hub: boolean;
  data?: unknown;
  /** Internal: the pin came from the caller, so omitting it next time releases it. */
  modelFx?: boolean;
  modelFy?: boolean;
  /** Internal: the caller's last explicit seed, so an unchanged seed keeps the settled spot. */
  seedX?: number;
  seedY?: number;
}

/** A link with every stroke value resolved. Endpoints are ids until d3 resolves them. */
export interface LinkPoint extends SimulationLinkDatum<NodePoint> {
  id: string;
  width: number;
  dashed: boolean;
  distance: number;
  strength: number;
  source: string | number | NodePoint;
  target: string | number | NodePoint;
  /** Absent when neither the link nor the config names a color. */
  color?: string;
  data?: unknown;
}

export interface CanvasGraph {
  nodes: NodePoint[];
  /** Endpoints are ids on the way out; the canvas' simulation resolves them. */
  links: LinkPoint[];
  /**
   * True when topology, physics, radius or charge changed, so the live
   * simulation has to reheat. A pure restyle (labels, colors, widths, dashes)
   * leaves the settled layout alone.
   */
  layoutChanged: boolean;
  /** Structural changes need a full settle; tuning only needs gentle reheating. */
  topologyChanged: boolean;
  /** Internal: the force inputs this graph was built with. */
  forceSignature: number[];
  /** The layout generation this graph was built for; a bump is a reset. */
  layoutVersion: number;
}

export interface LayoutForces {
  charge: ForceManyBody<NodePoint>;
  link: ForceLink<NodePoint, LinkPoint>;
  collide: ForceCollide<NodePoint>;
  x: ForceX<NodePoint>;
  y: ForceY<NodePoint>;
  center: ForceCenter<NodePoint>;
}

/** Golden angle: successive spiral points never share a direction. */
const GOLDEN_ANGLE = 2.399963229728653;
const SPIRAL_STEP = 24;

function resolveValue<T, V>(value: GraphValue<T, V>, item: T): V {
  if (typeof value === "function") return (value as (item: T) => V)(item);
  return value as V;
}

function optionalValue<T, V>(value: GraphValue<T, V> | undefined, item: T): V | undefined {
  if (value === undefined) return undefined;
  return resolveValue(value, item);
}

/** The same forces drive the offscreen warmup and live relaxation. */
export function layoutForces(config: ResolvedGraphConfig<any, any>): LayoutForces {
  const physics = config.physics;
  return {
    charge: forceManyBody<NodePoint>()
      .strength((node) => node.charge)
      .distanceMax(physics.chargeDistance),
    link: forceLink<NodePoint, LinkPoint>()
      .id((node) => node.id)
      .distance((link) => link.distance)
      .strength((link) => link.strength),
    collide: forceCollide<NodePoint>((node) => node.radius + physics.collisionPadding)
      .strength(physics.collisionStrength)
      .iterations(physics.collisionIterations),
    x: forceX<NodePoint>(0).strength(physics.centerStrength),
    y: forceY<NodePoint>(0).strength(physics.centerStrength),
    center: forceCenter<NodePoint>(0, 0),
  };
}

function physicsSignature(config: ResolvedGraphConfig<any, any>): number[] {
  const physics = config.physics;
  return [
    physics.charge,
    physics.chargeDistance,
    physics.linkDistance,
    physics.linkStrength,
    physics.collisionPadding,
    physics.collisionStrength,
    physics.collisionIterations,
    physics.centerStrength,
    physics.alphaDecay,
    physics.velocityDecay,
  ];
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

interface LayoutDelta {
  /** Node/link set, endpoints or counts changed: the warmup must run again. */
  topology: boolean;
  /** Force settings, radius/charge or link distance/strength changed. */
  physics: boolean;
}

/**
 * One pass over the resolved data comparing it with the previous layout.
 * Colors, widths, labels and dashes are deliberately ignored so a pure restyle
 * never reheats a settled simulation.
 */
function layoutDelta(
  previous: CanvasGraph,
  nodes: readonly NodePoint[],
  links: readonly LinkPoint[],
  physics: readonly number[],
  previousNodes: ReadonlyMap<string, NodePoint>,
): LayoutDelta {
  const delta: LayoutDelta = {
    topology: nodes.length !== previous.nodes.length || links.length !== previous.links.length,
    physics: !sameNumbers(previous.forceSignature, physics),
  };
  if (delta.topology) return delta;

  for (const node of nodes) {
    const old = previousNodes.get(node.id);
    if (!old) delta.topology = true;
    else if (
      old.radius !== node.radius ||
      old.charge !== node.charge ||
      old.fx !== node.fx ||
      old.fy !== node.fy ||
      old.x !== node.x ||
      old.y !== node.y
    )
      delta.physics = true;
  }

  // Links usually keep their order; compare by slot and only build an id index
  // when the order actually moved.
  let byId: Map<string, LinkPoint> | null = null;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]!;
    let old: LinkPoint | undefined = previous.links[index];
    if (old?.id !== link.id) {
      byId ??= new Map(previous.links.map((candidate) => [candidate.id, candidate]));
      old = byId.get(link.id);
    }
    if (!old) {
      delta.topology = true;
      continue;
    }
    if (old.distance !== link.distance || old.strength !== link.strength) delta.physics = true;
    if (
      endpointId(old.source) !== endpointId(link.source) ||
      endpointId(old.target) !== endpointId(link.target)
    ) {
      delta.topology = true;
    }
  }
  return delta;
}

/**
 * Normalize caller data into the canvas' layout copy.
 *
 * Caller nodes and links are never mutated. Positions and pins from `previous`
 * survive a refresh, so a restyle or a data edit does not jump the graph; the
 * offscreen warmup only runs for an initial layout or a topology change.
 * Force changes keep the coordinates but reheat the live simulation.
 */
export function makeGraphData<N = unknown, L = unknown>(
  nodes: readonly GraphNode<N>[],
  links: readonly GraphLink<L>[],
  config: ResolvedGraphConfig<N, L>,
  layoutVersion = 0,
  previous?: CanvasGraph,
): CanvasGraph {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.id === "") {
      throw new Error("Graph node is missing a string id.");
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`Duplicate graph node id "${node.id}".`);
    }
    nodeIds.add(node.id);
  }

  const degree = new Map<string, number>();
  const linkIds = new Set<string>();
  const normalizedLinkIds: string[] = [];
  for (const link of links) {
    const source = String(link.source);
    const target = String(link.target);
    if (!nodeIds.has(source)) {
      throw new Error(
        `Graph link "${link.id ?? `${source}--${target}`}" has unknown source "${source}".`,
      );
    }
    if (!nodeIds.has(target)) {
      throw new Error(
        `Graph link "${link.id ?? `${source}--${target}`}" has unknown target "${target}".`,
      );
    }
    if (link.id === "") throw new Error(`Graph link "${source}--${target}" has an empty id.`);
    const id = link.id ?? JSON.stringify([source, target]);
    if (linkIds.has(id)) {
      throw new Error(`Duplicate graph link id "${id}"; give parallel links explicit unique ids.`);
    }
    linkIds.add(id);
    normalizedLinkIds.push(id);
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }

  // A version bump is a reset: positions, local drag pins and warmup start over.
  const keepPrevious = previous !== undefined && previous.layoutVersion === layoutVersion;
  const previousNodes = new Map(
    (keepPrevious ? previous.nodes : []).map((node) => [node.id, node]),
  );
  const resolvedNodes: NodePoint[] = nodes.map((node, index) => {
    const old = previousNodes.get(node.id);
    const angle = index * GOLDEN_ANGLE + layoutVersion * 0.41;
    const distance = SPIRAL_STEP * Math.sqrt(index + 1);
    const radius = node.radius ?? resolveValue(config.nodes.radius, node);
    const charge = node.charge ?? optionalValue(config.nodes.charge, node) ?? config.physics.charge;
    const shape = node.shape ?? resolveValue(config.nodes.shape, node);
    const color = node.color ?? optionalValue(config.nodes.color, node);
    const x = positionFor(node.x, node.fx, old?.x, old?.seedX, Math.cos(angle) * distance);
    const y = positionFor(node.y, node.fy, old?.y, old?.seedY, Math.sin(angle) * distance);
    const fx = resolvePin(node.fx, old?.fx, old?.modelFx ?? false);
    const fy = resolvePin(node.fy, old?.fy, old?.modelFy ?? false);
    return {
      id: node.id,
      label: node.label ?? node.id,
      radius,
      shape,
      degree: degree.get(node.id) ?? 0,
      color,
      charge,
      hub: node.hub === true,
      data: node.data,
      x,
      y,
      vx: old?.vx ?? 0,
      vy: old?.vy ?? 0,
      fx: fx.value,
      fy: fy.value,
      modelFx: fx.pinned,
      modelFy: fy.pinned,
      seedX: node.x,
      seedY: node.y,
    };
  });

  const resolvedLinks: LinkPoint[] = links.map((link, index) => {
    const id = normalizedLinkIds[index]!;
    const distance =
      link.distance ?? optionalValue(config.links.distance, link) ?? config.physics.linkDistance;
    const strength =
      link.strength ?? optionalValue(config.links.strength, link) ?? config.physics.linkStrength;
    return {
      id,
      source: link.source,
      target: link.target,
      width: link.width ?? resolveValue(config.links.width, link),
      dashed: link.dashed ?? resolveValue(config.links.dashed, link),
      distance,
      strength,
      color: link.color ?? optionalValue(config.links.color, link),
      data: link.data,
    };
  });

  const forceSignature = physicsSignature(config);
  const delta =
    previous === undefined || previous.layoutVersion !== layoutVersion
      ? { topology: true, physics: true }
      : layoutDelta(previous, resolvedNodes, resolvedLinks, forceSignature, previousNodes);

  const graph: CanvasGraph = {
    nodes: resolvedNodes,
    links: resolvedLinks,
    // Initial, reset and topology changes reshape the graph; force changes
    // reheat it. A restyle leaves `layoutChanged` false.
    layoutChanged: delta.topology || delta.physics,
    topologyChanged: delta.topology,
    forceSignature,
    layoutVersion,
  };

  // A restyle keeps the settled layout untouched; a fresh graph, a reset or a
  // topology change needs the offscreen solve.
  if (delta.topology) warmUp(graph, config);

  return graph;
}

/**
 * A pin wins. Otherwise a changed explicit seed moves the node, and an
 * unchanged (or absent) seed keeps the position the graph already settled on,
 * so a refresh never makes the map jump.
 */
function positionFor(
  explicit: number | undefined,
  pin: number | null | undefined,
  previous: number | undefined,
  previousSeed: number | undefined,
  fallback: number,
): number {
  if (typeof pin === "number") return pin;
  if (previous !== undefined && explicit === previousSeed) return previous;
  return explicit ?? previous ?? fallback;
}

/**
 * A caller's pin wins outright; `null` releases it. Without a caller value the
 * previous real pin is dropped too (the caller removed the override), while a
 * pin introduced by a local drag survives the refresh.
 */
function resolvePin(
  fromModel: number | null | undefined,
  previous: number | null | undefined,
  previousFromModel: boolean,
): { value: number | null | undefined; pinned: boolean } {
  if (fromModel === null) return { value: null, pinned: false };
  if (typeof fromModel === "number") return { value: fromModel, pinned: true };
  if (previousFromModel) return { value: null, pinned: false };
  return { value: previous === undefined ? null : previous, pinned: false };
}

/** Finite offscreen solve, then zero velocities so the live sim starts calm. */
function warmUp(graph: CanvasGraph, config: ResolvedGraphConfig<any, any>): void {
  if (config.physics.warmupTicks <= 0) return;
  const forces = layoutForces(config);
  const simulation = forceSimulation<NodePoint, LinkPoint>(graph.nodes)
    .force("charge", forces.charge)
    .force("link", forces.link)
    .force("collide", forces.collide)
    .force("x", forces.x)
    .force("y", forces.y)
    .force("center", forces.center)
    .stop();
  forces.link.links(graph.links);
  simulation.alphaDecay(config.physics.alphaDecay).velocityDecay(config.physics.velocityDecay);
  simulation.tick(config.physics.warmupTicks);
  simulation.stop();
  for (const node of graph.nodes) {
    node.vx = 0;
    node.vy = 0;
  }
  // The warmup resolves endpoints to node objects; the canvas owns link
  // resolution itself and compares ids, so hand back the plain endpoints.
  graph.links = graph.links.map((link) => ({
    ...link,
    source: endpointId(link.source),
    target: endpointId(link.target),
  }));
}
