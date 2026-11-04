/**
 * Synthetic graph for the demo harness. Deterministic: the same ids, links and
 * sizes every load, so the layout is comparable between runs.
 *
 * Domain payloads — audience descriptions, media, degree and edge relations —
 * live in the typed `data` field. The engine never reads them; the demo turns
 * them into explicit shape, colour and width choices for the canvas.
 */

import type { GraphLink, GraphNode, NodeShape } from "../graph/index.ts";

const SEGMENTS = [
  "Design",
  "Engineering",
  "Research",
  "Product",
  "Community",
  "Security",
  "Data",
] as const;

const TOPICS = [
  "Canvas rendering pipelines",
  "Force-directed layout tuning",
  "Type-safe API boundaries",
  "Incremental static rebuilds",
  "Vector search at the edge",
  "Offline-first sync",
  "Accessible data visualization",
  "WASM inference in the browser",
  "Streaming LLM responses",
  "Design tokens as contracts",
  "Deterministic test fixtures",
  "Spatial indexing for maps",
  "Keyboard-first navigation",
  "Monorepo build caching",
  "Runtime theme switching",
  "Graph clustering heuristics",
  "Progressive image decoding",
  "Realtime collaboration CRDTs",
  "Feature flags without debt",
  "Observability for the frontend",
  "Server components tradeoffs",
  "Typed event pipelines",
  "Colour contrast in charts",
  "Windowing large lists",
  "Micro-frontend boundaries",
  "Local-first search indexes",
  "Battery-aware animation",
  "Gesture arbitration on touch",
  "Font loading strategies",
  "Edge caching invalidation",
] as const;

export const MEDIA = ["text", "image", "video", "audio", "link"] as const;

export type DemoMedia = (typeof MEDIA)[number];

/** Content type maps to an explicit outline; text stays the quiet circle. */
export function shapeForMedia(media: DemoMedia | undefined): NodeShape {
  if (media === "image") return "square";
  if (media === "video") return "triangle";
  if (media === "audio") return "diamond";
  if (media === "link") return "pentagon";
  return "circle";
}

export type DemoNodeKind = "audience" | "topic";

/** What a demo node means: copy, content type, connection count and base size. */
export interface DemoNodeData {
  kind: DemoNodeKind;
  description: string;
  media?: DemoMedia;
  degree: number;
  /** Radius in graph units before the demo's node-scale control applies. */
  size: number;
}

export type DemoRelation = "observed-in" | "similarity";

/** Edge meaning; a similarity edge also carries the measured score. */
export interface DemoLinkData {
  relation: DemoRelation;
  similarity?: number;
}

export interface DemoGraph {
  nodes: GraphNode<DemoNodeData>[];
  links: GraphLink<DemoLinkData>[];
}

/** Small deterministic PRNG so the demo data is stable across reloads. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDemoGraph(): DemoGraph {
  const random = mulberry32(42);
  const nodes: GraphNode<DemoNodeData>[] = [];
  const links: GraphLink<DemoLinkData>[] = [];
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);

  const hubs = SEGMENTS.map((segment) => {
    const id = `segment:${segment}`;
    return { id, label: segment };
  });
  const patterns = TOPICS.map((topic, index) => ({
    id: `pattern:${index}`,
    label: topic,
    media: MEDIA[index % MEDIA.length]!,
  }));

  const observedIn = new Map<string, string[]>();
  for (const pattern of patterns) {
    // Every pattern is observed in one segment; a third of them span two, so
    // the map has cross-links instead of seven isolated stars.
    const first = Math.floor(random() * hubs.length);
    const segments = [hubs[first]!];
    if (random() < 0.34) {
      const second = (first + 1 + Math.floor(random() * (hubs.length - 1))) % hubs.length;
      segments.push(hubs[second]!);
    }
    observedIn.set(
      pattern.id,
      segments.map((segment) => segment.id),
    );
    for (const segment of segments) {
      const id = `observe:${segment.id}:${pattern.id}`;
      links.push({
        id,
        source: segment.id,
        target: pattern.id,
        data: { relation: "observed-in" },
      });
      bump(segment.id);
      bump(pattern.id);
    }
  }

  // Similarity edges are undirected in meaning but stored once per pair.
  for (let index = 0; index < patterns.length; index += 1) {
    for (let other = index + 1; other < patterns.length; other += 1) {
      const shared = observedIn
        .get(patterns[index]!.id)!
        .some((segment) => observedIn.get(patterns[other]!.id)!.includes(segment));
      const pair = random();
      if (pair > (shared ? 0.55 : 0.2)) continue;
      const similarity = Number((0.42 + random() * 0.55).toFixed(3));
      links.push({
        id: `similar:${patterns[index]!.id}:${patterns[other]!.id}`,
        source: patterns[index]!.id,
        target: patterns[other]!.id,
        data: { relation: "similarity", similarity },
      });
      bump(patterns[index]!.id);
      bump(patterns[other]!.id);
    }
  }

  for (const hub of hubs) {
    nodes.push({
      id: hub.id,
      label: hub.label,
      hub: true,
      data: {
        kind: "audience",
        description: `${hub.label} audience hub`,
        degree: degree.get(hub.id) ?? 0,
        size: 9,
      },
    });
  }
  for (const pattern of patterns) {
    const topicDegree = degree.get(pattern.id) ?? 0;
    nodes.push({
      id: pattern.id,
      label: pattern.label,
      data: {
        kind: "topic",
        description: `Observed in ${observedIn.get(pattern.id)?.length ?? 0} audience(s)`,
        media: pattern.media,
        degree: topicDegree,
        // Degree sets the size: a quiet topic stays small, a hub-adjacent one
        // grows, capped so the busiest topic never swallows the map. It lives
        // in data, not `radius`, so the node-scale control can still apply.
        size: 4 + Math.min(9, Math.sqrt(topicDegree || 1) * 1.9),
      },
    });
  }

  return { nodes, links };
}
