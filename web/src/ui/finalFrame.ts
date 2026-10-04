/** Generation completion is distinct from having presented its final scene. No DOM or worker dependency. */
export class FinalFrame {
  gen = 0;
  finalVer = 0;
  presentedVer = 0;
  done = false;
  begin(gen: number): void { this.gen = gen; this.finalVer = 0; this.presentedVer = 0; this.done = false; }
  content(gen: number, ver: number, final: boolean): void { if (gen === this.gen && final) this.finalVer = Math.max(this.finalVer, ver); }
  generated(gen: number): void { if (gen === this.gen) this.done = true; }
  presented(gen: number, ver: number): void { if (gen === this.gen) this.presentedVer = Math.max(this.presentedVer, ver); }
  get ready(): boolean { return this.done && this.finalVer > 0 && this.presentedVer >= this.finalVer; }
}
