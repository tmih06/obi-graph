import { describe, expect, test } from "bun:test";
import { buildAnimalGraph, sampleAnimalGraph } from "../src/demo/demo-graph.ts";

const graph = buildAnimalGraph();

/** Walk every node from the kingdom root; returns how many are reachable. */
function reachable(sampled: ReturnType<typeof sampleAnimalGraph>): number {
  const adjacency = new Map<string, string[]>();
  for (const link of sampled.links) {
    if (!adjacency.has(link.source)) adjacency.set(link.source, []);
    if (!adjacency.has(link.target)) adjacency.set(link.target, []);
    adjacency.get(link.source)!.push(link.target);
    adjacency.get(link.target)!.push(link.source);
  }
  const root = sampled.nodes.find((node) => node.data?.rank === "kingdom");
  if (!root) return 0;
  const seen = new Set([root.id]);
  const queue = [root.id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const neighbour of adjacency.get(current) ?? []) {
      if (seen.has(neighbour)) continue;
      seen.add(neighbour);
      queue.push(neighbour);
    }
  }
  return seen.size;
}

describe("sampleAnimalGraph", () => {
  test("100% is the untouched graph", () => {
    expect(sampleAnimalGraph(graph, 100)).toBe(graph);
  });

  test("the kept count follows the percentage", () => {
    const anchors = graph.nodes.filter(
      (node) => node.hub || node.data?.rank === "kingdom" || node.data?.rank === "class",
    ).length;
    for (const percent of [10, 25, 50]) {
      const sampled = sampleAnimalGraph(graph, percent);
      const expected = anchors + Math.round(((graph.nodes.length - anchors) * percent) / 100);
      expect(sampled.nodes.length).toBe(expected);
    }
  });

  test("never emits a link to a dropped node", () => {
    for (const percent of [1, 7, 33, 66, 99]) {
      const sampled = sampleAnimalGraph(graph, percent);
      const ids = new Set(sampled.nodes.map((node) => node.id));
      for (const link of sampled.links) {
        expect(ids.has(link.source)).toBe(true);
        expect(ids.has(link.target)).toBe(true);
      }
    }
  });

  test("stays one connected tree at every density", () => {
    // Sampling a tree by node alone orphans subtrees; every survivor has to be
    // re-attached to its nearest kept ancestor.
    for (const percent of [1, 5, 10, 25, 50, 90, 99]) {
      const sampled = sampleAnimalGraph(graph, percent);
      expect(reachable(sampled)).toBe(sampled.nodes.length);
    }
  });

  test("keeps the six clusters labelled", () => {
    const sampled = sampleAnimalGraph(graph, 1);
    const hubs = sampled.nodes.filter((node) => node.hub);
    // Animalia plus one anchor per sampled class.
    expect(hubs.length).toBeGreaterThanOrEqual(7);
  });

  test("subsets nest, so lowering the slider only removes nodes", () => {
    const small = new Set(sampleAnimalGraph(graph, 25).nodes.map((node) => node.id));
    const large = new Set(sampleAnimalGraph(graph, 50).nodes.map((node) => node.id));
    for (const id of small) expect(large.has(id)).toBe(true);
  });

  test("is deterministic", () => {
    const first = sampleAnimalGraph(graph, 37).nodes.map((node) => node.id);
    const second = sampleAnimalGraph(graph, 37).nodes.map((node) => node.id);
    expect(first).toEqual(second);
  });
});
