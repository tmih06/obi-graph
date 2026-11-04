import { describe, expect, test } from "bun:test";
import { resolveConfig, type GraphConfig } from "../src/graph/config.ts";
import { makeGraphData, type CanvasGraph } from "../src/graph/layout.ts";
import type { GraphLink, GraphNode } from "../src/graph/model.ts";

const nodes: GraphNode[] = [{ id: "a", label: "Alpha", hub: true }, { id: "b" }, { id: "c" }];
const links: GraphLink[] = [
  { id: "ab", source: "a", target: "b" },
  { id: "bc", source: "b", target: "c" },
];

const build = (config: GraphConfig = {}, previous?: CanvasGraph) =>
  makeGraphData(nodes, links, resolveConfig(config), 0, previous);

describe("makeGraphData normalization", () => {
  test("counts both ends of links and falls back to ids for omitted labels", () => {
    const graph = build();
    expect(graph.nodes.map((node) => [node.label, node.degree])).toEqual([
      ["Alpha", 1],
      ["b", 2],
      ["c", 1],
    ]);
  });

  test("never mutates caller nodes or links", () => {
    const sourceNodes: GraphNode[] = [{ id: "a", x: 4 }, { id: "b" }];
    const sourceLinks: GraphLink[] = [{ id: "ab", source: "a", target: "b" }];
    const nodeSnapshot = structuredClone(sourceNodes);
    const linkSnapshot = structuredClone(sourceLinks);

    const graph = makeGraphData(sourceNodes, sourceLinks, resolveConfig());
    graph.nodes[0]!.x = 999;
    graph.nodes[0]!.fx = 5;
    graph.links[0]!.source = "mutated";

    expect(sourceNodes).toEqual(nodeSnapshot);
    expect(sourceLinks).toEqual(linkSnapshot);
  });

  test("rejects duplicate ids, empty ids and unknown endpoints", () => {
    const config = resolveConfig();
    expect(() => makeGraphData([{ id: "a" }, { id: "a" }], [], config)).toThrow(
      'Duplicate graph node id "a"',
    );
    expect(() => makeGraphData([{ id: "" }], [], config)).toThrow("missing a string id");
    expect(() =>
      makeGraphData([{ id: "a" }], [{ id: "l", source: "a", target: "ghost" }], config),
    ).toThrow('unknown target "ghost"');
    expect(() =>
      makeGraphData(
        [{ id: "a" }, { id: "b" }],
        [
          { id: "l", source: "a", target: "b" },
          { id: "l", source: "b", target: "a" },
        ],
        config,
      ),
    ).toThrow('Duplicate graph link id "l"');
  });

  test("unnamed links do not collide when ids contain endpoint delimiters", () => {
    const graph = makeGraphData(
      ["a--b", "c", "a", "b--c"].map((id) => ({ id })),
      [
        { source: "a--b", target: "c" },
        { source: "a", target: "b--c" },
      ],
      resolveConfig(),
    );
    expect(graph.links[0]!.id).not.toBe(graph.links[1]!.id);
  });
});

