import { describe, expect, test } from "bun:test";
import { HighlightTransition, type HighlightTarget } from "../src/graph/highlight-transition.ts";

const target = (overrides: Partial<HighlightTarget> = {}): HighlightTarget => ({
  opacity: 1,
  highlight: 0,
  accent: 0,
  title: 0,
  width: 0,
  labelScale: 1,
  ...overrides,
});

describe("HighlightTransition", () => {
  test("items in the same state share one track", () => {
    const transition = new HighlightTransition(100, 100, 0, 240);
    const dim = target({ opacity: 0.16 });
    for (let index = 0; index < 100; index += 1) transition.addNode(index, dim);
    for (let index = 0; index < 100; index += 1) transition.addLink(index, dim);
    expect(transition.styles.length).toBe(1);
    expect(transition.nodeStyle(0)).toBe(transition.nodeStyle(99));
    expect(transition.linkStyle(0)).toBe(transition.nodeStyle(0));
  });

  test("nodes and links do not share slots", () => {
    const transition = new HighlightTransition(2, 2, 0, 240);
    transition.addNode(0, target({ opacity: 0.2 }));
    transition.addLink(0, target({ accent: 1 }));
    expect(transition.nodeStyle(0).accent).toBe(0);
    expect(transition.linkStyle(0).accent).toBe(1);
  });

  test("the first transition paints its target without animating", () => {
    const transition = new HighlightTransition(1, 0, 0, 240);
    transition.addNode(0, target({ opacity: 0.2 }));
    // A fresh graph has nothing to fade from; it starts at the target.
    expect(transition.advance(0)).toBe(false);
    expect(transition.nodeStyle(0).opacity).toBe(0.2);
  });

  test("advance interpolates then settles exactly on the target", () => {
    // The previous transition is still running, so the new one has an origin.
    const first = new HighlightTransition(1, 0, 0, 240);
    first.addNode(0, target({ opacity: 1 }));
    first.advance(120);

    const transition = new HighlightTransition(1, 0, 120, 240);
    transition.addNode(0, target({ opacity: 0.2 }), first);
    expect(transition.advance(240)).toBe(true);
    const style = transition.nodeStyle(0);
    expect(style.opacity).toBeLessThan(1);
    expect(style.opacity).toBeGreaterThan(0.2);
    expect(transition.advance(360)).toBe(false);
    expect(transition.nodeStyle(0).opacity).toBe(0.2);
  });

  test("reports no animation when nothing changes", () => {
    const transition = new HighlightTransition(1, 0, 0, 240);
    transition.addNode(0, target());
    expect(transition.advance(0)).toBe(false);
  });

  test("an interrupted hover resumes from the painted value", () => {
    const first = new HighlightTransition(1, 0, 0, 240);
    first.addNode(0, target({ opacity: 0.2 }));
    first.advance(120);
    const painted = first.nodeStyle(0).opacity;

    // A new transition starts while the first is still running.
    const second = new HighlightTransition(1, 0, 120, 240);
    second.addNode(0, target({ opacity: 1 }), first);
    expect(second.nodeStyle(0).from.opacity).toBeCloseTo(painted, 6);
  });

  test("a settled previous transition does not add a resume track", () => {
    const first = new HighlightTransition(1, 0, 0, 240);
    first.addNode(0, target({ opacity: 0.2 }));
    first.advance(240);

    const second = new HighlightTransition(1, 0, 1000, 240);
    second.addNode(0, target({ opacity: 0.2 }), first);
    // Already at the target: the track starts and ends at the same value, so
    // nothing animates and no extra track is allocated.
    expect(second.styles.length).toBe(1);
    expect(second.advance(1000)).toBe(false);
  });
});
