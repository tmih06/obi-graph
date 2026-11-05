/**
 * Force simulation: velocity Verlet integration plus the four forces the
 * canvas needs (link, center, x, y). This replaces `d3-force`, so the package
 * depends on nothing but React.
 *
 * The math is deliberately identical to d3's — same integration order, same
 * alpha decay, same velocity decay, same link bias and jiggle — so graphs laid
 * out by the previous version keep their exact positions. The differences are
 * structural: no timer or event loop (the canvas drives `tick` from its own rAF
 * loop), and no per-tick allocation, since the canvas reuses one simulation
 * across layout changes.
 */

/** What the integration loop needs from a simulation node. */
export interface SimNode {
  index?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** A force is a function of alpha that mutates node velocities in place. */
export interface Force<Node extends SimNode = SimNode> {
  (alpha: number): void;
  initialize?(nodes: Node[], random: () => number): void;
}

/**
 * Setters return the simulation so calls chain, matching the d3 surface the
 * canvas was written against; zero-argument calls read the current value.
 */
export interface Simulation<Node extends SimNode = SimNode> {
  readonly nodes: Node[];
  tick(iterations?: number): void;
  alpha(): number;
  alpha(value: number): Simulation<Node>;
  alphaMin(): number;
  alphaMin(value: number): Simulation<Node>;
  alphaTarget(): number;
  alphaTarget(value: number): Simulation<Node>;
  alphaDecay(): number;
  alphaDecay(value: number): Simulation<Node>;
  velocityDecay(): number;
  velocityDecay(value: number): Simulation<Node>;
  force(name: string): Force<Node> | undefined;
  force(name: string, force: Force<Node> | null): Simulation<Node>;
}

/** d3's default: alpha decays to 0.001 over 300 ticks. */
const DEFAULT_ALPHA_MIN = 0.001;
const DEFAULT_VELOCITY_DECAY = 0.6;
/** Seed radius and golden angle for nodes that arrive without coordinates. */
const INITIAL_RADIUS = 10;
const INITIAL_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Deterministic LCG, the same one d3-force uses. Layouts stay reproducible for
 * a given input, which matters because the demo and the tests compare runs.
 */
function createRandom(): () => number {
  let state = 1;
  return () => (state = (1664525 * state + 1013904223) % 4294967296) / 4294967296;
}

/** Breaks exact ties between coincident nodes, as d3 does. */
function jiggle(random: () => number): number {
  return (random() - 0.5) * 1e-6;
}

/**
 * Creates a simulation over `nodes`. Coordinates and velocities are initialized
 * in place, exactly as d3 does: pinned nodes snap to their pin, missing
 * coordinates land on a golden-angle spiral, missing velocities start at zero.
 */
export function createSimulation<Node extends SimNode>(nodes: Node[]): Simulation<Node> {
  let alpha = 1;
  let alphaMin = DEFAULT_ALPHA_MIN;
  let alphaTarget = 0;
  let alphaDecay = 1 - Math.pow(alphaMin, 1 / 300);
  let velocityDecay = DEFAULT_VELOCITY_DECAY;
  const random = createRandom();
  const forces = new Map<string, Force<Node>>();

  const initializeNodes = () => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      node.index = index;
      if (node.fx != null) node.x = node.fx;
      if (node.fy != null) node.y = node.fy;
      if (
        Number.isNaN(node.x) ||
        Number.isNaN(node.y) ||
        node.x === undefined ||
        node.y === undefined
      ) {
        const radius = INITIAL_RADIUS * Math.sqrt(0.5 + index);
        const angle = index * INITIAL_ANGLE;
        node.x = radius * Math.cos(angle);
        node.y = radius * Math.sin(angle);
      }
      if (
        node.vx === undefined ||
        node.vy === undefined ||
        Number.isNaN(node.vx) ||
        Number.isNaN(node.vy)
      ) {
        node.vx = 0;
        node.vy = 0;
      }
    }
  };

  const initializeForce = (force: Force<Node>): Force<Node> => {
    force.initialize?.(nodes, random);
    return force;
  };

  initializeNodes();

  const simulation: Simulation<Node> = {
    nodes,
    tick(iterations = 1) {
      const count = nodes.length;
      for (let pass = 0; pass < iterations; pass += 1) {
        alpha += (alphaTarget - alpha) * alphaDecay;
        for (const force of forces.values()) force(alpha);
        for (let index = 0; index < count; index += 1) {
          const node = nodes[index]!;
          if (node.fx == null) node.x = (node.x ?? 0) + (node.vx = (node.vx ?? 0) * velocityDecay);
          else {
            node.x = node.fx;
            node.vx = 0;
          }
          if (node.fy == null) node.y = (node.y ?? 0) + (node.vy = (node.vy ?? 0) * velocityDecay);
          else {
            node.y = node.fy;
            node.vy = 0;
          }
        }
      }
    },
    alpha(value?: number) {
      if (value === undefined) return alpha;
      alpha = value;
      return simulation;
    },
    alphaMin(value?: number) {
      if (value === undefined) return alphaMin;
      alphaMin = value;
      return simulation;
    },
    alphaTarget(value?: number) {
      if (value === undefined) return alphaTarget;
      alphaTarget = value;
      return simulation;
    },
    alphaDecay(value?: number) {
      if (value === undefined) return alphaDecay;
      alphaDecay = value;
      return simulation;
    },
    velocityDecay(value?: number) {
      // Stored as a keep-factor so the integration loop multiplies, matching d3.
      if (value === undefined) return 1 - velocityDecay;
      velocityDecay = 1 - value;
      return simulation;
    },
    force(name: string, force?: Force<Node> | null) {
      if (force === undefined) return forces.get(name);
      if (force === null) forces.delete(name);
      else forces.set(name, initializeForce(force));
      return simulation;
    },
  } as Simulation<Node>;

  return simulation;
}

