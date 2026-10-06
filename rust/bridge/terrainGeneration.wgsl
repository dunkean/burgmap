// Same noise octaves and physical wavelengths as erosion::mountain.
struct Params { values: array<vec4<f32>, 3> }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> perm: array<u32>;
@group(0) @binding(2) var<storage, read> gradients: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> output: array<vec4<f32>>;
// NOISE_KERNEL
@compute @workgroup_size(8,8)
fn coarse(@builtin(global_invocation_id) id: vec3<u32>) {
  let n=u32(p.values[0].z);
  if(id.x>=n || id.y>=n){return;}
  let xy=vec2<f32>(id.xy)*p.values[1].x+(0.5*p.values[1].x+p.values[1].y);
  output[id.y*n+id.x]=vec4<f32>(
    fbm(xy/p.values[1].z+vec2<f32>(3.1,-1.7),0u,3u,0.5,0.0),
    fbm(xy/(2700.0*p.values[0].w)+vec2<f32>(8.4,0.0),1u,3u,0.5,0.0),
    fbm(xy/p.values[1].w,1u,3u,0.5,0.0),ridge(xy/p.values[1].z+vec2<f32>(5.7,-3.2),3u));
}
@compute @workgroup_size(8,8)
fn fine(@builtin(global_invocation_id) id: vec3<u32>) {
  let n=u32(p.values[0].y);
  if(id.x>=n || id.y>=n){return;}
  let xy=(vec2<f32>(id.xy)+0.5)*p.values[2].w;
  output[id.y*n+id.x]=vec4<f32>(
    fbm(xy/p.values[2].x+vec2<f32>(11.3,0.0),1u,2u,0.5,0.0),
    fbm(xy/p.values[2].x+vec2<f32>(-4.7,2.9),1u,2u,0.5,0.0),
    ridge(xy/p.values[2].y,u32(p.values[2].z)),0.0);
}
