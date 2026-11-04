export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** A circle uses its bounding box for indexing and exact geometry for queries. */
  radius?: number;
}

/** Reuses occupied cell buckets between frames; queries only nearby labels/hubs. */
export class ScreenGrid {
  private columns = 1;
  private rows = 1;
  private cells: (ScreenBox[] | undefined)[] = [];
  private occupied: number[] = [];

  reset(width: number, height: number): void {
    const columns = Math.max(1, Math.ceil(width / 64));
    const rows = Math.max(1, Math.ceil(height / 64));
    if (columns !== this.columns || rows !== this.rows) {
      this.cells = [];
      this.cells.length = columns * rows;
      this.columns = columns;
      this.rows = rows;
    } else {
      for (const index of this.occupied) this.cells[index]!.length = 0;
    }
    this.occupied.length = 0;
  }

  insert(box: ScreenBox): void {
    const minX = this.column(box.left);
    const maxX = this.column(box.right);
    const minY = this.row(box.top);
    const maxY = this.row(box.bottom);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const index = y * this.columns + x;
        const cell = this.cells[index] ?? (this.cells[index] = []);
        if (!cell.length) this.occupied.push(index);
        cell.push(box);
      }
    }
  }

  intersects(left: number, top: number, right: number, bottom: number): boolean {
    const minX = this.column(left);
    const maxX = this.column(right);
    const minY = this.row(top);
    const maxY = this.row(bottom);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cell = this.cells[y * this.columns + x];
        if (!cell) continue;
        for (const box of cell) {
          if (left >= box.right || right <= box.left || top >= box.bottom || bottom <= box.top)
            continue;
          if (box.radius === undefined) return true;
          const cx = (box.left + box.right) / 2;
          const cy = (box.top + box.bottom) / 2;
          const dx = cx - Math.max(left, Math.min(cx, right));
          const dy = cy - Math.max(top, Math.min(cy, bottom));
          if (dx * dx + dy * dy < box.radius * box.radius) return true;
        }
      }
    }
    return false;
  }

  private column(x: number): number {
    return Math.max(0, Math.min(this.columns - 1, Math.floor(x / 64)));
  }

  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(y / 64)));
  }
}
