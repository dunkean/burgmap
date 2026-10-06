// One-off boundary/offline diagnostics; appearance remains for user validation.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
const browser=await chromium.launch({channel:'chrome',headless:true});
let fallbackBrowser;
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/gpu-empty',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
await page.route('**/favicon.ico',route=>route.fulfill({status:204}));
try {
  await page.goto('http://localhost:5175/gpu-empty');
  const numeric=await page.evaluate(async root=>{
    const {sampleRustTerrain}=await import('/@fs/'+root.replaceAll('\\','/')+'/rust/bridge/terrain.ts');
    const numeric=[];
    for(const [relief,width,erosion] of [['mountains',8000,.5],['hills',8000,.5],['valley',8000,.5],['mountains',12000,1],['hills',3000,0]]) {
      const settings={seed:'1a72a9n',width,motifSize:3000,erosion,relief,mountainMix:0.5,resolution:256};
      for(const region of [{x:0,y:0,extent:width,resolution:256},{x:width*.36,y:width*.51,extent:48.5,resolution:256}]) {
        const req={settings:{...settings,compute:'wasm'},region,id:1,generation:1,kind:'detail'};
        const ref=await sampleRustTerrain(req);
        for(const compute of ['gpu-f32']) {
          const data=await sampleRustTerrain({...req,settings:{...settings,compute}});
          if(data.backend!==compute)throw new Error(data.backendReason??'GPU fallback');
          let heightMax=0,normalMax=0,nonfinite=0;
          for(let i=0;i<data.height.length;i++) {
            heightMax=Math.max(heightMax,Math.abs(ref.height[i]-data.height[i]));
            for(const key of ['height','normalX','normalY','normalZ']) {
              if(!Number.isFinite(data[key][i]))nonfinite++;
              if(key!=='height')normalMax=Math.max(normalMax,Math.abs(ref[key][i]-data[key][i]));
            }
          }
          // Quantitative drift is reported for user assessment, never a visual veto.
          if(nonfinite || data.height.length!==region.resolution**2) throw new Error(JSON.stringify({relief,extent:region.extent,compute,heightMax,normalMax,nonfinite}));
          numeric.push({relief,extent:region.extent,compute,generationBackend:data.generationBackend,heightMax,normalMax,nonfinite});
        }
      }
    }
    return numeric;
  },root);
  await page.goto(pathToFileURL(root+'/rust/out/browser/terrainbench.html').href+'?seed=42&width=3000&motif=3000&relief=valley&erosion=0.5&compute=gpu-f32&generation=gpu&auto=0');
  await page.waitForFunction(()=>document.getElementById('status')?.textContent.includes('détail 768'),{timeout:120000});
  const offline=await page.locator('#status').textContent();
  if(!offline.includes('bruits fins GPU FP32 + érosion CPU'))throw new Error('Offline GPU not active');
  await page.locator('#zoomIn').click({clickCount:3});
  await page.waitForTimeout(1500);
  const zoom=await page.locator('#status').textContent();
  for(const generation of ['cpu','gpu-all','gpu'])await page.locator('#generationCompute').selectOption(generation);
  await page.waitForFunction(()=>document.getElementById('status')?.textContent.includes('bruits fins GPU FP32 + érosion CPU')&&document.getElementById('status')?.textContent.includes('détail 768'),{timeout:120000});
  const switched=await page.locator('#status').textContent();
  fallbackBrowser=await chromium.launch({headless:true});
  const fallback=await fallbackBrowser.newPage();
  fallback.on('pageerror',e=>errors.push(e.message));
  await fallback.goto('http://localhost:5175/terrainbench.html?seed=42&width=3000&motif=3000&relief=hills&erosion=0.5&compute=gpu-f32&generation=gpu');
  await fallback.waitForFunction(()=>document.getElementById('status')?.textContent.includes('détail 768'),{timeout:120000});
  const unavailable=await fallback.locator('#status').textContent();
  if(!unavailable.includes('CPU Rust (WebGPU indisponible)'))throw new Error('Unavailable GPU fallback missing: '+unavailable);
  const result={browser:browser.version(),errors,numeric,offline,zoom,switched,unavailable};
  await writeFile(root+'/rust/out/perf-audit/gpu-boundary.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(errors.length)throw new Error(JSON.stringify(errors));
} finally {await fallbackBrowser?.close();await browser.close();}
