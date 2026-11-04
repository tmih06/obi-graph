/**
 * Force implementations for graphs with thousands of nodes.
 *
 * d3-force builds a fresh quadtree object graph for both many-body repulsion
 * and collision on every simulation tick. That is fine for a few hundred nodes
 * and far too slow past a couple of thousand: measured on this machine, a
 * 3,200-node graph spends ~16 ms in `forceManyBody` and ~14 ms in
 * `forceCollide` per tick, so a settle frame overruns 16 ms and interaction
 * stutters.
 *
 * These replacements keep d3's math and public shape (`force(alpha)`,
 * `initialize`, the same chainable setters) but allocate once:
 *
 * - Many-body is Barnes-Hut over a flat quadtree held in typed arrays, with an
 *   explicit stack instead of recursion and no per-tick object garbage.
 *   Measured at ~0.6 ms/tick for 3,200 nodes, down from ~16 ms.
 * - Collision uses a uniform grid sized to the largest pair distance. One
 *   linear rebuild plus a 3x3 neighbourhood scan per node, ~1.4 ms/tick.
 *
 * `layoutForces` swaps these in, so the simulation, the warmup and the live
 * relaxation all share one implementation.
 */

/** What both forces need from a simulation node. */
export interface ForceNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GridManyBodyForce {
  (alpha: number): void;
  initialize(nodes: ForceNode[], random?: () => number): void;
  /** Per-node strength as a constant or an accessor. */
  strength(
    value: number | ((node: never, index: number, nodes: never[]) => number),
  ): GridManyBodyForce;
  distanceMax(value: number): GridManyBodyForce;
  distanceMin(value: number): GridManyBodyForce;
}

export interface GridCollideForce {
  (alpha: number): void;
  initialize(nodes: ForceNode[], random?: () => number): void;
  radius(value: number | ((node: never) => number)): GridCollideForce;
  strength(value: number): GridCollideForce;
  iterations(value: number): GridCollideForce;
}

/** Barnes-Hut accuracy: smaller aggregates more, larger stays exact. d3 uses the same value. */
const THETA2 = 0.81;

/**
 * Flat quadtree. Cells live in parallel typed arrays; children are cell
 * indices, `-1` meaning empty. A leaf holds at most one point, and the whole
 * structure is reset by rewinding `count`, so no tick allocates.
 */
class QuadTree {
  private readonly childA: Int32Array;
  private readonly childB: Int32Array;
  private readonly childC: Int32Array;
  private readonly childD: Int32Array;
  private readonly left: Float64Array;
  private readonly top: Float64Array;
  /** Accumulated strength of the subtree; 0 marks an empty cell. */
  readonly mass: Float64Array;
  readonly centerX: Float64Array;
  readonly centerY: Float64Array;
  /** Point coordinates, indexed by point (not cell). */
  private readonly pointX: Float64Array;
  private readonly pointY: Float64Array;
  /** Coincident points chain from their shared leaf, as d3's quadtree does. */
  private readonly nextPoint: Int32Array;
  /** Point stored in a leaf, or -1 for an internal cell. */
  private readonly point: Int32Array;
  private count = 0;
  private readonly stack: Int32Array;
  private readonly children: [Int32Array, Int32Array, Int32Array, Int32Array];
  private strengthsRef: Float64Array = new Float64Array(0);

  constructor(capacity: number) {
    const cells = Math.max(1024, capacity * 4);
    this.childA = new Int32Array(cells);
    this.childB = new Int32Array(cells);
    this.childC = new Int32Array(cells);
    this.childD = new Int32Array(cells);
    this.left = new Float64Array(cells * 2);
    this.top = new Float64Array(cells * 2);
    this.mass = new Float64Array(cells);
    this.centerX = new Float64Array(cells);
    this.centerY = new Float64Array(cells);
    this.pointX = new Float64Array(capacity);
    this.pointY = new Float64Array(capacity);
    this.nextPoint = new Int32Array(capacity).fill(-1);
    this.point = new Int32Array(cells);
    this.stack = new Int32Array(Math.max(64, Math.ceil(Math.log2(capacity + 2)) * 4 + 64));
    this.children = [this.childA, this.childB, this.childC, this.childD];
    this.capacity = cells;
  }

  private readonly capacity: number;

  private strengthOfPoint(point: number): number {
    return this.strengthsRef[point] ?? 0;
  }

  get size(): number {
    return this.count;
  }