describe("value precedence", () => {
  test("explicit item properties beat config accessors", () => {
    const graph = makeGraphData(
      [{ id: "a", radius: 12, color: "#ff0000", shape: "square", charge: -600 }, { id: "b" }],
      [
        {
          id: "ab",
          source: "a",
          target: "b",
          width: 3,
          dashed: true,
          color: "#00ff00",
          distance: 40,
          strength: 0.9,
        },
      ],
      resolveConfig({
        nodes: {
          radius: () => 7,
          color: () => "#111111",
          shape: () => "triangle",
          charge: () => -100,
        },
        links: {
          width: () => 2,
          dashed: () => false,
          color: () => "#222222",
          distance: () => 10,
          strength: () => 0.1,
        },
      }),
    );
    expect(graph.nodes[0]).toMatchObject({
      radius: 12,
      color: "#ff0000",
      shape: "square",
      charge: -600,
    });
    expect(graph.nodes[1]).toMatchObject({
      radius: 7,
      color: "#111111",
      shape: "triangle",
      charge: -100,
    });
    expect(graph.links[0]).toMatchObject({
      width: 3,
      dashed: true,
      color: "#00ff00",
      distance: 40,
      strength: 0.9,
    });
  });

  test("config accessors beat physics fallbacks, which beat defaults", () => {
    const configured = build({
      physics: { charge: -300, linkDistance: 120, linkStrength: 0.5 },
      nodes: { radius: (node) => (node.id === "a" ? 9 : 4) },
      links: { distance: (link) => (link.id === "ab" ? 60 : 70), strength: 0.42 },
    });
    expect(configured.nodes.map((node) => node.charge)).toEqual([-300, -300, -300]);
    expect(configured.links.map((link) => link.distance)).toEqual([60, 70]);
    expect(configured.links.map((link) => link.strength)).toEqual([0.42, 0.42]);

    const fallback = build({ physics: { charge: -180, linkDistance: 55, linkStrength: 0.7 } });
    expect(fallback.nodes.every((node) => node.charge === -180)).toBe(true);
    expect(fallback.links.every((link) => link.distance === 55)).toBe(true);
    expect(fallback.links.every((link) => link.strength === 0.7)).toBe(true);
  });

  test("accessors receive the caller's node and link objects", () => {
    const nodeData = { weight: 2 };
    const linkData = { score: 0.4 };
    const seen: string[] = [];
    makeGraphData<{ weight: number }, { score: number }>(
      [{ id: "a", data: nodeData }, { id: "b" }],
      [{ id: "ab", source: "a", target: "b", data: linkData }],
      resolveConfig({
        nodes: {
          radius: (node) => {
            seen.push(`node:${node.id}`);
            return node.data === nodeData ? 8 : 3;
          },
        },
        links: {
          width: (link) => {
            seen.push(`link:${link.id}`);
            return link.data === linkData ? 2 : 1;
          },
        },
      }),
    );
    expect(seen).toEqual(["node:a", "node:b", "link:ab"]);
  });
});

