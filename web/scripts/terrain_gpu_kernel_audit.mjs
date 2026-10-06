// Repeated timings of actual integrated code, at identical camera resolution.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/gpu-empty', route => route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
await page.route('**/favicon.ico',route => route.fulfill({status:204}));
try {
  await page.goto('http://localhost:5173/gpu-empty');
  await page.evaluate(async root => {
    const prefix='/@fs/'+root.replaceAll('\\','/');
    window.sample = (await import(prefix+'/rust/bridge/terrain.ts')).sampleRustTerrain;
    window.render = (await import(prefix+'/rust/bridge/terrainRender.ts')).renderRustTerrain;
    window.kernelCase = async (relief,seed,region) => {
      const settings={seed,width:8000,motifSize:3000,relief,erosion:0.5,mountainMix:0.5,resolution:768};
      const passes=[];
      for(let pass=0;pass<2;pass++) {
        const modes=['gpu-f32'];
        if(pass)modes.reverse();
        for(const compute of modes) {
          const readings=[];
          for(let repeat=0;repeat<7;repeat++) {
            const data=await window.sample({settings:{...settings,compute},region,id:1,generation:1,kind:'detail'});
            if(data.backend!==compute)throw new Error(data.backendReason??'Unexpected fallback');
            const started=performance.now();window.render(data,'parchment',false);
            readings.push({samplingMs:data.samplingMs,setupMs:data.gpuSetupMs,prepareMs:data.prepareMs,renderMs:performance.now()-started,backend:data.backend});
          }
          passes.push({compute,pass,cold:readings[0],warm:readings.slice(1)});
        }
      }
      return {relief,seed,region,passes};
    };
  },root);
  const results=[];
  for(const relief of ['mountains','hills','valley']) {
    for(const region of [{x:0,y:0,extent:8000,resolution:768},{x:2911.19,y:4107.23,extent:48.5,resolution:768}]) {
      const result=await page.evaluate(({relief,region})=>window.kernelCase(relief,'1a72a9n',region),{relief,region});
      results.push(result);
      const summaries=['gpu-f32'].map(compute=>{
        const r=result.passes.filter(p=>p.compute===compute).flatMap(p=>p.warm);
        const median=values=>{values.sort((a,b)=>a-b);return (values[5]+values[6])/2;};
        return {compute,samplingMs:median(r.map(x=>x.samplingMs)),renderMs:median(r.map(x=>x.renderMs)),totalMs:median(r.map(x=>x.samplingMs+x.renderMs))};
      });
      result.summaries=summaries;
      console.log(JSON.stringify({relief,extent:region.extent,summaries}));
    }
  }
  await writeFile(root+'/rust/out/perf-audit/gpu-kernels.json',JSON.stringify({browser:browser.version(),errors,results},null,2));
  if(errors.length)throw new Error(JSON.stringify(errors));
} finally {await browser.close();}
