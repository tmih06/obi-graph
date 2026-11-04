import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/graph/config.ts";
import { makeGraphData } from "../src/graph/layout.ts";

/**
 * Link curvature and arrowheads are validated through the normalized layout,
 * which is where per-link settings become render-ready values.
 */
const build = (config = {}, links: Parameters<typeof makeGraphData>[1] = []) =>
  makeGraphData(
    [
      { id: "a", label: "A", radius: 10 },
      { id: "b", label: "B", radius: 10 },
    ],
    links.length ? links : [{ id: "ab", source: "a", target: "b" }],
    resolveConfig(config),
  );

describe("link curvature and arrows", () => {
  test("defaults to a straight, headless link", () => {
    const [link] = build().links;
    expect(link!.curve).toBe(0);
    expect(link!.arrow).toBe(false);
  });

  test("a per-link curve and arrow win over the config", () => {
    const graph = build({ links: { curve: 0.2, arrow: true } }, [
      { id: "ab", source: "a", target: "b", curve: -0.15, arrow: false },
    ]);
    expect(graph.links[0]!.curve).toBe(-0.15);
    expect(graph.links[0]!.arrow).toBe(false);
  });

  test("the configured accessor applies when a link omits the field", () => {
    const graph = build({
      links: {
        curve: (link: { data?: { paired?: boolean } }) => (link.data?.paired ? 0.12 : 0),
        arrow: (link: { data?: { paired?: boolean } }) => link.data?.paired === true,
      },
    });
    expect(graph.links[0]!.curve).toBe(0);
    expect(graph.links[0]!.arrow).toBe(false);
  });

  test("a restyle of curve and arrow does not reheat the layout", () => {
    const first = build();
    const restyled = makeGraphData(
      [
        { id: "a", label: "A", radius: 10 },
        { id: "b", label: "B", radius: 10 },
      ],
      [{ id: "ab", source: "a", target: "b", curve: 0.2, arrow: true }],
      resolveConfig(),
      0,
      first,
    );
    // Curvature and arrowheads are paint-only: they must not move the graph.
    expect(restyled.layoutChanged).toBe(false);
    expect(restyled.links[0]!.curve).toBe(0.2);
  });
});
