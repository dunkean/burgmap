// Seeded finite volcanic geometry. Shared by generation and camera sampling.
fn volcanoGeometry(xy:vec2<f32>)->vec3<f32> {
  let a=volcanicParams(0u); let b=volcanicParams(1u); let c=volcanicParams(2u);
  let d=xy-a.xy; let rotated=vec2<f32>(d.x*b.x+d.y*b.y,(-d.x*b.y+d.y*b.x)/a.w);
  let outline=fbm(xy/(900.0*c.y)+vec2<f32>(c.x,-2.3),0u,3u,0.5,0.0);
  let geographic=fbm((xy+vec2<f32>(c.x,0.0))/(620.0*c.y),1u,3u,0.5,0.0);
  let wobble=1.0+select(0.12,0.18,c.z!=0.0)*outline+0.055*geographic;
  let radius=length(rotated)/(a.z*wobble);
  let rim=select(0.255,0.55,c.z!=0.0)+select(0.030,0.045,c.z!=0.0)*fbm(xy/(420.0*c.y)+vec2<f32>(c.x,0.0),1u,3u,0.5,0.0);
  return vec3<f32>(radius,rim,atan2(rotated.y,rotated.x));
}
fn volcanoOpening(g:vec3<f32>)->f32 {
  if(volcanicParams(2u).z==0.0){return 0.0;}
  let b=volcanicParams(1u); let angle=abs(atan2(sin(g.z-b.z),cos(g.z-b.z)));
  return (1.0-smooth01((angle-b.w*0.40)/(b.w*0.60)))*smooth01((g.x/g.y-0.30)/0.30);
}
fn volcanoProtection(xy:vec2<f32>)->f32 {
  if(volcanicParams(2u).z==3.0){return 1.0;}
  if(volcanicParams(2u).z==2.0){return 1.0-smooth01((plateauBoundary(xy).y+0.03)/0.10);}
  let g=volcanoGeometry(xy);
  return (1.0-smooth01((g.x-g.y)/(g.y*0.12)))*(1.0-volcanoOpening(g));
}
fn canyonInfluence(xy:vec2<f32>)->f32 {
  let c=volcanicParams(2u);let width=2400.0*c.y;
  let radius=length(xy/width-0.5);
  let outline=radius+0.035*fbm(xy/(width*0.35)+vec2<f32>(c.x,0.0),0u,3u,0.5,0.0);
  return (1.0-smooth01((outline-0.30)/0.14))*(1.0-smooth01((radius-0.39)/0.10));
}
fn volcanoInfluence(xy:vec2<f32>)->f32 {
  let c=volcanicParams(2u);let g=volcanoGeometry(xy);
  let apron=select(1.05,1.18,c.z!=0.0);
  let t=clamp((g.x-(apron-0.25))/0.40,0.0,1.0);
  let outline=1.0-t*t*t*(t*(6.0*t-15.0)+10.0);
  // Circular support vanishes before the local raster edge, including corners.
  let s=clamp((length(xy/(2400.0*c.y)-0.5)-0.39)/0.10,0.0,1.0);
  return outline*(1.0-s*s*s*(s*(6.0*s-15.0)+10.0));
}
fn volcanoElevation(xy:vec2<f32>)->f32 {
  if(volcanicParams(2u).z==2.0){return plateauElevation(xy);}
  let g=volcanoGeometry(xy); let c=volcanicParams(2u); let collapsed=c.z!=0.0;
  let floor=select(0.36,0.06,collapsed); let start=select(0.36,0.58,collapsed);
  let crest=select(0.98,0.96,collapsed); let apron=select(1.05,1.18,collapsed);
  let t=clamp((g.x/g.y-start)/(1.0-start),0.0,1.0);
  let bowl=floor+(crest-floor)*t*t*t*(t*(6.0*t-15.0)+10.0);
  let outer=crest*pow(max(0.0,1.0-(g.x-g.y)/(apron-g.y)),select(1.6,1.45,collapsed));
  var cone=mix(bowl,outer,smooth01((g.x/g.y-0.94)/0.12));
  let opening=volcanoOpening(g);
  if(collapsed){let outlet=0.06*(1.0-smooth01((g.x-g.y*0.65)/(1.18-g.y*0.65)));cone=mix(cone,outlet,opening);}
  let flutes=ridge(xy/(360.0*c.y),3u)-0.5;
  let wall=fbm(xy/(150.0*c.y),0u,3u,0.5,0.0);
  let interior=1.0-smooth01((g.x/g.y-0.82)/0.18);
  let crater=fbm(xy/(380.0*c.y),1u,3u,0.5,0.0);
  let rough=fbm((xy+vec2<f32>(volcanicParams(3u).x,0.0))/(720.0*c.y),0u,4u,0.5,0.0);
  let texture=(0.018*rough+(0.055*flutes+0.025*wall)*cone)*(1.0-interior)+0.012*crater*interior;
  return c.w*(0.035+cone+texture*(1.0-opening));
}