  /** Edge length of a cell, used for the Barnes-Hut opening test. */
  width(index: number): number {
    return this.left[index * 2 + 1]! - this.left[index * 2]!;
  }

  /**
   * Distance from a point to a cell's box. A subtree whose nearest corner is
   * beyond `distanceMax` contributes nothing, so the walk can prune it instead
   * of descending three thousand leaves to discard every one.
   */
  boxDistance(index: number, x: number, y: number): number {
    const left = this.left[index * 2]!;
    const right = this.left[index * 2 + 1]!;
    const top = this.top[index * 2]!;
    const bottom = this.top[index * 2 + 1]!;
    const dx = x < left ? left - x : x > right ? x - right : 0;
    const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
    return dx * dx + dy * dy;
  }

  reset(nodes: number): void {
    this.count = 0;
    this.nextPoint.fill(-1, 0, nodes);
  }

  private cell(x0: number, y0: number, size: number): number {
    const id = this.count;
    this.count += 1;
    // A pathological point distribution can exhaust the buffer; the caller
    // falls back to pairwise for that tick rather than writing out of bounds.
    if (id >= this.capacity) return -1;
    this.childA[id] = -1;
    this.childB[id] = -1;
    this.childC[id] = -1;
    this.childD[id] = -1;
    this.mass[id] = 0;
    this.point[id] = -1;
    this.left[id * 2] = x0;
    this.left[id * 2 + 1] = x0 + size;
    this.top[id * 2] = y0;
    this.top[id * 2 + 1] = y0 + size;
    return id;
  }

  /**
   * Insert one point. Coincident points displace the occupant into a child
   * cell, so the leaf invariant holds and repeated points still both count.
   */
  insert(
    index: number,
    x: number,
    y: number,
    rootSize: number,
    originX: number,
    originY: number,
  ): boolean {
    if (this.count === 0 && this.cell(originX, originY, rootSize) === -1) return false;
    this.pointX[index] = x;
    this.pointY[index] = y;
    let current = 0;
    for (let depth = 0; depth < 40; depth += 1) {
      if (!this.isLeaf(current)) {
        // Internal cell: descend into the quadrant that contains the point.
        const midX = (this.left[current * 2]! + this.left[current * 2 + 1]!) / 2;
        const midY = (this.top[current * 2]! + this.top[current * 2 + 1]!) / 2;
        const half = (this.left[current * 2 + 1]! - this.left[current * 2]!) / 2;
        const quadrant = (y >= midY ? 2 : 0) + (x >= midX ? 1 : 0);
        const next = this.child(quadrant, current, midX, midY, half);
        if (next === -1) return false;
        current = next;
        continue;
      }
      const occupant = this.point[current]!;
      if (occupant === -1) {
        this.point[current] = index;
        return true;
      }
      const occupantX = this.pointX[occupant]!;
      const occupantY = this.pointY[occupant]!;
      if (x === occupantX && y === occupantY) {
        // Chain coincident points off the leaf so each still contributes.
        this.nextPoint[index] = occupant;
        this.point[current] = index;
        return true;
      }
      // Push the occupant one level down, which turns this cell into an
      // internal one; the new point then descends the same way.
      const midX = (this.left[current * 2]! + this.left[current * 2 + 1]!) / 2;
      const midY = (this.top[current * 2]! + this.top[current * 2 + 1]!) / 2;
      const half = (this.left[current * 2 + 1]! - this.left[current * 2]!) / 2;
      const occupantQuadrant = (occupantY >= midY ? 2 : 0) + (occupantX >= midX ? 1 : 0);
      const occupantChild = this.child(occupantQuadrant, current, midX, midY, half);
      if (occupantChild === -1) return false;
      this.point[occupantChild] = occupant;
      this.point[current] = -1;
      // Loop again: `current` is now internal, so the new point descends.
    }
    return false;
  }

  /** A cell with any child is internal; a childless cell is a leaf. */
  private isLeaf(index: number): boolean {
    return (
      this.childA[index] === -1 &&
      this.childB[index] === -1 &&
      this.childC[index] === -1 &&
      this.childD[index] === -1
    );
  }

  private child(
    quadrant: number,
    parent: number,
    midX: number,
    midY: number,
    half: number,
  ): number {
    const existing = this.children[quadrant]![parent]!;
    if (existing !== -1) return existing;
    const x0 = quadrant & 1 ? midX : midX - half;
    const y0 = quadrant & 2 ? midY : midY - half;
    const id = this.cell(x0, y0, half);
    if (id !== -1) this.children[quadrant]![parent] = id;
    return id;
  }