describe("positions and pins", () => {
  test("honors a pinned position exactly and leaves an unpinned node free", () => {
    const graph = makeGraphData(
      [
        { id: "a", x: 30, y: -20, fx: 30, fy: -20 },
        { id: "b", x: -5, y: 5 },
      ],
      [{ id: "ab", source: "a", target: "b" }],
      resolveConfig(),
    );
    expect(graph.nodes[0]).toMatchObject({
      x: 30,
      y: -20,
      fx: 30,
      fy: -20,
      modelFx: true,
      modelFy: true,
    });
    const free = graph.nodes[1]!;
    expect(free.fx).toBeNull();
    expect(free.fy).toBeNull();
    expect(Number.isFinite(free.x)).toBe(true);
    expect(Number.isFinite(free.y)).toBe(true);
  });

  test("preserves previous coordinates while restyling", () => {
    const first = build();
    const positions = first.nodes.map((node) => [node.id, node.x, node.y]);

    const restyled = build({ nodes: { color: () => "#abcdef" }, labels: { fontSize: 14 } }, first);
    expect(restyled.nodes.map((node) => [node.id, node.x, node.y])).toEqual(positions);
    expect(restyled.nodes[0]!.color).toBe("#abcdef");
    expect(restyled.layoutChanged).toBe(false);
  });

  test("restyling a moving graph preserves its velocity", () => {
    const first = build();
    first.nodes[0]!.vx = 2;
    first.nodes[0]!.vy = -3;
    const restyled = build({ nodes: { color: "#abcdef" } }, first);
    expect(restyled.nodes[0]).toMatchObject({ vx: 2, vy: -3 });
    expect(restyled.layoutChanged).toBe(false);
  });

  test("a radius change is physics: positions stay but the layout is dirty", () => {
    const first = build();
    const positions = first.nodes.map((node) => [node.id, node.x, node.y]);
    const larger = build({ nodes: { radius: 9 } }, first);
    expect(larger.nodes.map((node) => [node.id, node.x, node.y])).toEqual(positions);
    expect(larger.nodes.every((node) => node.radius === 9)).toBe(true);
    expect(larger.layoutChanged).toBe(true);
  });

  test("carries a locally dragged pin across a refresh", () => {
    const first = build();
    const dragged = first.nodes[1]!;
    dragged.x = 100;
    dragged.y = 50;
    dragged.fx = 100;
    dragged.fy = 50;

    const refreshed = build({ labels: { visible: true } }, first);
    expect(refreshed.layoutChanged).toBe(false);
    expect(refreshed.nodes[1]).toMatchObject({ x: 100, y: 50, fx: 100, fy: 50 });
  });

  test("a removed override releases the previous pin", () => {
    const pinned = makeGraphData([{ id: "a", fx: 12, fy: 34 }, { id: "b" }], [], resolveConfig());
    expect(pinned.nodes[0]).toMatchObject({ fx: 12, fy: 34 });

    const released = makeGraphData([{ id: "a" }, { id: "b" }], [], resolveConfig(), 0, pinned);
    expect(released.nodes[0]!.fx).toBeNull();
    expect(released.nodes[0]!.fy).toBeNull();
  });

  test("changing a pin wakes the layout and updates the position", () => {
    const first = build();
    const moved = makeGraphData(
      [{ ...nodes[0]!, fx: 100, fy: 80 }, ...nodes.slice(1)],
      links,
      resolveConfig(),
      0,
      first,
    );
    expect(moved.nodes[0]).toMatchObject({ x: 100, y: 80, fx: 100, fy: 80 });
    expect(moved.layoutChanged).toBe(true);
  });

  test("an explicit null releases a pin even when the previous layout had one", () => {
    const pinned = makeGraphData([{ id: "a", fx: 12, fy: 34 }], [], resolveConfig());
    const released = makeGraphData(
      [{ id: "a", fx: null, fy: null }],
      [],
      resolveConfig(),
      0,
      pinned,
    );
    expect(released.nodes[0]!.fx).toBeNull();
    expect(released.nodes[0]!.fy).toBeNull();
  });

  test("layoutChanged tracks physics and topology but not styling", () => {
    const first = build();
    expect(first.layoutChanged).toBe(true);

    expect(build({ physics: { charge: -400 } }, first).layoutChanged).toBe(true);
    expect(build({ physics: { alphaDecay: 0.02 } }, first).layoutChanged).toBe(true);
    expect(
      build({ links: { width: 2, dashed: true }, labels: { visible: false } }, first).layoutChanged,
    ).toBe(false);

    const grown = makeGraphData([...nodes, { id: "d" }], links, resolveConfig(), 0, first);
    expect(grown.layoutChanged).toBe(true);

    const rewired = makeGraphData(
      nodes,
      [links[0]!, { id: "ac", source: "a", target: "c" }],
      resolveConfig(),
      0,
      first,
    );
    expect(rewired.layoutChanged).toBe(true);
  });

  test("a force change keeps coordinates while flagging the layout dirty", () => {
    const first = build();
    const positions = first.nodes.map((node) => [node.id, node.x, node.y]);
    const hotter = build({ physics: { charge: -400 } }, first);
    expect(hotter.layoutChanged).toBe(true);
    expect(hotter.nodes.map((node) => [node.id, node.x, node.y])).toEqual(positions);
  });

  test("a layout version bump restarts positions instead of reusing them", () => {
    const first = build();
    const reset = makeGraphData(nodes, links, resolveConfig(), 1, first);
    const fresh = makeGraphData(nodes, links, resolveConfig(), 1);
    expect(reset.layoutVersion).toBe(1);
    expect(reset.layoutChanged).toBe(true);
    expect(reset.nodes.map((node) => [node.id, node.x, node.y])).toEqual(
      fresh.nodes.map((node) => [node.id, node.x, node.y]),
    );
  });

  test("a new node seeds from its explicit coordinates", () => {
    // The default has no warmup ticks, so the observable position is the seed.
    const graph = makeGraphData([{ id: "a", x: 40, y: -10 }], [], resolveConfig());
    expect(graph.nodes[0]).toMatchObject({ x: 40, y: -10, fx: null, fy: null });
  });

  test("an explicit coordinate beats the previous settled position", () => {
    const first = makeGraphData([{ id: "a" }, { id: "b" }], [], resolveConfig());
    const moved = makeGraphData(
      [{ id: "a", x: 70, y: 80 }, { id: "b" }],
      [],
      resolveConfig(),
      0,
      first,
    );
    expect(moved.nodes[0]).toMatchObject({ x: 70, y: 80 });
  });

  test("a new node without coordinates lands on the spiral", () => {
    const graph = makeGraphData([{ id: "a" }, { id: "b" }, { id: "c" }], [], resolveConfig());
    expect(graph.nodes.map((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toEqual([
      true,
      true,
      true,
    ]);
    expect(new Set(graph.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(3);
  });
});
