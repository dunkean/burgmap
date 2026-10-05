import { describe, expect, it } from 'vitest';
import type { MapInformation } from '../src/render/legend';
import { mapInformationHtml } from '../src/ui/mapInformation';
import { FrameHandoff } from '../src/ui/frameHandoff';
import type { GDone } from '../src/ui/protocol';

const info = (title: string): MapInformation => ({
  cartouche: { w: 244, h: 72, prims: [{ t: 'text', x: 12, y: 24, s: title, size: 16, anchor: 'start', fill: '#333' }] },
  legend: { w: 300, h: 120, prims: [{ t: 'text', x: 12, y: 24, s: 'Rock & fungi', size: 12, anchor: 'start', fill: '#333' }] },
  fontFamily: 'Georgia, serif',
});
const meta = (title: string): GDone['meta'] => ({ center: { x: 800, y: 800 }, anchors: {}, mapSize: 1600, mapInfo: info(title) });

describe('map information outside compact viewports', () => {
  it('keeps generated names as escaped SVG text and includes both readable panels', () => {
    const html = mapInformationHtml(info('<script>alert("name")</script> & town'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt; &amp; town');
    expect(html).toContain('Rock &amp; fungi');
    expect(html.match(/role="img"/g)).toHaveLength(2);
  });

  it('retains the displayed map information until the replacement bitmap arrives', () => {
    const state = new FrameHandoff();
    const old = meta('Old hold'), next = meta('New colony');
    state.begin(1); state.content(1, 1, true, old); state.presented(1, 1);
    state.begin(2); state.content(2, 2, true, next);
    expect(state.displayedMeta?.mapInfo).toBe(old.mapInfo);
    state.presented(2, 1);
    expect(state.displayedMeta?.mapInfo).toBe(old.mapInfo);
    state.presented(2, 2);
    expect(state.displayedMeta?.mapInfo).toBe(next.mapInfo);
    state.content(1, 3, true, old); state.presented(1, 3);
    expect(state.displayedMeta?.mapInfo).toBe(next.mapInfo);
  });
});
