import { describe, expect, test } from "bun:test";
import {
  gridCollide,
  gridManyBody,
  type GridCollideForce,
  type GridManyBodyForce,
} from "../src/graph/forces.ts";

interface TestNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
  charge?: number;
  radius?: number;
}

const node = (x: number, y: number, extra: Partial<TestNode> = {}): TestNode => ({
  x,
  y,
  vx: 0,
  vy: 0,
  ...extra,
});

/**
 * Build a force, bind it to the nodes and apply one tick. d3 calls this
 * sequence `simulation.nodes(...)` then `simulation.tick()`.
 */
function run(
  force: GridManyBodyForce | GridCollideForce,
  nodes: TestNode[],
  alpha = 1,
): TestNode[] {
  force.initialize(nodes);
  force(alpha);
  return nodes;
}

const repel = (nodes: TestNode[], distanceMax = 300) =>
  run(
    gridManyBody()
      .strength((n: TestNode) => n.charge ?? -30)
      .distanceMax(distanceMax),
    nodes,
  );

const collide = (nodes: TestNode[], iterations = 1) =>
  run(
    gridCollide()
      .radius((n: TestNode) => n.radius ?? 1)
      .iterations(iterations),
    nodes,
  );

/** Straight pairwise repulsion: the exact answer the quadtree approximates. */
function bruteForce(nodes: TestNode[], strength: number, distanceMax: number): number[][] {
  const max2 = distanceMax * distanceMax;
  return nodes.map((a, index) => {
    let fx = 0;
    let fy = 0;
    for (let other = 0; other < nodes.length; other += 1) {
      if (other === index) continue;
      const b = nodes[other]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance2 = dx * dx + dy * dy;
      if (distance2 === 0 || distance2 > max2) continue;
      fx += (dx * strength) / distance2;
      fy += (dy * strength) / distance2;
    }
    return [fx, fy];
  });
}

describe("gridManyBody", () => {
  test("repels two nodes exactly like pairwise physics", () => {
    const nodes = repel([node(0, 0, { charge: -60 }), node(100, 0, { charge: -60 })]);
    expect(nodes[0]!.vx).toBeCloseTo(-0.6, 6);
    expect(nodes[0]!.vy).toBeCloseTo(0, 6);
    expect(nodes[1]!.vx).toBeCloseTo(0.6, 6);
  });

  test("truncates at distanceMax, like d3", () => {
    const nodes = repel([node(0, 0, { charge: -60 }), node(500, 0, { charge: -60 })]);
    expect(nodes[0]!.vx).toBe(0);
    expect(nodes[1]!.vx).toBe(0);
  });

  test("agrees with brute force on scattered nodes", () => {
    const nodes = repel([
      node(11.1, -259.4, { charge: -60 }),
      node(-275.8, -283.0, { charge: -60 }),
      node(-172.2, 343.3, { charge: -60 }),
      node(-393.0, 311.4, { charge: -60 }),
      node(-289.9, -219.4, { charge: -60 }),
      node(-176.2, 235.1, { charge: -60 }),
      node(-73.0, 35.4, { charge: -60 }),
    ]);
    const expected = bruteForce(nodes, -60, 300);
    let error = 0;
    let magnitude = 0;
    nodes.forEach((n, index) => {
      error += Math.hypot(n.vx - expected[index]![0]!, n.vy - expected[index]![1]!);
      magnitude += Math.hypot(expected[index]![0]!, expected[index]![1]!);
    });
    // Barnes-Hut approximates far clusters rather than summing them exactly.
    expect(error / magnitude).toBeLessThan(0.35);
  });

  test("separates coincident nodes instead of producing a zero force", () => {
    const nodes = repel([node(4, 4, { charge: -60 }), node(4, 4, { charge: -60 })]);
    expect(Number.isFinite(nodes[0]!.vx)).toBe(true);
    expect(Number.isFinite(nodes[1]!.vx)).toBe(true);
    expect(nodes[0]!.vx).not.toBe(0);
  });

  test("scales the force by alpha", () => {
    const full = repel([node(0, 0, { charge: -60 }), node(50, 0, { charge: -60 })]);
    const half = run(
      gridManyBody().strength((n: TestNode) => n.charge ?? -30),
      [node(0, 0, { charge: -60 }), node(50, 0, { charge: -60 })],
      0.5,
    );
    expect(half[0]!.vx).toBeCloseTo(full[0]!.vx / 2, 6);
  });

  test("a node feels its neighbours' strengths, not only its own", () => {
    // d3 semantics: each node accumulates the strength of every other body.
    const nodes = repel([
      node(0, 0, { charge: -100 }),
      node(20, 0, { charge: -100 }),
      node(0, 20, { charge: -10 }),
    ]);
    // Node 2 sits at (0, 20), so node 1 at (20, 0) repels it to the left.
    expect(nodes[2]!.vx).toBeCloseTo((20 * -100) / 800, 6);
    // Node 0 is pushed left by node 1 and down by node 2's weak charge.
    expect(nodes[0]!.vx).toBeCloseTo((20 * -100) / 400, 6);
    expect(nodes[0]!.vy).toBeCloseTo((20 * -10) / 400, 6);
  });
});

describe("gridCollide", () => {
  test("pushes overlapping nodes apart, the heavier node less", () => {
    const nodes = collide([node(0, 0, { radius: 10 }), node(5, 0, { radius: 5 })]);
    expect(nodes[0]!.vx).toBeLessThan(0);
    expect(nodes[1]!.vx).toBeGreaterThan(0);
    expect(Math.abs(nodes[1]!.vx)).toBeGreaterThan(Math.abs(nodes[0]!.vx));
  });

  test("ignores separated nodes", () => {
    const nodes = collide([node(0, 0, { radius: 5 }), node(50, 0, { radius: 5 })]);
    expect(nodes[0]!.vx).toBe(0);
    expect(nodes[1]!.vx).toBe(0);
  });

  test("resolves overlaps across grid cell boundaries", () => {
    // Large radii spanning several cells: a 3x3 scan must still find each pair.
    const nodes = collide(
      Array.from({ length: 40 }, (_, index) =>
        node((index % 8) * 6, Math.floor(index / 8) * 6, { radius: 4 }),
      ),
    );
    expect(nodes.some((n) => n.vx !== 0 || n.vy !== 0)).toBe(true);
    for (const n of nodes) {
      expect(Number.isFinite(n.vx)).toBe(true);
      expect(Number.isFinite(n.vy)).toBe(true);
    }
  });
});
