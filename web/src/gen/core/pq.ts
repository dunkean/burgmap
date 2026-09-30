/** Binary min-heap keyed by numeric priority. */
export class MinHeap<T = number> {
  private keys: number[] = [];
  private vals: T[] = [];
  get size(): number { return this.keys.length; }
  push(val: T, key: number): void {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  /** Pops the smallest; returns undefined when empty. */
  pop(): T | undefined {
    const k = this.keys, v = this.vals;
    const n = k.length;
    if (n === 0) return undefined;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (n > 1) {
      let i = 0; const m = n - 1;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) break;
        if (c + 1 < m && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  peekKey(): number { return this.keys[0]; }
}
