// Shared FP32 simplex and FBM kernels.
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

fn ridge(xy:vec2<f32>,octaves:u32)->f32 {
  var amp=1.0;var freq=1.0;var sum=0.0;var norm=0.0;var weight=1.0;
  for(var o=0u;o<octaves;o++){let r=1.0-abs(simplex(xy*freq+vec2<f32>(f32(o)*31.7,f32(o)*5.3),1u));let v=r*r*weight;weight=clamp(v*1.6,0.0,1.0);sum+=amp*(0.5+(v-0.5));norm+=amp;amp*=0.5;freq*=2.0;}
  return sum/norm;
}