/** The accessor surface shared by the force factories below. */
type Accessor<T, V> = V | ((item: T, index: number, items: T[]) => V);

function resolve<T, V>(value: Accessor<T, V>, item: T, index: number, items: T[]): V {
  return typeof value === "function"
    ? (value as (i: T, n: number, a: T[]) => V)(item, index, items)
    : value;
}

/** A link as the link force needs it: endpoints resolved to node objects. */
export interface SimLink<Node extends SimNode = SimNode> {
  source: Node | string | number;
  target: Node | string | number;
  index?: number;
}

export interface LinkForce<
  Node extends SimNode = SimNode,
  Link extends SimLink<Node> = SimLink<Node>,
> extends Force<Node> {
  links(links?: Link[]): Link[] | LinkForce<Node, Link>;
  id(id: (node: Node, index: number, nodes: Node[]) => string): LinkForce<Node, Link>;
  distance(value: Accessor<Link, number>): LinkForce<Node, Link>;
  strength(value: Accessor<Link, number>): LinkForce<Node, Link>;
}

/**
 * Spring force over links, matching d3's `forceLink`: strength defaults to
 * `1 / min(degree(source), degree(target))`, and the correction is split
 * between the endpoints by degree so hubs move less than leaves.
 */
export function forceLink<Node extends SimNode, Link extends SimLink<Node>>(): LinkForce<
  Node,
  Link