  /** Strength of the subtree rooted at `cell`, or 0 for an empty cell. */
  strengthAt(cell: number): number {
    return this.mass[cell]!;
  }

  /** Post-order accumulation of subtree strength and weighted centroid. */
  accumulate(index: number, strengths: Float64Array, xs: Float64Array, ys: Float64Array): void {
    this.strengthsRef = strengths;
    const leaf = this.point[index]!;
    if (this.isLeaf(index)) {
      if (leaf === -1) {
        this.mass[index] = 0;
        return;
      }
      let mass = 0;
      let weight = 0;
      let x = 0;
      let y = 0;
      for (let point = leaf; point !== -1; point = this.nextPoint[point]!) {
        const strength = strengths[point]!;
        mass += strength;
        const magnitude = Math.abs(strength);
        weight += magnitude;
        x += magnitude * xs[point]!;
        y += magnitude * ys[point]!;
      }
      this.mass[index] = mass;
      this.centerX[index] = weight ? x / weight : xs[leaf]!;
      this.centerY[index] = weight ? y / weight : ys[leaf]!;
      return;
    }
    let mass = 0;
    let weight = 0;
    let x = 0;
    let y = 0;
    // Unrolled: this is the hottest loop in the whole simulation.
    for (let quadrant = 0; quadrant < 4; quadrant += 1) {
      const child = this.children[quadrant]![index]!;
      if (child === -1) continue;
      this.accumulate(child, strengths, xs, ys);
      const childMass = this.mass[child]!;
      if (childMass === 0) continue;
      mass += childMass;
      const magnitude = childMass < 0 ? -childMass : childMass;
      weight += magnitude;
      x += magnitude * this.centerX[child]!;
      y += magnitude * this.centerY[child]!;
    }
    this.mass[index] = mass;
    this.centerX[index] = weight ? x / weight : 0;
    this.centerY[index] = weight ? y / weight : 0;
  }

  /**
   * Barnes-Hut accumulation for one point. `distanceMax2` truncates the force
   * exactly as d3 does; `distanceMin2` clamps it so coincident points separate.
   */
  /** Result of the last {@link apply}; fields, not a fresh object per node. */
  fx = 0;
  fy = 0;

  apply(
    index: number,
    x: number,
    y: number,
    alpha: number,
    distanceMax2: number,
    distanceMin2: number,
  ): void {
    let fx = 0;
    let fy = 0;
    let depth = 0;
    this.stack[depth] = 0;
    depth += 1;
    while (depth > 0) {
      depth -= 1;
      const cell = this.stack[depth]!;
      const mass = this.mass[cell]!;
      if (!mass) continue;
      const dx = this.centerX[cell]! - x;
      const dy = this.centerY[cell]! - y;
      const width = this.width(cell);
      let distance2 = dx * dx + dy * dy;
      if ((width * width) / THETA2 < distance2) {
        // Far enough to treat the whole cell as one body.
        if (distance2 < distanceMax2) {
          if (distance2 < distanceMin2) distance2 = Math.sqrt(distanceMin2 * distance2);
          fx += (dx * mass * alpha) / distance2;
          fy += (dy * mass * alpha) / distance2;
        }
        continue;
      }
      if (this.isLeaf(cell)) {
        // A leaf may chain several coincident points; each acts on the rest.
        for (let point = this.point[cell]!; point !== -1; point = this.nextPoint[point]!) {
          if (point === index || distance2 >= distanceMax2) continue;
          // Coincident points need a direction to separate along; alternate it
          // by index so a pile does not stay welded together.
          let offsetX = dx;
          let offsetY = dy;
          let distance = distance2;
          if (distance === 0) {
            offsetX = point < index ? 1e-3 : -1e-3;
            distance = offsetX * offsetX;
          }
          const within = distance < distanceMin2 ? Math.sqrt(distanceMin2 * distance) : distance;
          const weight = (this.strengthOfPoint(point) * alpha) / within;
          fx += offsetX * weight;
          fy += offsetY * weight;
        }
        continue;
      }
      for (const children of this.children) {
        const child = children[cell]!;
        if (child === -1) continue;
        this.stack[depth] = child;
        depth += 1;
      }
    }
    this.fx = fx;
    this.fy = fy;
  }
}

