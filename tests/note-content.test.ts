import { describe, expect, test } from "bun:test";
import { noteFor, resolveWikiLink } from "../src/demo/note-content.ts";

describe("demo note content", () => {
  test("a species note links to its genus and siblings", () => {
    const markdown = noteFor("Q140", "Panthera leo");
    expect(markdown).toContain("# Panthera leo");
    expect(markdown).toContain("[[Panthera]]");
    // Tigers are in the same genus, so they must be reachable from the lion.
    expect(markdown).toContain("[[Panthera tigris]]");
  });

  test("a taxon note lists what it contains", () => {
    const markdown = noteFor("Q127960", "Panthera");
    expect(markdown).toContain("# Panthera");
    expect(markdown).toContain("## Contains");
    expect(markdown).toContain("[[Panthera leo]]");
  });

  test("unknown nodes still produce a note instead of throwing", () => {
    expect(noteFor("Q-not-real", "Mystery")).toContain("# Mystery");
  });

  test("wiki-link targets resolve to graph node ids", () => {
    // Notes name taxa by display name; the graph is keyed by QID.
    expect(resolveWikiLink("Panthera")).toBe("Q127960");
    expect(resolveWikiLink("Panthera tigris")).toBe("Q19939");
    expect(resolveWikiLink("Mammals")).toBe("Q7377");
    expect(resolveWikiLink("  panthera  ")).toBe("Q127960");
    expect(resolveWikiLink("Not A Taxon")).toBeNull();
  });
});
