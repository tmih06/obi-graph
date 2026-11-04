export interface HighlightTarget {
  opacity: number;
  highlight: number;
  accent: number;
  title: number;
  width: number;
  labelScale: number;
}

export interface HighlightStyle extends HighlightTarget {
  id: number;
  from: HighlightTarget;
  to: HighlightTarget;
}

/**
 * Interpolated highlight styles, shared between items that transition the same
 * way. Items are addressed by slot index (nodes first, then links), so a hover
 * on a 3,000-node graph costs a few typed-array writes rather than thousands of
 * string-keyed map operations.
 *
 * Two identical targets share one track, so a dimmed node and a focused one are
 * two tracks regardless of how many nodes are in each state.
 */
export class HighlightTransition {
  /** Track index per item slot: 0..nodeCount-1 nodes, then links. */
  readonly styleIndex: Int32Array;
  /** The tracks actually in use, indexed by `id`. */
  readonly styles: HighlightStyle[] = [];
  private readonly tracks = new Map<string, HighlightStyle>();
  private readonly nodeCount: number;
  private moving = false;

  private readonly startedAt: number;
  private readonly duration: number;

  constructor(nodeCount: number, linkCount: number, startedAt: number, duration: number) {
    this.nodeCount = nodeCount;
    this.styleIndex = new Int32Array(nodeCount + linkCount).fill(-1);
    this.startedAt = startedAt;
    this.duration = duration;
  }

  /** Register a node's target style; `index` is its index in the node array. */
  addNode(index: number, to: HighlightTarget, previous?: HighlightTransition | null): void {
    this.assign(index, to, previous);
  }

  /** Register a link's target style; `index` is its index in the link array. */
  addLink(index: number, to: HighlightTarget, previous?: HighlightTransition | null): void {
    this.assign(this.nodeCount + index, to, previous);
  }

  nodeStyle(index: number): HighlightStyle {
    return this.styles[this.styleIndex[index]!] ?? DEFAULT_STYLE;
  }

  linkStyle(index: number): HighlightStyle {
    return this.styles[this.styleIndex[this.nodeCount + index]!] ?? DEFAULT_STYLE;
  }

  /** Whether this transition still has time to run at `now`. */
  isRunning(now: number): boolean {
    return this.duration > 0 && now - this.startedAt < this.duration;
  }

  /** True only while another animation frame is needed. */
  advance(now: number): boolean {
    const t =
      this.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - this.startedAt) / this.duration));
    const eased = t * t * (3 - 2 * t);
    for (const style of this.styles) {
      const { from, to } = style;
      style.opacity = t === 1 ? to.opacity : from.opacity + (to.opacity - from.opacity) * eased;
      style.highlight =
        t === 1 ? to.highlight : from.highlight + (to.highlight - from.highlight) * eased;
      style.accent = t === 1 ? to.accent : from.accent + (to.accent - from.accent) * eased;
      style.title = t === 1 ? to.title : from.title + (to.title - from.title) * eased;
      style.width = t === 1 ? to.width : from.width + (to.width - from.width) * eased;
      style.labelScale =
        t === 1 ? to.labelScale : from.labelScale + (to.labelScale - from.labelScale) * eased;
    }
    return this.moving && t < 1;
  }

  private assign(
    slot: number,
    to: HighlightTarget,
    previous: HighlightTransition | null | undefined,
  ): void {
    const previousIndex = previous?.styleIndex[slot] ?? -1;
    // A finished transition is already at its target; only a running one needs
    // to resume from its painted values, which is what keeps interrupted hovers
    // continuous without leaking one track per frame.
    const running =
      previous !== null && previous !== undefined && previous.isRunning(this.startedAt);
    const old = running && previousIndex >= 0 ? previous!.styles[previousIndex] : undefined;
    // Interrupting a transition continues from what is painted right now; a new
    // one starts at its target. Track identity covers both the origin and the
    // destination, so equal transitions share a track with no signature string.
    const from = old
      ? `live:${old.opacity}|${old.highlight}|${old.accent}|${old.title}|${old.width}|${old.labelScale}`
      : "target";
    const key = `${from}->${to.opacity}|${to.highlight}|${to.accent}|${to.title}|${to.width}|${to.labelScale}`;
    let style = this.tracks.get(key);
    if (!style) {
      const origin = old
        ? {
            opacity: old.opacity,
            highlight: old.highlight,
            accent: old.accent,
            title: old.title,
            width: old.width,
            labelScale: old.labelScale,
          }
        : to;
      style = { ...origin, id: this.styles.length, from: origin, to };
      this.tracks.set(key, style);
      this.styles.push(style);
      this.moving ||=
        origin.opacity !== to.opacity ||
        origin.highlight !== to.highlight ||
        origin.accent !== to.accent ||
        origin.title !== to.title ||
        origin.width !== to.width ||
        origin.labelScale !== to.labelScale;
    }
    this.styleIndex[slot] = style.id;
  }
}

/** Used before the first transition exists; opaque and fully lit. */
const DEFAULT_STYLE: HighlightStyle = {
  id: 0,
  opacity: 1,
  highlight: 0,
  accent: 0,
  title: 0,
  width: 0,
  labelScale: 1,
  from: { opacity: 1, highlight: 0, accent: 0, title: 0, width: 0, labelScale: 1 },
  to: { opacity: 1, highlight: 0, accent: 0, title: 0, width: 0, labelScale: 1 },
};
