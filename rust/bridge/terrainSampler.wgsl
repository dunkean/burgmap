// FP32 sampling of the retained Rust erosion field.
struct Params { values: array<vec4<f32>, 9> }
override FAMILY: u32 = 0u;
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read> perm: array<u32>;
@group(0) @binding(3) var<storage, read> gradients: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> output: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> branches: array<vec4<f32>>;

// NOISE_KERNEL
fn volcanicParams(i:u32)->vec4<f32>{return p.values[5u+i];}
// VOLCANIC_KERNEL
fn weights(t: f32) -> vec4<f32> {
  let t3=t*t*t; let omt=1.0-t;
  return vec4<f32>(omt*omt*omt,3.0*t3-6.0*t*t+4.0,-3.0*t3+3.0*t*t+3.0*t+1.0,t3)/6.0;
}
fn at_level_offset(uv: vec2<f32>, level: u32, start:u32) -> f32 {
  let n=1024u >> level; var offset=start;
  for(var l=0u;l<level;l++){let size=1024u >> l; offset+=size*size;}
  let pos=uv*f32(n)-0.5; let origin=vec2<i32>(floor(pos));
  let wx=vec4<f32>(weights(pos.x-f32(origin.x))); let wy=vec4<f32>(weights(pos.y-f32(origin.y)));
  var value=f32(0.0);
  for(var j=0u;j<4u;j++) {
    let row=u32(clamp(origin.y+i32(j)-1,0,i32(n)-1));
    for(var i=0u;i<4u;i++) {
      let col=u32(clamp(origin.x+i32(i)-1,0,i32(n)-1));
      value+=f32(field[offset+row*n+col])*wx[i]*wy[j];
    }
  }
  return f32(value);
}
fn at_level(uv:vec2<f32>,level:u32)->f32{return at_level_offset(uv,level,0u);}
fn filteredSurface(uv:vec2<f32>,footprint:f32,start:u32)->f32 {
  let lod=clamp(log2(max(1.0,footprint*1024.0)),0.0,10.0);let l=u32(floor(lod));
  return mix(at_level_offset(uv,l,start),at_level_offset(uv,min(l+1u,10u),start),fract(lod));
}
fn surface(uv: vec2<f32>) -> f32 {
  if(p.values[1].z == 0.0){return 0.0;}
  let lower=u32(p.values[3].x); let upper=u32(p.values[3].y); let t=p.values[3].z;
  let a=at_level(uv,lower);
  if(t==0.0){return a;}
  return a*(1.0-t)+at_level(uv,upper)*t;
}
fn valley_wall(along: f32, across: f32, footprint: f32) -> f32 {
  let motif=p.values[0].y;
  let center=branches[0].y+motif*(2.8*fbm(vec2<f32>(along/(motif*12.0),branches[0].x),0u,2u,0.5,0.0)
    +0.65*fbm(vec2<f32>(along/(motif*3.2),7.1),1u,2u,0.5,0.0)
    +0.10*fbm(vec2<f32>(along/motif,3.7),0u,2u,0.5,0.0));
  let floor_width=motif*0.065; let slope=max(motif*0.32,footprint);
  var wall=smooth01((abs(across-center)-floor_width)/slope);
  let cell=i32(floor(along/(motif*2.6)));
  for(var index=cell-1;index<=cell+2;index++) {
    let slot=index-i32(branches[0].z);
    if(slot<0 || slot>=i32(branches[0].w)){continue;}
    for(var bank=0u;bank<2u;bank++) {
      let branch=branches[1u+u32(slot)*2u+bank];
      let side=select(-1.0,1.0,bank==1u);
      let r=side*(across-branch.y);
      if(r < -motif*0.25 || r > branch.z){continue;}
      let t=max(0.0,r/branch.z);
      let bend=motif*0.22*sin(t*3.141592653589793)*sin(branch.w+t*3.0)*smooth01(t/0.15);
      let branch_along=branch.x-0.85*r+bend;
      let d=abs(along-branch_along)/1.31;
      let taper=1.0-smooth01((t-0.45)/0.55);
      let branch_wall=smooth01((d-floor_width*0.65*taper)/(slope*0.7));
      let entrance=smooth01((r+motif*0.25)/(motif*0.25));
      let other=1.0-(1.0-branch_wall)*taper*entrance;
      let width=0.22*smooth01((1.0-wall)/0.15)*smooth01((1.0-other)/0.15);
      var blend=0.0;
      if(width>1e-9){blend=max(0.0,(width-abs(wall-other))/width);}
      wall=max(0.0,min(wall,other)-width*0.25*blend*blend);
    }
  }
  return wall;
}
fn height_at(xy: vec2<f32>) -> f32 {
  let map=p.values[0].x; let motif=p.values[0].y; let phase=p.values[0].z; let amp=p.values[0].w;
  let cell=p.values[2].w; var h=0.0;
  if(FAMILY == 0u) {
    let scale=motif/2400.0;
    let shifted=xy+vec2<f32>(phase,0.0);
    let swell=fbm(shifted/(1200.0*scale),0u,4u,0.42,cell/(1200.0*scale));
    let rough=fbm(shifted/(720.0*scale),0u,4u,0.5,cell/(720.0*scale));
    let uv=0.5+0.44*vec2<f32>(fbm(xy/motif+vec2<f32>(11.3,0.0),1u,2u,0.5,0.0),fbm(xy/motif+vec2<f32>(-4.7,2.9),1u,2u,0.5,0.0));
    h=amp*(0.45+0.275*swell+0.065*rough)+surface(uv);
  } else if(FAMILY == 3u) {
    // Complete local and regional mip chains; physical motif scale survives map enlargement.
    let start=1398101u;
    let surroundings=filteredSurface(xy/map,cell/map,start);
    let origin=volcanicParams(3u).yz;
    let uv=(xy-origin)/motif;
    let edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
    let plateau=volcanicParams(2u).z==2.0;
    var weight=0.0;
    if(plateau){
      let t=clamp(edge/0.045,0.0,1.0);
      weight=t*t*t*(t*(6.0*t-15.0)+10.0)*plateauInfluence(uv*motif);
    }else if(volcanicParams(2u).z==3.0){weight=canyonInfluence(uv*motif);}
    else{weight=volcanoInfluence(uv*motif);}
    if(weight==0.0){h=surroundings;}else{
      let foundation=filteredSurface((origin+motif*0.5)/map,motif*0.35/map,start);
      let local=filteredSurface(uv,cell/motif,0u)+foundation;
      let protection=volcanoProtection(uv*motif);let k=amp*0.18;
      let overlap=max(0.0,1.0-abs(local-surroundings)/k);
      let joined=mix(max(local,surroundings)+k*overlap*overlap*0.25,local,protection);
      h=mix(surroundings,joined,weight);
    }
  } else {
    h=surface(xy/map);
    if(FAMILY == 2u) {
      let delta=xy-map*0.5; let down=p.values[4].xy;
      let along=dot(delta,down); let across=dot(delta,vec2<f32>(-down.y,down.x));
      let rough=fbm((xy+vec2<f32>(phase,0.0))/(720.0*motif/2400.0),0u,4u,0.5,cell/(720.0*motif/2400.0));
      h=amp*(0.06+0.012*rough)+h*pow(valley_wall(along,across,cell),1.2);
    }
  }
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
  output[gid.y*n+gid.x]=vec4<f32>(vec4<f32>(height_at(xy),normal));
}