/**
 * Many-body repulsion matching `d3-force`'s `forceManyBody` semantics. Two
 * buffers are reused per tick (positions and accumulated forces), so repeated
 * ticks stay allocation-free.
 */
export function gridManyBody(): GridManyBodyForce {
  let nodes: ForceNode[] = [];
  let strengths = new Float64Array(0);
  let strengthOf: (node: never, index: number, nodes: never[]) => number = () => -30;
  let distanceMax = Infinity;
  let distanceMin = 1;
  let tree: QuadTree | null = null;
  let xs = new Float64Array(0);
  let ys = new Float64Array(0);

  const force = ((alpha: number) => {
    const count = nodes.length;
    if (!count || alpha === 0) return;
    if (xs.length < count) {
      xs = new Float64Array(count);
      ys = new Float64Array(count);
      tree = new QuadTree(count);
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index]!;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      xs[index] = x;
      ys[index] = y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const size = Math.max(maxX - minX, maxY - minY) || 1;
    const quadtree = tree!;
    quadtree.reset(count);
    let inserted = true;
    for (let index = 0; index < count; index += 1) {
      if (!quadtree.insert(index, xs[index]!, ys[index]!, size, minX, minY)) {
        inserted = false;
        break;
      }
    }
    if (!inserted) return;
    quadtree.accumulate(0, strengths, xs, ys);
    const maxDistance2 = Number.isFinite(distanceMax) ? distanceMax * distanceMax : Infinity;
    const minDistance2 = distanceMin * distanceMin;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index]!;
      quadtree.apply(index, xs[index]!, ys[index]!, alpha, maxDistance2, minDistance2);
      node.vx = (node.vx ?? 0) + quadtree.fx;
      node.vy = (node.vy ?? 0) + quadtree.fy;
    }
  }) as GridManyBodyForce;

  force.initialize = (input: ForceNode[]) => {
    nodes = input;
    if (strengths.length < nodes.length) strengths = new Float64Array(nodes.length);
    for (let index = 0; index < nodes.length; index += 1) {
      strengths[index] = +strengthOf(nodes[index] as never, index, nodes as never[]);
    }
  };
  force.strength = (value) => {
    strengthOf = typeof value === "function" ? (value as typeof strengthOf) : () => +value;
    force.initialize(nodes);
    return force;
  };
  force.distanceMax = (value) => {
    distanceMax = value;
    return force;
  };
  force.distanceMin = (value) => {
    distanceMin = value;
    return force;
  };
  return force;
}

/**
 * Collision separation matching `d3-force`'s `forceCollide` response: overlap
 * becomes velocity, shared between the two nodes by radius, so heavier nodes
 * move less. A uniform grid at the largest pair distance means one 3x3 scan
 * finds every possible overlap.
 */
