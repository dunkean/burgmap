// Disposable precision experiment: retained CPU erosion, GPU camera sampling.
// The runner substitutes FIELD_TYPE; FP16 storage still accumulates in FP32.
struct Params { values: array<vec4<f32>, 4> }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> field: array<FIELD_TYPE>;
@group(0) @binding(2) var<storage, read> perm: array<u32>;
@group(0) @binding(3) var<storage, read> gradients: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> output: array<vec4<OUT_TYPE>>;

fn smooth01(t0: f32) -> f32 {
  let t = clamp(t0, 0.0, 1.0); return t*t*(3.0-2.0*t);
}
fn simplex(xy: vec2<f32>, which: u32) -> f32 {
  let f2 = 0.3660254037844386; let g2 = 0.21132486540518713;
  let ij = vec2<i32>(floor(xy + (xy.x + xy.y)*f2));
  let a = xy - (vec2<f32>(ij) - f32(ij.x + ij.y)*g2);
  let step = select(vec2<i32>(0,1), vec2<i32>(1,0), a.x > a.y);
  let ii = u32(ij.x & 255); let jj = u32(ij.y & 255); let base = which*512u;
  let coords = array<vec2<f32>,3>(a, a-vec2<f32>(step)+g2, a-1.0+2.0*g2);
  let indices = array<u32,3>(ii+perm[base+jj], ii+u32(step.x)+perm[base+jj+u32(step.y)], ii+1u+perm[base+jj+1u]);
  var result = 0.0;
  for(var k=0u; k<3u; k++) {
    let v = coords[k]; let q = 0.5-v.x*v.x-v.y*v.y;
    if(q > 0.0) {
      let grad = gradients[which*32u+(perm[base+indices[k]] & 31u)];
      result += q*q*q*q*dot(grad,v);
    }
  }
  return 75.0*result;
}
fn fbm(xy: vec2<f32>, which: u32, octaves: u32, gain: f32, footprint: f32) -> f32 {
  var amp=1.0; var freq=1.0; var sum=0.0; var norm=0.0;
  for(var o=0u; o<octaves; o++) {
    let weight = 1.0-smooth01((footprint*freq-0.125)/0.125);
    if(weight > 0.0) { sum += amp*weight*simplex(xy*freq+vec2<f32>(f32(o)*17.3,-f32(o)*9.1),which); }
    norm += amp; amp *= gain; freq *= 2.0;
  }
  return sum/norm;
}
fn weights(t: f32) -> vec4<f32> {
  let t3=t*t*t; let omt=1.0-t;
  return vec4<f32>(omt*omt*omt,3.0*t3-6.0*t*t+4.0,-3.0*t3+3.0*t*t+3.0*t+1.0,t3)/6.0;
}
fn at_level(uv: vec2<f32>, level: u32) -> f32 {
  let n=1024u >> level; var offset=0u;
  for(var l=0u;l<level;l++){let size=1024u >> l; offset+=size*size;}
  let pos=uv*f32(n)-0.5; let origin=vec2<i32>(floor(pos));
  let wx=weights(pos.x-f32(origin.x)); let wy=weights(pos.y-f32(origin.y));
  var value=0.0;
  for(var j=0u;j<4u;j++) {
    let row=u32(clamp(origin.y+i32(j)-1,0,i32(n)-1));
    for(var i=0u;i<4u;i++) {
      let col=u32(clamp(origin.x+i32(i)-1,0,i32(n)-1));
      value+=f32(field[offset+row*n+col])*wx[i]*wy[j];
    }
  }
  return value;
}
fn surface(uv: vec2<f32>) -> f32 {
  if(p.values[1].z == 0.0){return 0.0;}
  let lower=u32(p.values[3].x); let upper=u32(p.values[3].y); let t=p.values[3].z;
  let a=at_level(uv,lower);
  if(t==0.0){return a;}
  return a*(1.0-t)+at_level(uv,upper)*t;
}
fn height_at(xy: vec2<f32>) -> f32 {
  let map=p.values[0].x; let motif=p.values[0].y; let phase=p.values[0].z; let amp=p.values[0].w;
  let cell=p.values[2].w; var h=0.0;
  if(p.values[1].y == 0.0) {
    let scale=motif/2400.0;
    let shifted=xy+vec2<f32>(phase,0.0);
    let swell=fbm(shifted/(1200.0*scale),0u,4u,0.42,cell/(1200.0*scale));
    let rough=fbm(shifted/(720.0*scale),0u,4u,0.5,cell/(720.0*scale));
    let uv=0.5+0.44*vec2<f32>(fbm(xy/motif+vec2<f32>(11.3,0.0),1u,2u,0.5,0.0),fbm(xy/motif+vec2<f32>(-4.7,2.9),1u,2u,0.5,0.0));
    h=amp*(0.45+0.275*swell+0.065*rough)+surface(uv);
  } else { h=surface(xy/map); }
  return clamp(h,0.3,p.values[1].x);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n=u32(p.values[1].w); if(gid.x>=n || gid.y>=n){return;}
  let xy=p.values[2].xy+(vec2<f32>(gid.xy)+0.5)*p.values[2].w;
  let eps=p.values[3].w;
  let gx=(height_at(xy+vec2<f32>(eps,0.0))-height_at(xy-vec2<f32>(eps,0.0)))/(2.0*eps);
  let gy=(height_at(xy+vec2<f32>(0.0,eps))-height_at(xy-vec2<f32>(0.0,eps)))/(2.0*eps);
  let normal=normalize(vec3<f32>(-gx,-gy,1.0));
  output[gid.y*n+gid.x]=vec4<OUT_TYPE>(vec4<f32>(height_at(xy),normal));
}
