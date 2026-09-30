import { D8 } from './grid';

export interface FloodResult { filled: Float32Array; receiver: Int32Array; order: Int32Array }

/**
 * Priority-flood depression filling with epsilon (Barnes, Lehman & Mulla 2014), typed-array heap.
 * Outlets: map-border cells and cells flagged in `outlet` (e.g. sea). Each cell's receiver is the neighbor it
 * was discovered from, so the receiver graph is acyclic and drains to an outlet; `order` lists cells in pop order
 * (receivers always precede their donors).
 */
export function priorityFloodFast(h: Float32Array, w: number, hh: number, outlet: Uint8Array | null, eps = 0.002): FloodResult {
  const N = w * hh;
  const filled = new Float32Array(N);
  const receiver = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const order = new Int32Array(N);
  const hk = new Float32Array(N + 1);
  const hv = new Int32Array(N + 1);
  let hn = 0;
  const push = (val: number, key: number): void => {
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= key) break;
      hk[i] = hk[p]; hv[i] = hv[p]; i = p;
    }
    hk[i] = key; hv[i] = val;
  };
  const pop = (): number => {
    const top = hv[0];
    hn--;
    if (hn > 0) {
      const lk = hk[hn], lv = hv[hn];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hn) break;
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= lk) break;
        hk[i] = hk[c]; hv[i] = hv[c]; i = c;
      }
      hk[i] = lk; hv[i] = lv;
    }
    return top;
  };
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((outlet && outlet[i]) || x === 0 || y === 0 || x === w - 1 || y === hh - 1) {
        closed[i] = 1; filled[i] = h[i]; push(i, h[i]);
      }
    }
  }
  let no = 0;
  while (hn > 0) {
    const c = pop();
    order[no++] = c;
    const cx = c % w, cy = (c / w) | 0;
    const fc = filled[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
      const n = ny * w + nx;
      if (closed[n]) continue;
      closed[n] = 1;
      const v = h[n];
      const f = v > fc ? v : fc + eps;
      filled[n] = f;
      receiver[n] = c;
      push(n, f);
    }
  }
  return { filled, receiver, order };
}
