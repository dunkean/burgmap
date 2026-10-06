// The dedicated third simplex stream matches Rust's shore-noise fork.
// Each capsule is three vec4s: endpoints; radii/scale/phase; islet relief/apron.
@group(0) @binding(6) var<storage, read> coast: array<vec4<f32>>;
fn mainlandReach(mask:u32, direction:u32)->f32 {
  return select(0.64,1.50,(mask&(1u<<(direction&7u)))==0u);
}
fn coastalHeight(xy:vec2<f32>, terrainHeight:f32)->f32 {
  let config=coast[0];let mask=u32(config.x);
  if(mask==0u){return terrainHeight;}
  // Same marine datum and smooth positive floor as Rust coastal plains.
  var height=terrainHeight;
  let datum=coast[1].w;
  if(datum>0.0){let relative=height-datum;height=0.3+0.5*(relative+sqrt(relative*relative+1.0));}
  let uv=xy/p.values[0].x;let footprint=p.values[2].w/p.values[0].x;
  var distance=-2.0;var scale=0.2;var isletHeight=0.0;var apron=1.0;
  if(mask!=255u){
    let delta=uv-0.5;let r=length(delta);
    var angle=0.0;var edge=0.5;
    if(r>0.0){
      let turns=atan2(delta.x,-delta.y)/6.283185307179586;
      angle=fract(turns+1.0)*8.0;
      let profile=coast[1];let rotated=vec2<f32>(dot(delta,profile.yz),dot(delta,vec2<f32>(-profile.z,profile.y)));
      edge=0.5*r/pow(pow(abs(rotated.x),profile.x)+pow(abs(rotated.y),profile.x),1.0/profile.x);
    }
    let a=u32(floor(angle));let t=smooth01(fract(angle));
    distance=edge*mix(mainlandReach(mask,a),mainlandReach(mask,a+1u),t)-r
      +0.070*fbm(uv/0.26,2u,7u,0.56,footprint/0.26)
      +0.020*fbm(uv/0.055,2u,5u,0.55,footprint/0.055);
  }
  var cachedPhase=-1.0;var detail=0.0;
  for(var i=0u;i<u32(config.y);i++){
    let ends=coast[2u+i*3u];let shape=coast[3u+i*3u];let geology=coast[4u+i*3u];let delta=ends.zw-ends.xy;
    let t=clamp(dot(uv-ends.xy,delta)/max(dot(delta,delta),1e-12),0.0,1.0);
    let base=mix(shape.x,shape.y,t)-length(uv-ends.xy-t*delta);let s=shape.z;
    if(base+s*0.165<=distance){continue;}
    if(shape.w!=cachedPhase){
      detail=s*(0.14*fbm(uv/(s*1.1)+vec2<f32>(shape.w,-shape.w),2u,7u,0.56,footprint/(s*1.1))
        +0.025*fbm(uv/(s*0.13)+vec2<f32>(-shape.w,shape.w),2u,4u,0.55,footprint/(s*0.13)));
      cachedPhase=shape.w;
    }
    if(base+detail>distance){
      distance=base+detail;scale=s;apron=geology.w;
      // Same simple elevation as Rust; shore taper and erosion provide slopes.
      isletHeight=geology.x;
    }
  }
  if(isletHeight>0.0){height=isletHeight;}
  let cliff=smooth01((fbm(uv/0.12,2u,3u,0.5,0.0)-0.20)/0.25);
  let widthVariation=0.65+1.1*smooth01(fbm(uv/0.21+vec2<f32>(11.7,-4.2),2u,3u,0.5,0.0)+0.5);
  let ramp=min(max(config.z,height/(p.values[0].x*0.45)),scale*0.18)*widthVariation*apron*(1.0-0.90*cliff);
  if(distance<=0.0){return -config.w*smooth01(-distance/(ramp*4.0));}
  return height*smooth01(distance/ramp);
}
