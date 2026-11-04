/**
 * Demo graph: the animal taxonomy in `animal-data.ts` turned into a canvas
 * graph. Species hang off their genus, genera off their nearest family or
 * order, and everything ends at one of six animal classes.
 *
 * The payload carries domain facts only (rank, scientific name, description,
 * Wikipedia prominence); the engine never reads them. The demo maps them to
 * size, shape and colour below.
 */

import { ANIMAL_CLASSES, ANIMAL_SPECIES, ANIMAL_TAXA } from "./animal-data.ts";
import type { GraphLink, GraphNode, NodeShape } from "../graph/index.ts";

export type AnimalRank =
  | "kingdom"
  | "phylum"
  | "subphylum"
  | "class"
  | "subclass"
  | "superorder"
  | "order"
  | "suborder"
  | "superfamily"
  | "family"
  | "subfamily"
  | "genus"
  | "species"
  | "clade";

export interface AnimalNodeData {
  rank: AnimalRank;
  /** Scientific name for species, common name for higher taxa. */
  name: string;
  /** One-line Wikipedia description; empty for higher taxa. */
  description: string;
  /** Animal class this taxon belongs to, e.g. "Mammals". */
  group: string;
  /** Wikipedia language editions carrying the article; 0 for higher taxa. */
  links: number;
}

export interface AnimalLinkData {
  /** true when the link joins a species to its genus. */
  species: boolean;
  /** true when the link belongs to the shared spine above the classes. */
  trunk?: boolean;
}

export interface AnimalGraph {
  nodes: GraphNode<AnimalNodeData>[];
  links: GraphLink<AnimalLinkData>[];
  counts: { species: number; taxa: number };
}

/** One colour per animal class; also the legend order. */
export const GROUPS = [
  { name: "Mammals", color: "#8b5cf6" },
  { name: "Birds", color: "#0ea5e9" },
  { name: "Reptiles", color: "#10b981" },
  { name: "Amphibians", color: "#f59e0b" },
  { name: "Ray-finned fish", color: "#06b6d4" },
  { name: "Insects", color: "#ec4899" },
] as const;

const COLOR_BY_GROUP = new Map<string, string>(GROUPS.map((entry) => [entry.name, entry.color]));

/** The shared trunk above the classes: one neutral colour, not a class hue. */
export const TRUNK_COLOR = "#7c8593";

/** Higher taxa get their own outline so ranks read at a glance. */
const SHAPE_BY_RANK: Record<AnimalRank, NodeShape> = {
  kingdom: "pentagon",
  phylum: "pentagon",
  subphylum: "diamond",
  class: "pentagon",
  subclass: "diamond",
  superorder: "diamond",
  order: "diamond",
  suborder: "triangle",
  superfamily: "square",
  family: "square",
  subfamily: "triangle",
  genus: "circle",
  species: "circle",
  clade: "circle",
};

/** Base radius per rank, before the demo's node-size control applies. */
const SIZE_BY_RANK: Record<AnimalRank, number> = {
  kingdom: 12,
  phylum: 9.5,
  subphylum: 7,
  class: 9,
  subclass: 6,
  superorder: 5,
  order: 5.6,
  suborder: 4.4,
  superfamily: 4.2,
  family: 4.6,
  subfamily: 3.8,
  genus: 3.1,
  species: 2.1,
  clade: 4,
};

/** Ranks that are shared by every class, so they carry the neutral colour. */
const TRUNK_RANKS = new Set<AnimalRank>(["kingdom", "phylum", "subphylum", "clade"]);

/**
 * A species' radius grows with its Wikipedia footprint, so the lion and the
 * tiger carry the mammal cluster instead of hiding among obscure shrews.
 */
function speciesSize(links: number): number {
  return SIZE_BY_RANK.species + Math.min(2.6, Math.sqrt(links) * 0.16);
}

/**
 * Classes are seeded around a ring so the force layout starts with six
 * separate clusters instead of one pile. They are *not* pinned: pinning turns
 * every class into the tip of a hairline star, because the whole tree then
 * hangs off six fixed points. Free anchors drift into their own gravity wells
 * and the tree fans out underneath them.
 */
export const ANCHOR_RADIUS = 1100;

