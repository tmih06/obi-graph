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

/** Shared style tracks keep interrupted hovers continuous without per-frame allocations. */
export class HighlightTransition {
  readonly entries = new Map<string, HighlightStyle>();
  private readonly groups = new Map<string, HighlightStyle>();
  private readonly styles: HighlightStyle[] = [];
  private moving = false;

  private readonly startedAt: number;
  private readonly duration: number;

  constructor(startedAt: number, duration: number) {
    this.startedAt = startedAt;
    this.duration = duration;
  }

  add(key: string, to: HighlightTarget, old?: HighlightStyle): HighlightStyle {
    // Start at the last painted values, including a partially completed hover.
    const from = old
      ? {
          opacity: old.opacity,
          highlight: old.highlight,
          accent: old.accent,
          title: old.title,
          width: old.width,
          labelScale: old.labelScale,
        }
      : to;
    const signature = `${from.opacity}|${from.highlight}|${from.accent}|${from.title}|${from.width}|${from.labelScale}|${to.opacity}|${to.highlight}|${to.accent}|${to.title}|${to.width}|${to.labelScale}`;
    let style = this.groups.get(signature);
    if (!style) {
      style = { ...from, id: this.styles.length, from, to };
      this.groups.set(signature, style);
      this.styles.push(style);
      this.moving ||=
        from.opacity !== to.opacity ||
        from.highlight !== to.highlight ||
        from.accent !== to.accent ||
        from.title !== to.title ||
        from.width !== to.width ||
        from.labelScale !== to.labelScale;
    }
    this.entries.set(key, style);
    return style;
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
}