// Signed union of lobes, bays and detached mesas; shared with the CPU shape.
fn plateauBoundary(xy:vec2<f32>)->vec2<f32>{
  let a=volcanicParams(0u);let b=volcanicParams(1u);let c=volcanicParams(2u);let d=(xy-a.xy)/a.z;
  let rotated=vec2<f32>(d.x*b.x+d.y*b.y,(-d.x*b.y+d.y*b.x)/a.w);
  let warped=rotated+0.10*vec2<f32>(fbm(xy/(700.0*c.y)+vec2<f32>(c.x,0.0),0u,3u,0.5,0.0),fbm(xy/(700.0*c.y)-vec2<f32>(0.0,c.x),1u,3u,0.5,0.0));
  let detached=b.w>0.72;var boundary=select(length(warped)-0.31,10.0,detached);
  let count=3u+u32(floor(b.w*5.0));
  for(var i=0u;i<count;i++){
    let f=f32(i);let angle=c.x*0.13+f*2.399963;
    let radius=0.28+0.29*(0.5+0.5*sin(c.x*0.37+f*1.71));
    let lobe=select(0.20,0.14,detached)+0.10*(0.5+0.5*sin(c.x*0.83+f*2.31));
    boundary=min(boundary,length(warped-radius*vec2<f32>(cos(angle),sin(angle)))-lobe);
  }
  if(b.w<0.45){let angle=c.x*0.21;boundary=max(boundary,0.27-length(warped-0.44*vec2<f32>(cos(angle),sin(angle))));}
  boundary=max(boundary,length(d)-0.80);
  return vec2<f32>(rotated.x,boundary);
}
fn plateauInfluence(xy:vec2<f32>)->f32{return 1.0-smooth01((plateauBoundary(xy).y+0.01)/0.15);}
fn plateauElevation(xy:vec2<f32>)->f32{
  let a=volcanicParams(0u);let b=volcanicParams(1u);let c=volcanicParams(2u);
  let apron=1.0-smooth01((plateauBoundary(xy).y+0.03)/0.10);
  // Former summit shelves/detail inside the retained multi-lobe footprint.
  let d=(xy-a.xy)/a.z;
  let rotated=vec2<f32>(d.x*b.x+d.y*b.y,(-d.x*b.y+d.y*b.x)/a.w);
  let radial=length(rotated);
  let summitBoundary=radial+0.12*fbm(xy/(840.0*c.y)+vec2<f32>(c.x,0.0),0u,4u,0.5,0.0)+0.025*fbm(xy/(500.0*c.y),1u,2u,0.5,0.0);
  let upper=(1.0-smooth01((summitBoundary-b.z)/0.11))*apron;
  let lobe=smooth01((fbm(xy/(650.0*c.y)+vec2<f32>(c.x,0.0),1u,3u,0.5,0.0)-0.03)/0.22);
  let buttes=smooth01((fbm(xy/(510.0*c.y)-vec2<f32>(c.x,0.0),0u,3u,0.5,0.0)-0.16)/0.22)*(1.0-smooth01((radial-1.0)/0.22));
  let remnant=ridge(xy/(250.0*c.y),4u);
  let rough=fbm((xy+vec2<f32>(volcanicParams(3u).x,0.0))/(720.0*c.y),0u,4u,0.5,0.0);
  return c.w*(0.06+0.60*apron+0.20*upper+0.035*lobe*apron+0.08*buttes*(1.0-apron)+0.012*remnant*upper+0.010*rough);
}