export function buildAnimalGraph(): AnimalGraph {
  const nodes: GraphNode<AnimalNodeData>[] = [];
  const links: GraphLink<AnimalLinkData>[] = [];

  /**
   * Real class nodes are the ones Wikidata gives us, so the trunk links into
   * them directly; the ring seed below only decides where they start out.
   */
  const classNodes = new Map<string, string>();
  GROUPS.forEach((group, index) => {
    const angle = (index / GROUPS.length) * Math.PI * 2 - Math.PI / 2;
    const id = `class:${group.name}`;
    classNodes.set(group.name, id);
    nodes.push({
      id,
      label: group.name,
      hub: true,
      x: Math.cos(angle) * ANCHOR_RADIUS,
      y: Math.sin(angle) * ANCHOR_RADIUS,
      data: {
        rank: "class",
        name: group.name,
        description: "",
        group: group.name,
        links: 0,
      },
    });
  });

  /**
   * Map a data parent id to the id drawn for it. Sampled classes are drawn
   * under their group name, so a trunk taxon pointing at `Q10811` has to point
   * at `class:Reptiles` instead, or the two halves never join.
   */
  const drawnId = (id: string): string | undefined => {
    const classLabel = ANIMAL_CLASSES[id];
    return classLabel ? classNodes.get(classLabel) : id;
  };

  // Species and taxa inherit the seed of their class, fanned by the golden
  // angle, so the first frame already looks like six clusters.
  const seed = new Map<string, { x: number; y: number }>();
  GROUPS.forEach((group, index) => {
    const angle = (index / GROUPS.length) * Math.PI * 2 - Math.PI / 2;
    seed.set(group.name, {
      x: Math.cos(angle) * ANCHOR_RADIUS,
      y: Math.sin(angle) * ANCHOR_RADIUS,
    });
  });
  /**
   * Where a node starts. Class members fan out around their class. Trunk taxa
   * are shared by several classes, so they are seeded near the centre and the
   * forces pull them into a spine — pinning them on one class's ray would make
   * the other five look unrelated to it.
   */
  const seedFor = (group: string, offset: number): { x: number; y: number } => {
    const origin = seed.get(group) ?? { x: 0, y: 0 };
    const angle = (offset * 137.508 * Math.PI) / 180;
    const radius = group ? 60 + 7 * Math.sqrt(offset) : 8 * Math.sqrt(offset);
    return { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
  };
  const offsetByGroup = new Map<string, number>();
  const nextOffset = (group: string): number => {
    const next = (offsetByGroup.get(group) ?? 0) + 1;
    offsetByGroup.set(group, next);
    return next;
  };

  for (const taxon of ANIMAL_TAXA) {
    const parent = taxon.parent ? drawnId(taxon.parent) : undefined;
    // A sampled class is already drawn above under its group name; it still
    // needs its own upward link, which is what joins it to the shared trunk.
    if (taxon.rank === "class") {
      const anchor = ANIMAL_CLASSES[taxon.id];
      const id = anchor ? classNodes.get(anchor) : undefined;
      if (id && parent) {
        links.push({
          id: `${id}>${parent}`,
          source: id,
          target: parent,
          data: { species: false, trunk: true },
        });
      }
      continue;
    }
    const position = seedFor(taxon.group, nextOffset(taxon.group));
    nodes.push({
      id: taxon.id,
      label: taxon.name,
      hub: taxon.rank === "kingdom",
      x: position.x,
      y: position.y,
      data: {
        rank: taxon.rank as AnimalRank,
        name: taxon.name,
        description: "",
        group: taxon.group,
        links: 0,
      },
    });
    // Only the root has no parent; everything else stays attached, or the graph
    // would split back into separate trees.
    if (!parent) continue;
    links.push({
      id: `${taxon.id}>${parent}`,
      source: taxon.id,
      target: parent,
      // A trunk edge joins two shared nodes (or a class to the spine). Ordinary
      // taxon edges stay quiet so the clusters keep their internal texture.
      data: { species: false, trunk: !taxon.group },
    });
  }

  for (const species of ANIMAL_SPECIES) {
    const position = seedFor(species.group, nextOffset(species.group));
    nodes.push({
      id: species.id,
      label: species.scientific,
      x: position.x,
      y: position.y,
      data: {
        rank: "species",
        name: species.common,
        description: species.description,
        group: species.group,
        links: species.links,
      },
    });
    links.push({
      id: `${species.id}>${species.genus}`,
      source: species.id,
      target: species.genus,
      data: { species: true },
    });
  }

  return {
    nodes,
    links,
    counts: { species: ANIMAL_SPECIES.length, taxa: ANIMAL_TAXA.length },
  };
}

/**
 * Deterministic rank per node, in [0, 1). Sorting by this and keeping a prefix
 * gives a stable random subset: 40% contains every node that 25% contained, so
 * dragging the density slider removes nodes instead of reshuffling the graph.
 */
function hashUnit(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * Keep a random `percent` of the graph (1–100).
 *
 * Sampling a tree by node alone destroys it: a kept genus whose family was
 * dropped becomes an orphan, and a few hundred survivors collapse into
 * disconnected confetti. So every kept node is re-attached to its nearest kept
 * ancestor, which keeps the graph one connected tree at any density while the
 * node count still matches the slider.
 *
 * The subset is deterministic and nested — 40% contains everything 25% kept —
 * so dragging the slider removes nodes instead of reshuffling the map.
 */
export function sampleAnimalGraph(graph: AnimalGraph, percent: number): AnimalGraph {
  if (percent >= 100) return graph;

  const parentOf = new Map<string, string>();
  for (const link of graph.links) parentOf.set(link.source, link.target);

  const anchors: GraphNode<AnimalNodeData>[] = [];
  const rest: GraphNode<AnimalNodeData>[] = [];
  for (const node of graph.nodes) {
    const rank = node.data?.rank;
    // Roots and class anchors always stay, so every cluster keeps its label.
    if (node.hub || rank === "kingdom" || rank === "class") anchors.push(node);
    else rest.push(node);
  }
  const keep = new Set(anchors.map((node) => node.id));
  rest.sort((a, b) => hashUnit(a.id) - hashUnit(b.id));
  const wanted = Math.max(0, Math.round((rest.length * percent) / 100));
  for (let index = 0; index < wanted; index += 1) keep.add(rest[index]!.id);

  const nodes = graph.nodes.filter((node) => keep.has(node.id));
  const links: GraphLink<AnimalLinkData>[] = [];
  const seen = new Set<string>();
  const addLink = (source: string, target: string, data: AnimalLinkData) => {
    const id = `${source}>${target}`;
    if (seen.has(id)) return;
    seen.add(id);
    links.push({ id, source, target, data });
  };

  for (const link of graph.links) {
    if (keep.has(link.source) && keep.has(link.target)) {
      addLink(link.source, link.target, link.data ?? { species: false });
    }
  }

  // Bridge every survivor whose parent was dropped to the nearest kept ancestor.
  for (const node of nodes) {
    let cursor = parentOf.get(node.id);
    let guard = 0;
    while (cursor && !keep.has(cursor) && guard < 64) {
      cursor = parentOf.get(cursor);
      guard += 1;
    }
    if (!cursor || !keep.has(cursor)) continue;
    addLink(node.id, cursor, { species: false, trunk: !node.data?.group });
  }

  return {
    nodes,
    links,
    counts: {
      species: nodes.filter((node) => node.data?.rank === "species").length,
      taxa: nodes.filter((node) => node.data?.rank !== "species").length,
    },
  };
}

export function colorForNode(data: AnimalNodeData | undefined): string {
  if (!data) return "#bfc3c9";
  // The trunk is shared, so colouring it by class would claim a false ancestry.
  if (!data.group || TRUNK_RANKS.has(data.rank)) return TRUNK_COLOR;
  return COLOR_BY_GROUP.get(data.group) ?? TRUNK_COLOR;
}

export function shapeForNode(data: AnimalNodeData | undefined): NodeShape {
  return data ? SHAPE_BY_RANK[data.rank] : "circle";
}

export function radiusForNode(data: AnimalNodeData | undefined): number {
  if (!data) return SIZE_BY_RANK.species;
  return data.rank === "species" ? speciesSize(data.links) : SIZE_BY_RANK[data.rank];
}
