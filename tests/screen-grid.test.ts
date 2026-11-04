import { describe, expect, test } from "bun:test";
import { ScreenGrid } from "../src/graph/screen-grid.ts";

describe("screen-space label collisions", () => {
  test("finds overlaps across cell boundaries without hiding touching labels", () => {
    const grid = new ScreenGrid();
    grid.reset(400, 300);
    grid.insert({ left: 60, top: 60, right: 140, bottom: 80 });
    expect(grid.intersects(130, 70, 150, 90)).toBe(true);
    expect(grid.intersects(140, 60, 160, 80)).toBe(false);
    expect(grid.intersects(10, 10, 30, 30)).toBe(false);
  });

  test("circle corners do not suppress labels outside the actual hub", () => {
    const grid = new ScreenGrid();
    grid.reset(200, 200);
    grid.insert({ left: 40, top: 40, right: 80, bottom: 80, radius: 20 });
    expect(grid.intersects(40, 40, 44, 44)).toBe(false);
    expect(grid.intersects(55, 55, 65, 65)).toBe(true);
    expect(grid.intersects(79, 58, 85, 62)).toBe(true);
  });

  test("reset forgets stale rectangles at the same size and after a resize", () => {
    const grid = new ScreenGrid();
    const box = { left: 10, top: 10, right: 120, bottom: 120 };
    grid.reset(400, 300);
    grid.insert(box);
    grid.reset(400, 300);
    expect(grid.intersects(20, 20, 30, 30)).toBe(false);
    grid.insert(box);
    grid.reset(100, 100);
    expect(grid.intersects(20, 20, 30, 30)).toBe(false);
    grid.insert(box);
    expect(grid.intersects(90, 90, 110, 110)).toBe(true);
  });

  test("clipping an index cell does not create false collisions offscreen", () => {
    const grid = new ScreenGrid();
    grid.reset(100, 100);
    grid.insert({ left: -20, top: -20, right: 5, bottom: 5 });
    expect(grid.intersects(0, 0, 10, 10)).toBe(true);
    expect(grid.intersects(40, 40, 50, 50)).toBe(false);
  });
});
