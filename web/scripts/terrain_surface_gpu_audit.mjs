// One-off seeded surface/GPU diagnostic; no test suite or visual certificate.
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const origin = process.env.TERRAIN_URL ?? 'http://localhost:5175';
await mkdir(root + '/rust/out/perf-audit', { recursive: true });
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage(); const errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.route('**/surface-empty',r=>r.fulfill({contentType:'text/html',body:'<html></html>'}));
await page.route('**/favicon.ico',r=>r.fulfill({status:204}));
try{
await page.goto(origin + '/surface-empty');
await page.evaluate(async root=>{
 const {sampleRustTerrain}=await import('/@fs/' + root.replaceAll('\\', '/') + '/rust/bridge/terrain.ts');
 const baselines = new Map();
 window.probe=async(settings)=>{
  const t=await sampleRustTerrain({id:1,generation:1,kind:'overview',settings,region:{x:0,y:0,extent:settings.width,resolution:256}});
  if(settings.generationCompute==='gpu-erosion' && t.generationBackend!=='gpu-erosion-f32')throw Error(t.generationReason||'GPU generation did not run');
  if(![t.height,t.normalX,t.normalY,t.normalZ].every(a=>a.every(Number.isFinite)))throw Error('Nonfinite terrain');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',t.height))).map(v=>v.toString(16).padStart(2,'0')).join('');
  const key=JSON.stringify([settings.relief,settings.width,settings.motifSize,settings.seed]);
  if(settings.erosion===0) baselines.set(key,t);
  const baseline=baselines.get(key);let change=0;
  let slopeSquare=0;for(let i=0;i<t.height.length;i++){if(t.normalZ[i]<=0)throw Error('Invalid normal');slopeSquare+=1/(t.normalZ[i]*t.normalZ[i])-1;
    if(baseline){const dx=t.normalX[i]/t.normalZ[i]-baseline.normalX[i]/baseline.normalZ[i];const dy=t.normalY[i]/t.normalZ[i]-baseline.normalY[i]/baseline.normalZ[i];change+=dx*dx+dy*dy;}}
  return {settings,backend:t.backend,generation:t.generationBackend,reason:t.generationReason,prepareMs:t.prepareMs,gpuMs:t.gpuSimulationMs,samplingMs:t.samplingMs,min:t.minHeight,max:t.maxHeight,slopeRms:Math.sqrt(slopeSquare/t.height.length),slopeChangeRms:baseline?Math.sqrt(change/t.height.length):undefined,hash};
 };
},root);
const rows=[];
const cases=process.argv.includes('environment')?['valley','volcano','caldera'].flatMap(relief=>['gpu-erosion','cpu'].map(generationCompute=>({relief,generationCompute,width:12000,seed:'42',erosion:1}))).concat([{relief:'valley',width:12000,seed:'42',erosion:1,generationCompute:'gpu-all'}]):process.argv.includes('plateau')?[...[0,1,2].map(erosion=>({relief:'plateau',width:3000,seed:'42',erosion})),{relief:'plateau',width:3000,seed:'42',erosion:1,generationCompute:'cpu'},{relief:'plateau',width:3000,seed:'42',erosion:1}]:process.argv.includes('large')?[{relief:'hills',width:50000,seed:'lp13l2',erosion:1},{relief:'mountains',width:50000,seed:'42',erosion:1},{relief:'caldera',width:50000,seed:'42',erosion:1}]:[
 ...['hills','mountains','volcano','caldera','plateau','canyon'].flatMap(relief=>[0,1,2].map(erosion=>({relief,erosion,width:3000,seed:'42'}))),
 {relief:'hills',width:5000,seed:'lp13l2',erosion:.62},
 {relief:'volcano',width:3000,seed:'42',erosion:1,generationCompute:'cpu'},
 {relief:'caldera',width:3000,seed:'42',erosion:1,generationCompute:'cpu'},
 {relief:'plateau',width:3000,seed:'42',erosion:1,generationCompute:'cpu'},
 {relief:'mountains',width:10000,motifSize:10000,seed:'42',erosion:1},
 {relief:'volcano',width:500,motifSize:250,seed:'42',erosion:1},
 {relief:'mixed',width:3000,mountainMix:0,seed:'42',erosion:1},
 {relief:'mixed',width:3000,mountainMix:1,seed:'42',erosion:1},
 {relief:'high-mountains',width:3000,seed:'42',erosion:1},
 {relief:'valley',width:3000,seed:'42',erosion:1},
 {relief:'volcano',width:3000,seed:'42',erosion:1},
 {relief:'caldera',width:3000,seed:'42',erosion:1},
];
for(const v of cases){const row=await page.evaluate(s=>window.probe(s),{motifSize:3000,mountainMix:.5,compute:'gpu-f32',generationCompute:'gpu-erosion',resolution:256,...v});rows.push(row);console.log(JSON.stringify(row));await writeFile(root+'/rust/out/perf-audit/surface-'+(process.argv.includes('large')?'large':process.argv.includes('plateau')?'plateau':process.argv.includes('environment')?'environment':'current')+'.json',JSON.stringify({errors,rows},null,2));}
if(errors.length)throw Error(JSON.stringify(errors));
}finally{await browser.close();}
