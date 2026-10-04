import { FinalFrame } from './finalFrame';
import type { GDone } from './protocol';

/** Keep the displayed generation interactive until a newer generation's bitmap is actually shown. */
export class FrameHandoff {
  readonly final = new FinalFrame();
  displayedGen = 0;
  displayedMeta: GDone['meta'] | null = null;
  private announced = new Map<number, { ver: number; meta?: GDone['meta'] }>();
  begin(gen: number): void { this.final.begin(gen); }
  acceptsContent(gen: number): boolean { return gen >= this.displayedGen && gen <= this.final.gen; }
  content(gen: number, ver: number, final: boolean, meta?: GDone['meta']): void {
    if (!this.acceptsContent(gen)) return;
    const previous = this.announced.get(gen);
    if (!previous || ver >= previous.ver) this.announced.set(gen, { ver, meta: meta ?? previous?.meta });
    // One render worker announces content in order. Keep the displayed map and the newest renderer only.
    for (const id of this.announced.keys()) if (id < gen && id !== this.displayedGen) this.announced.delete(id);
    if (gen === this.final.gen) this.final.content(gen, ver, final);
  }
  acceptsFrame(gen: number, ver: number): boolean {
    const known = this.announced.get(gen);
    return this.acceptsContent(gen) && !!known && ver >= known.ver && (gen !== this.final.gen || ver >= this.final.finalVer);
  }
  presented(gen: number, ver: number): void {
    if (!this.acceptsFrame(gen, ver)) return;
    this.displayedGen = gen; this.displayedMeta = this.announced.get(gen)?.meta ?? null;
    for (const id of this.announced.keys()) if (id < gen) this.announced.delete(id);
    if (gen === this.final.gen) this.final.presented(gen, ver);
  }
}