> {
  let nodes: Node[] = [];
  let links: Link[] = [];
  let id: (node: Node, index: number, nodes: Node[]) => string = (node) => {
    if (!("id" in node) || typeof node.id !== "string") {
      throw new Error("forceLink requires an id accessor for nodes without a string id");
    }
    return node.id;
  };
  let strengthOf: Accessor<Link, number> | null = null;
  let distanceOf: Accessor<Link, number> = 30;
  let strengths = new Float64Array(0);
  let distances = new Float64Array(0);
  let bias = new Float64Array(0);
  let degrees = new Int32Array(0);
  let random: () => number = Math.random;

  const find = (byId: Map<string, Node>, nodeId: string): Node => {
    const node = byId.get(nodeId);
    if (!node) throw new Error(`node not found: ${nodeId}`);
    return node;
  };

  const initializeStrength = () => {
    const count = links.length;
    if (strengths.length < count) strengths = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      const link = links[index]!;
      strengths[index] =
        strengthOf === null
          ? 1 /
            Math.min(
              degrees[(link.source as Node).index ?? 0]!,
              degrees[(link.target as Node).index ?? 0]!,
            )
          : +resolve(strengthOf, link, index, links);
    }
  };

  const initializeDistance = () => {
    const count = links.length;
    if (distances.length < count) distances = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      distances[index] = +resolve(distanceOf, links[index]!, index, links);
    }
  };

  const initialize = () => {
    const nodeCount = nodes.length;
    const linkCount = links.length;
    if (degrees.length < nodeCount) degrees = new Int32Array(nodeCount);
    degrees.fill(0, 0, nodeCount);
    const byId = new Map<string, Node>();
    for (let index = 0; index < nodeCount; index += 1) {
      const node = nodes[index]!;
      byId.set(id(node, index, nodes), node);
    }
    if (bias.length < linkCount) bias = new Float64Array(linkCount);
    for (let index = 0; index < linkCount; index += 1) {
      const link = links[index]!;
      link.index = index;
      if (typeof link.source !== "object") link.source = find(byId, String(link.source));
      if (typeof link.target !== "object") link.target = find(byId, String(link.target));
      const source = link.source as Node;
      const target = link.target as Node;
      const sourceIndex = source.index ?? 0;
      const targetIndex = target.index ?? 0;
      degrees[sourceIndex] = (degrees[sourceIndex] ?? 0) + 1;
      degrees[targetIndex] = (degrees[targetIndex] ?? 0) + 1;
    }
    for (let index = 0; index < linkCount; index += 1) {
      const link = links[index]!;
      const source = link.source as Node;
      const target = link.target as Node;
      const sourceDegree = degrees[source.index ?? 0]!;
      bias[index] = sourceDegree / (sourceDegree + degrees[target.index ?? 0]!);
    }
    initializeStrength();
    initializeDistance();
  };

  const force = ((alpha: number) => {
    const count = links.length;
    for (let index = 0; index < count; index += 1) {
      const link = links[index]!;
      const source = link.source as Node;
      const target = link.target as Node;
      const sx = source.x ?? 0;
      const sy = source.y ?? 0;
      const tx = target.x ?? 0;
      const ty = target.y ?? 0;
      let x = tx + (target.vx ?? 0) - sx - (source.vx ?? 0) || jiggle(random);
      let y = ty + (target.vy ?? 0) - sy - (source.vy ?? 0) || jiggle(random);
      const length = Math.sqrt(x * x + y * y);
      const scale = ((length - distances[index]!) / length) * alpha * strengths[index]!;
      x *= scale;
      y *= scale;
      const share = bias[index]!;
      target.vx = (target.vx ?? 0) - x * share;
      target.vy = (target.vy ?? 0) - y * share;
      source.vx = (source.vx ?? 0) + x * (1 - share);
      source.vy = (source.vy ?? 0) + y * (1 - share);
    }
  }) as LinkForce<Node, Link>;

  force.initialize = (input: Node[], source?: () => number) => {
    nodes = input;
    if (source) random = source;
    initialize();
  };
  force.links = (next?: Link[]) => {
    if (next === undefined) return links;
    links = next;
    initialize();
    return force;
  };
  force.id = (next) => {
    id = next;
    initialize();
    return force;
  };
  force.distance = (next) => {
    distanceOf = next;
    initializeDistance();
    return force;
  };
  force.strength = (next) => {
    strengthOf = next;
    initializeStrength();
    return force;
  };
  return force;
}

/**
 * Translates the layout toward its centroid, matching d3's `forceCenter`. The
 * shift is positional (not velocity), so it recenters without adding energy.
 */
export interface CenteringForce<Node extends SimNode = SimNode> extends Force<Node> {
  strength(value: number): CenteringForce<Node>;
}

export function forceCenter<Node extends SimNode>(x = 0, y = 0): CenteringForce<Node> {
  let nodes: Node[] = [];
  let strength = 1;
  const force = (() => {
    const count = nodes.length;
    if (!count) return;
    let sumX = 0;
    let sumY = 0;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index]!;
      sumX += node.x ?? 0;
      sumY += node.y ?? 0;
    }
    const shiftX = (sumX / count - x) * strength;
    const shiftY = (sumY / count - y) * strength;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index]!;
      node.x = (node.x ?? 0) - shiftX;
      node.y = (node.y ?? 0) - shiftY;
    }
  }) as unknown as CenteringForce<Node>;
  force.initialize = (input: Node[]) => {
    nodes = input;
  };
  force.strength = (value: number) => {
    strength = value;
    return force;
  };
  return force;
}

export interface AxisForce<Node extends SimNode = SimNode> extends Force<Node> {
  strength(value: number): AxisForce<Node>;
}

/** One axis of d3's `forceX`/`forceY`: a weak spring toward a target line. */
function forceAxis<Node extends SimNode>(
  axis: "x" | "y",
  target: number,
  strength: number,
): AxisForce<Node> {
  let nodes: Node[] = [];
  let current = strength;
  const force = ((alpha: number) => {
    const count = nodes.length;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index]!;
      if (axis === "x") node.vx = (node.vx ?? 0) + (target - (node.x ?? 0)) * current * alpha;
      else node.vy = (node.vy ?? 0) + (target - (node.y ?? 0)) * current * alpha;
    }
  }) as AxisForce<Node>;
  force.initialize = (input: Node[]) => {
    nodes = input;
  };
  force.strength = (value: number) => {
    current = value;
    return force;
  };
  return force;
}

/** d3's default axis strength. */
const AXIS_STRENGTH = 0.1;

export function forceX<Node extends SimNode>(x = 0, strength = AXIS_STRENGTH): AxisForce<Node> {
  return forceAxis<Node>("x", x, strength);
}

export function forceY<Node extends SimNode>(y = 0, strength = AXIS_STRENGTH): AxisForce<Node> {
  return forceAxis<Node>("y", y, strength);
}