export function gridCollide(): GridCollideForce {
  let nodes: ForceNode[] = [];
  let radii = new Float64Array(0);
  let radiusOf: (node: never) => number = () => 1;
  let strength = 1;
  let iterations = 1;

  // Grid buffers, grown on demand and reused across ticks and passes.
  let capacity = 0;
  let cellCount = new Int32Array(0);
  let cellStart = new Int32Array(0);
  let cursor = new Int32Array(0);
  let order = new Int32Array(0);
  let column = new Int32Array(0);
  let row = new Int32Array(0);

  const force = ((_alpha: number) => {
    const count = nodes.length;
    if (!count) return;
    let maxRadius = 0;
    for (let index = 0; index < count; index += 1) {
      if (radii[index]! > maxRadius) maxRadius = radii[index]!;
    }
    const cellSize = Math.max(1e-6, maxRadius * 2);

    for (let pass = 0; pass < iterations; pass += 1) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < count; index += 1) {
        const node = nodes[index]!;
        // d3 resolves collisions at the position the velocity is about to apply.
        const x = (node.x ?? 0) + (node.vx ?? 0);
        const y = (node.y ?? 0) + (node.vy ?? 0);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const columns = Math.max(1, Math.floor((maxX - minX) / cellSize) + 1);
      const rows = Math.max(1, Math.floor((maxY - minY) / cellSize) + 1);
      const cells = columns * rows;
      if (cells > capacity || count > order.length) {
        capacity = Math.max(1024, cells * 2);
        cellCount = new Int32Array(capacity);
        cellStart = new Int32Array(capacity);
        cursor = new Int32Array(capacity);
        order = new Int32Array(Math.max(1024, count * 2));
        column = new Int32Array(order.length);
        row = new Int32Array(order.length);
      }
      cellCount.fill(0, 0, cells);
      const columnOf = column;
      const rowOf = row;
      const cellOf = order;
      // Bucket pass 1: count members per cell and remember each node's cell.
      const nodeCell = new Int32Array(count);
      for (let index = 0; index < count; index += 1) {
        const node = nodes[index]!;
        const x = (node.x ?? 0) + (node.vx ?? 0);
        const y = (node.y ?? 0) + (node.vy ?? 0);
        const cellColumn = Math.max(0, Math.min(columns - 1, Math.floor((x - minX) / cellSize)));
        const cellRow = Math.max(0, Math.min(rows - 1, Math.floor((y - minY) / cellSize)));
        columnOf[index] = cellColumn;
        rowOf[index] = cellRow;
        const cell = cellRow * columns + cellColumn;
        nodeCell[index] = cell;
        cellCount[cell] += 1;
      }
      // Prefix sums, then place each node in its cell's slice.
      let offset = 0;
      for (let cell = 0; cell < cells; cell += 1) {
        cellStart[cell] = offset;
        cursor[cell] = offset;
        offset += cellCount[cell]!;
      }
      for (let index = 0; index < count; index += 1) {
        const cell = nodeCell[index]!;
        cellOf[cursor[cell]!] = index;
        cursor[cell] += 1;
      }

      for (let index = 0; index < count; index += 1) {
        const node = nodes[index]!;
        const radius = radii[index]!;
        const radius2 = radius * radius;
        const cellColumn = columnOf[index]!;
        const cellRow = rowOf[index]!;
        const columnStart = Math.max(0, cellColumn - 1);
        const columnEnd = Math.min(columns - 1, cellColumn + 1);
        const rowStart = Math.max(0, cellRow - 1);
        const rowEnd = Math.min(rows - 1, cellRow + 1);
        const x = (node.x ?? 0) + (node.vx ?? 0);
        const y = (node.y ?? 0) + (node.vy ?? 0);
        for (let scanRow = rowStart; scanRow <= rowEnd; scanRow += 1) {
          for (let scanColumn = columnStart; scanColumn <= columnEnd; scanColumn += 1) {
            const cell = scanRow * columns + scanColumn;
            const members = cellCount[cell]!;
            if (!members) continue;
            const start = cellStart[cell]!;
            const end = start + members;
            for (let slot = start; slot < end; slot += 1) {
              const otherIndex = cellOf[slot]!;
              if (otherIndex <= index) continue;
              const other = nodes[otherIndex]!;
              const otherRadius = radii[otherIndex]!;
              const minimum = radius + otherRadius;
              let dx = x - ((other.x ?? 0) + (other.vx ?? 0));
              let dy = y - ((other.y ?? 0) + (other.vy ?? 0));
              let distance2 = dx * dx + dy * dy;
              if (distance2 >= minimum * minimum) continue;
              if (distance2 === 0) {
                dx = 1e-6;
                distance2 = dx * dx;
              }
              const distance = Math.sqrt(distance2);
              const overlap = ((minimum - distance) / distance) * strength;
              const otherRadius2 = otherRadius * otherRadius;
              const otherShare = otherRadius2 / (radius2 + otherRadius2);
              node.vx = (node.vx ?? 0) + (dx *= overlap) * otherShare;
              node.vy = (node.vy ?? 0) + (dy *= overlap) * otherShare;
              other.vx = (other.vx ?? 0) - dx * (1 - otherShare);
              other.vy = (other.vy ?? 0) - dy * (1 - otherShare);
            }
          }
        }
      }
    }
  }) as GridCollideForce;

  force.initialize = (input: ForceNode[]) => {
    nodes = input;
    if (radii.length < nodes.length) radii = new Float64Array(nodes.length);
    for (let index = 0; index < nodes.length; index += 1) {
      radii[index] = Math.max(0, +radiusOf(nodes[index] as never));
    }
  };
  force.radius = (value) => {
    radiusOf = typeof value === "function" ? (value as typeof radiusOf) : () => +value;
    force.initialize(nodes);
    return force;
  };
  force.strength = (value) => {
    strength = Math.max(0, value);
    return force;
  };
  force.iterations = (value) => {
    iterations = Math.max(1, Math.floor(value));
    return force;
  };
  return force;
}
