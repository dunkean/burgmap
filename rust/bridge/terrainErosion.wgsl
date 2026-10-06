// Full FP32 regional erosion. Dispatches are global synchronization boundaries.
struct Params { values: array<vec4<f32>, 12> }
struct Node {
  h: f32, uplift: f32, acc: f32, receiver: i32,
  flood: array<vec2<f32>,2>, flow: vec4<f32>, state: array<vec2<f32>,2>,
  thermal: vec2<f32>, nextH: f32, routingPriority: f32,
  parent: atomic<u32>, bottom: atomic<u32>, spill: atomic<u32>, pour: atomic<u32>,
  breached: atomic<u32>,
}
struct Control {
  flags: array<atomic<u32>,2>, errors: atomic<u32>, padding: u32,
  histogram: array<atomic<u32>,256>,
  prefix: u32, quantileIndex: u32, selected: u32, pad: u32,
  p99: f32, p1: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> perm: array<u32>;
@group(0) @binding(2) var<storage, read> gradients: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> nodes: array<Node>;
@group(0) @binding(4) var<storage, read_write> fine: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> control: Control;
// NOISE_KERNEL
fn volcanicParams(i:u32)->vec4<f32>{return p.values[8u+i];}
// VOLCANIC_KERNEL
const directions = array<vec2<i32>,8>(vec2<i32>(1,0),vec2<i32>(1,1),vec2<i32>(0,1),vec2<i32>(-1,1),vec2<i32>(-1,0),vec2<i32>(-1,-1),vec2<i32>(0,-1),vec2<i32>(1,-1));
const distances = array<f32,8>(1.0,1.4142135623730951,1.0,1.4142135623730951,1.0,1.4142135623730951,1.0,1.4142135623730951);
fn size() -> u32 {return u32(p.values[0].z);}
fn count() -> u32 {return size()*size();}
fn edge(i:u32) -> bool {let n=size();return i%n==0u || i/n==0u || i%n==n-1u || i/n==n-1u;}
fn neighbor(i:u32,d:u32) -> i32 {
  let n=i32(size());let q=vec2<i32>(i32(i)%n,i32(i)/n)+directions[d];
  if(any(q<vec2<i32>(0)) || any(q>=vec2<i32>(n))){return -1;}
  return q.y*n+q.x;
}
fn ordered(v:f32)->u32 {let b=bitcast<u32>(v);return select(b^0x80000000u,~b,(b&0x80000000u)!=0u);}
fn decoded(v:u32)->f32{return bitcast<f32>(select(~v,v^0x80000000u,(v&0x80000000u)!=0u));}
fn rootOf(i:u32)->u32 {
  var r=i;
  // Parents decrease monotonically; at most count() hops, with an explicit
  // final return for compilers which conservatively analyze loop exits.
  for(var step=0u;step<count();step++) {
    let next=atomicLoad(&nodes[r].parent);
    if(next==r || next==0xffffffffu){return next;}
    r=next;
  }
  atomicAdd(&control.errors,1u);
  return r;
}
fn lower(a:vec2<f32>,b:vec2<f32>)->bool {return a.x<b.x || (a.x==b.x && a.y<b.y);}
fn seededRoutingPriority(i:u32)->f32 {
  var tie=i^perm[(i>>8u)&255u];tie=(tie^(tie>>16u))*0x7feb352du;tie=(tie^(tie>>15u))*0x846ca68bu;tie^=tie>>16u;
  return 0.5+f32(tie&65535u)/65535.0;
}
@compute @workgroup_size(256)
fn initialize(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count()){return;}let n=size();
  let xy=(vec2<f32>(f32(i%n),f32(i/n))+0.5)*p.values[1].x+p.values[1].y;
  let env=fbm(xy/p.values[1].z+vec2<f32>(3.1,-1.7),0u,3u,0.5,0.0);
  let distribution=fbm(xy/(2700.0*p.values[0].w)+vec2<f32>(8.4,0.0),1u,3u,0.5,0.0);
  let mountains=smooth01((distribution+(p.values[3].z-0.5)*1.4+0.28)/0.56);
  let q=dot(xy-p.values[0].x*0.5,p.values[5].xy)/p.values[0].x;
  let skeleton=ridge(xy/p.values[1].z+vec2<f32>(5.7,-3.2),3u);
  let crest=1.0+p.values[7].x*mountains*(0.24+1.8*skeleton*skeleton-1.0);
  let u=max(0.12,0.7+0.5*env-0.25*q)*(0.20+0.80*mountains)*crest;
  let border=f32(min(min(i%n,i/n),min(n-1u-i%n,n-1u-i/n)))/(0.1*f32(n));
  nodes[i].uplift=u*(0.25+0.75*smooth01(border));
  // Seeded tie priority replaces the CPU heap's incidental order on equal
  // water levels. It affects routing only, never physical height/noise.
  nodes[i].routingPriority=seededRoutingPriority(i);
  nodes[i].h=select(2.5*u+0.6*fbm(xy/p.values[1].w,1u,3u,0.5,0.0),0.0,edge(i));nodes[i].acc=1.0;
}
@compute @workgroup_size(256)
fn uplift(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}nodes[i].h=select(nodes[i].h+nodes[i].uplift*p.values[4].w,0.0,edge(i));}
@compute @workgroup_size(1)
fn start(){atomicStore(&control.flags[0],1u);atomicStore(&control.flags[1],1u);}
@compute @workgroup_size(1)
fn clearNext(){atomicStore(&control.flags[1u-u32(p.values[6].x)],0u);}
@compute @workgroup_size(256)
fn floodInit(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}nodes[i].flood[0]=select(vec2<f32>(3.4e38,1e9),vec2<f32>(nodes[i].h,0.0),edge(i));nodes[i].flood[1]=nodes[i].flood[0];}
var<workgroup> tileA:array<vec2<f32>,324>;
var<workgroup> tileB:array<vec2<f32>,324>;
var<workgroup> tileH:array<f32,324>;
var<workgroup> tileCost:array<f32,324>;
var<workgroup> tileFlow:array<vec4<f32>,324>;
var<workgroup> tileActive:u32;
// 16x16 interior plus a one-cell halo. Halo is immutable for one dispatch.
@compute @workgroup_size(16,16)
fn solveTile(@builtin(local_invocation_id) local:vec3<u32>,@builtin(workgroup_id) group:vec3<u32>){
  let lane=local.y*16u+local.x;let phase=u32(p.values[6].x);let mode=u32(p.values[6].y);
  if(lane==0u){tileActive=atomicLoad(&control.flags[phase]);}
  let run=workgroupUniformLoad(&tileActive);if(run==0u){return;}
  let base=vec2<i32>(group.xy*16u)-1;let n=i32(size());
  for(var k=lane;k<324u;k+=256u){
    let xy=base+vec2<i32>(i32(k%18u),i32(k/18u));
    var state=vec2<f32>(3.4e38,1e9);var h=3.4e38;var cost=1.0;var flow=vec4<f32>(-1.0);
    if(all(xy>=vec2<i32>(0)) && all(xy<vec2<i32>(n))){let i=u32(xy.y*n+xy.x);h=nodes[i].h;cost=nodes[i].routingPriority;flow=nodes[i].flow;state=select(nodes[i].flood[phase],nodes[i].state[phase],mode!=0u);}
    tileA[k]=state;tileB[k]=state;tileH[k]=h;tileCost[k]=cost;tileFlow[k]=flow;
  }
  workgroupBarrier();
  let xy=group.xy*16u+local.xy;let valid=all(xy<vec2<u32>(size()));let i=xy.y*size()+xy.x;let k=(local.y+1u)*18u+local.x+1u;
  let original=tileA[k];
  for(var step=0u;step<16u;step++){
    var value=tileA[k];
    if(valid){
      if(mode==0u){
        if(!edge(i)){
          for(var d=0u;d<8u;d++){let j=u32(i32(k)+directions[d].y*18+directions[d].x);let a=tileA[j];let level=max(tileH[k],a.x);
            // Prefer existing low terrain inside a filled basin. A positive
            // seeded cost breaks equal-level routing ties without raising h.
            let depthCost=1.0+8.0*exp(-max(0.0,level-(tileH[k]+tileH[j])*0.5)/max(0.1,p.values[1].x*0.1));
            let tieCost=(tileCost[k]+tileCost[j])*0.5;
            let candidate=vec2<f32>(level,select(a.y+distances[d]*depthCost*tieCost,0.0,tileH[k]>a.x));if(lower(candidate,value)){value=candidate;}}
        }
      } else if(value.y==0.0){
        var ready=true;var result=1.0;
        if(mode==1u){
          for(var d=0u;d<8u;d++){let j=u32(i32(k)+directions[d].y*18+directions[d].x);let f=tileFlow[j];var weight=0.0;if(f.x==f32(i)){weight+=1.0-f.z;}if(f.y==f32(i)){weight+=f.z;}if(weight>0.0){ready=ready && tileA[j].y!=0.0;result+=tileA[j].x*weight;}}
        } else {
          let f=tileFlow[k];result=tileH[k];
          if(f.x>=0.0){
            let a=u32(f.x);let offset=vec2<i32>(i32(a%size())-i32(xy.x),i32(a/size())-i32(xy.y));let j=u32(i32(k)+offset.y*18+offset.x);var low=tileA[j].x;ready=tileA[j].y!=0.0;
            if(f.y>=0.0 && f.z>0.0){let b=u32(f.y);let off=vec2<i32>(i32(b%size())-i32(xy.x),i32(b/size())-i32(xy.y));let s=u32(i32(k)+off.y*18+off.x);low=(1.0-f.z)*low+f.z*tileA[s].x;ready=ready && tileA[s].y!=0.0;}
            var factor=min(6.0,p.values[5].z*min(sqrt(nodes[i].acc),4.0*sqrt(0.004)*p.values[0].w*2400.0/p.values[1].x)/f.w);
            if(mode>=2u){
              var originalLow=nodes[u32(f.x)].h;
              if(f.y>=0.0 && f.z>0.0){originalLow=mix(originalLow,nodes[u32(f.y)].h,f.z);}
              let slope=max(0.0,(tileH[k]-originalLow)/(p.values[1].x*f.w));
              let response=slope*slope/(slope*slope+0.04);
              if(mode==3u){
                let threshold=p.values[3].w*0.10;
                let localResponse=0.08+0.92*slope*slope/(slope*slope+threshold*threshold);
                factor=min(4.0,p.values[5].z*min(sqrt(nodes[i].acc),4.0*sqrt(0.004)*p.values[0].w*2400.0/p.values[1].x)*localResponse/f.w);
              }
              else {factor*=response;}
            }
            result=min(result,(result+factor*low)/(1.0+factor));
          }
        }
        if(ready){value=vec2<f32>(result,1.0);}
      }
    }
    tileB[k]=value;workgroupBarrier();tileA[k]=tileB[k];workgroupBarrier();
  }
  if(valid){let value=tileA[k];if(mode==0u){nodes[i].flood[1u-phase]=value;}else{nodes[i].state[1u-phase]=value;}if(any(value!=original)){atomicStore(&control.flags[1u-phase],1u);}}
}
// Filled height controls real slopes. A weighted outlet potential orders flats
// without changing elevations; steepest potential and D-infinity split avoid
// the fixed-direction channels produced by unit D8 hop counts.
@compute @workgroup_size(256)
fn receivers(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count()){return;}let current=nodes[i].flood[0];
  var best=0.0;var bestFlat=0.0;var receiver=-1;var lowest=3.4e38;
  if(!edge(i)){for(var d=0u;d<8u;d++){
    let r=neighbor(i,d);if(r<0){continue;}let other=nodes[u32(r)].flood[0];if(!lower(other,current)){continue;}
    let drop=(current.x-other.x)/distances[d];let flatDrop=(current.y-other.y)/distances[d];let h=nodes[u32(r)].h;
    if(drop>best || (drop==0.0 && best==0.0 && (flatDrop>bestFlat || (flatDrop==bestFlat && h<lowest)))){
      receiver=r;best=drop;bestFlat=flatDrop;lowest=h;
    }
  }}
  nodes[i].receiver=receiver;
}
@compute @workgroup_size(256)
fn flow(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count()){return;}let r=nodes[i].receiver;var f=vec4<f32>(f32(r),-1.0,0.0,1.0);
  if(r>=0){let a=u32(r);let diag=abs(i32(i%size())-i32(a%size()))+abs(i32(i/size())-i32(a/size()))==2;f.w=select(1.0,1.4142135623730951,diag);let center=nodes[i].flood[0];let outlet=nodes[a].flood[0];let flat=center.x==outlet.x;
    var best=select(center.x-outlet.x,center.y-outlet.y,flat)/f.w;
    for(var d=0u;d<8u;d++){let ar=neighbor(i,d);let br=neighbor(i,(d+1u)&7u);if(ar<0 || br<0){continue;}
      let af=nodes[u32(ar)].flood[0];let bf=nodes[u32(br)].flood[0];
      if(!lower(af,center) || !lower(bf,center)){continue;}
      if(flat && (af.x!=center.x || bf.x!=center.x)){continue;}
      let u=vec2<f32>(directions[d]);let v=vec2<f32>(directions[(d+1u)&7u]);
      let da=select(center.x-af.x,center.y-af.y,flat);let db=select(center.x-bf.x,center.y-bf.y,flat);let det=u.x*v.y-u.y*v.x;
      let g=vec2<f32>((da*v.y-db*u.y)/det,(db*u.x-da*v.x)/det);let ca=u.x*g.y-u.y*g.x;let cb=g.x*v.y-g.y*v.x;if(ca<0.0 || cb<0.0){continue;}let slope=length(g);if(slope<=best){continue;}let t=clamp(atan2(ca,dot(u,g))/0.7853981633974483,0.0,1.0);best=slope;f=vec4<f32>(f32(ar),f32(br),t,(1.0-t)*distances[d]+t*distances[(d+1u)&7u]);
    }
  }nodes[i].flow=f;
}
@compute @workgroup_size(256)
fn graphInit(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}let value=select(1.0,nodes[i].h,p.values[6].y>=2.0);nodes[i].state[0]=vec2<f32>(value,0.0);nodes[i].state[1]=nodes[i].state[0];}
@compute @workgroup_size(256)
fn graphFinish(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}let s=nodes[i].state[0];if(s.y==0.0){atomicAdd(&control.errors,1u);}if(p.values[6].y==1.0){nodes[i].acc=s.x;}else{nodes[i].h=select(s.x,0.0,edge(i) && p.values[6].y==2.0);}}
@compute @workgroup_size(1)
fn floodCheck(){if(atomicLoad(&control.flags[0])!=0u){atomicAdd(&control.errors,1u);}}
@compute @workgroup_size(256)
fn pitInit(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}atomicStore(&nodes[i].parent,select(0xffffffffu,i,nodes[i].flood[0].x-nodes[i].h>0.05));atomicStore(&nodes[i].bottom,0xffffffffu);atomicStore(&nodes[i].spill,0xffffffffu);atomicStore(&nodes[i].pour,0xffffffffu);}
@compute @workgroup_size(256)
fn pitUnion(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count() || atomicLoad(&nodes[i].parent)==0xffffffffu){return;}for(var d=0u;d<8u;d++){let r=neighbor(i,d);if(r<0 || atomicLoad(&nodes[u32(r)].parent)==0xffffffffu){continue;}let a=rootOf(i);let b=rootOf(u32(r));atomicMin(&nodes[max(a,b)].parent,min(a,b));}}
@compute @workgroup_size(256)
fn pitCompress(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count() || atomicLoad(&nodes[i].parent)==0xffffffffu){return;}atomicStore(&nodes[i].parent,rootOf(i));}
@compute @workgroup_size(256)
fn pitReduce(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}let root=atomicLoad(&nodes[i].parent);if(root==0xffffffffu){return;}atomicMin(&nodes[root].bottom,ordered(nodes[i].h));let r=nodes[i].receiver;if(r>=0 && atomicLoad(&nodes[u32(r)].parent)!=root){atomicMin(&nodes[root].spill,ordered(nodes[i].flood[0].x));}for(var d=0u;d<8u;d++){let r=neighbor(i,d);if(r>=0){let parent=atomicLoad(&nodes[u32(r)].parent);if(parent!=0xffffffffu && parent!=root){atomicAdd(&control.errors,1u);}}}}
@compute @workgroup_size(256)
fn pitPour(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}let root=atomicLoad(&nodes[i].parent);if(root==0xffffffffu){return;}let r=nodes[i].receiver;if(r>=0 && atomicLoad(&nodes[u32(r)].parent)!=root && ordered(nodes[i].flood[0].x)==atomicLoad(&nodes[root].spill)){atomicMin(&nodes[root].pour,i);}}
@compute @workgroup_size(256)
fn pitFill(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}let root=atomicLoad(&nodes[i].parent);if(root!=0xffffffffu && atomicLoad(&nodes[root].pour)!=0xffffffffu){let spill=decoded(atomicLoad(&nodes[root].spill));if(nodes[i].h<spill){nodes[i].h+=p.values[4].z*p.values[7].z*(spill-nodes[i].h);}}}
@compute @workgroup_size(256)
fn breachInit(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<count()){atomicStore(&nodes[i].breached,ordered(nodes[i].h));}}
@compute @workgroup_size(256)
fn breach(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count() || atomicLoad(&nodes[i].parent)!=i){return;}let pour=atomicLoad(&nodes[i].pour);if(pour==0xffffffffu){return;}let frac=p.values[4].z*p.values[7].z;let spill=decoded(atomicLoad(&nodes[i].spill));let bottom=decoded(atomicLoad(&nodes[i].bottom));var current=min(nodes[pour].h,spill-frac*(spill-bottom));atomicMin(&nodes[pour].breached,ordered(nodes[pour].h+frac*(current-nodes[pour].h)));var r=nodes[pour].receiver;
  for(var k=0u;k<400u;k++){if(r<0){break;}current=max(0.5,current-0.01*p.values[1].x);let old=nodes[u32(r)].h;if(old<=current){break;}atomicMin(&nodes[u32(r)].breached,ordered(old+frac*(current-old)));r=nodes[u32(r)].receiver;}
}
@compute @workgroup_size(256)
fn breachFinish(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<count()){nodes[i].h=decoded(atomicLoad(&nodes[i].breached));}}
@compute @workgroup_size(256)
fn thermalFlux(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}var total=0.0;var maximum=0.0;if(!edge(i)){for(var d=0u;d<8u;d++){let r=neighbor(i,d);let excess=max(0.0,nodes[i].h-nodes[u32(r)].h-p.values[3].w*p.values[6].z*p.values[1].x*distances[d]);total+=excess;maximum=max(maximum,excess);}}nodes[i].thermal=vec2<f32>(0.1*p.values[4].z*maximum,total);}
@compute @workgroup_size(256)
fn thermalApply(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}var change=-nodes[i].thermal.x;for(var d=0u;d<8u;d++){let r=neighbor(i,d);if(r<0){continue;}let f=nodes[u32(r)].thermal;if(f.y>0.0){let excess=max(0.0,nodes[u32(r)].h-nodes[i].h-p.values[3].w*p.values[6].z*p.values[1].x*distances[d]);change+=f.x*excess/f.y;}}nodes[i].nextH=nodes[i].h+change;}
@compute @workgroup_size(256)
fn copyHeight(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<count()){nodes[i].h=nodes[i].nextH;}}
@compute @workgroup_size(256)
fn bounds(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<count()){nodes[i].h=select(nodes[i].h,0.0,edge(i));if(p.values[7].w!=0.0){nodes[i].h=max(0.0,nodes[i].h);}}}
@compute @workgroup_size(256)
fn diffuse(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}var value=nodes[i].h;if(!edge(i)){var average=0.0;for(var d=0u;d<8u;d++){average+=nodes[u32(neighbor(i,d))].h*select(0.2,0.05,(d&1u)!=0u);}let weight=p.values[6].w*select(1.0,0.75,nodes[i].acc>=f32(count())*0.001);value=(1.0-weight)*value+weight*average;}nodes[i].nextH=value;}
fn at(i:vec2<i32>,drain:bool)->f32 {let n=i32(size());let j=u32(clamp(i.y,0,n-1)*n+clamp(i.x,0,n-1));return select(nodes[j].h,nodes[j].acc,drain);}
fn cubic(a:f32,b:f32,c:f32,d:f32,t:f32)->f32{return b+0.5*t*(c-a+t*(2.0*a-5.0*b+4.0*c-d+t*(3.0*(b-c)+d-a)));}
fn sample(pos:vec2<f32>,drain:bool)->f32 {
  let xy=vec2<i32>(floor(pos));let t=fract(pos);
  if(drain){return mix(mix(at(xy,true),at(xy+vec2<i32>(1,0),true),t.x),mix(at(xy+vec2<i32>(0,1),true),at(xy+1,true),t.x),t.y);}
  var rows:array<f32,4>;var lo=3.4e38;var hi=-3.4e38;
  for(var y=0u;y<4u;y++){var values:array<f32,4>;for(var x=0u;x<4u;x++){let v=at(xy+vec2<i32>(i32(x)-1,i32(y)-1),false);values[x]=v;lo=min(lo,v);hi=max(hi,v);}rows[y]=cubic(values[0],values[1],values[2],values[3],t.x);}
  return clamp(cubic(rows[0],rows[1],rows[2],rows[3],t.y),lo,hi);
}
@compute @workgroup_size(256)
fn reconstruct(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;let n=u32(p.values[0].y);if(i>=n*n){return;}let xy=(vec2<f32>(f32(i%n),f32(i/n))+0.5)*p.values[2].w;let warp=min(16.0*p.values[0].w,p.values[1].x*0.9);let w=xy+warp*vec2<f32>(fbm(xy/p.values[2].x+vec2<f32>(11.3,0.0),1u,2u,0.5,0.0),fbm(xy/p.values[2].x+vec2<f32>(-4.7,2.9),1u,2u,0.5,0.0));let drainage=sample((xy-p.values[1].y)/p.values[1].x-0.5,true);fine[i]=vec4<f32>(sample((w-p.values[1].y)/p.values[1].x-0.5,false),1.0-0.85*p.values[4].z*smooth01((drainage-4.0)/max(12.0,f32(count())*0.001-4.0)),ridge(xy/p.values[2].y,u32(p.values[2].z)),0.0);}
@compute @workgroup_size(1)
fn percentileInit(){control.prefix=0u;control.quantileIndex=select(u32(floor(0.99*65536.0)),u32(floor(0.01*1048576.0)),p.values[7].x==1.0);}
@compute @workgroup_size(256)
fn histogramClear(@builtin(local_invocation_id) id:vec3<u32>){atomicStore(&control.histogram[id.x],0u);}
@compute @workgroup_size(256)
fn histogram(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=1048576u){return;}if(p.values[7].x==0.0 && ((i%1024u+(i/1024u)*7u)&15u)!=0u){return;}let value=select(fine[i].x,fine[i].w,p.values[7].x==1.0);let bits=ordered(value);let shift=u32(p.values[7].y);let mask=select(0xffffffffu,0u,shift==24u)<<min(31u,shift+8u);if((bits&mask)==control.prefix){atomicAdd(&control.histogram[(bits>>shift)&255u],1u);}}
@compute @workgroup_size(1)
fn percentileSelect(){let shift=u32(p.values[7].y);var quantileIndex=control.quantileIndex;var selected=0u;for(var bin=0u;bin<256u;bin++){let frequency=atomicLoad(&control.histogram[bin]);if(quantileIndex<frequency){selected=bin;break;}quantileIndex-=frequency;}control.quantileIndex=quantileIndex;control.prefix|=selected<<shift;if(shift==0u){let value=decoded(control.prefix);if(p.values[7].x==0.0){control.p99=max(0.0001,value);}else{control.p1=value;}}}
@compute @workgroup_size(256)
fn detail(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=1048576u){return;}let x=i%1024u;let y=i/1024u;let gx=fine[y*1024u+min(x+1u,1023u)].x-fine[y*1024u+select(x-1u,0u,x==0u)].x;let gy=fine[min(y+1u,1023u)*1024u+x].x-fine[select(y-1u,0u,y==0u)*1024u+x].x;let amplitude=p.values[3].x*(1.0-0.2*p.values[4].z);let scale=amplitude/control.p99;let slope=length(vec2<f32>(gx,gy))*scale/(2.0*p.values[2].w);let extra=(fine[i].z-0.5)*p.values[4].x*amplitude*smooth01((slope-0.015)/0.3)*fine[i].y;fine[i].w=max(0.3,fine[i].x*scale+extra);}
@compute @workgroup_size(256)
fn normalize(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<1048576u){fine[i].x=max(0.3,1.0+fine[i].w-control.p1);}}

@compute @workgroup_size(256)
fn volcanicInitial(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=1048576u){return;}
  let xy=(vec2<f32>(f32(i%1024u),f32(i/1024u))+0.5)*p.values[2].w;
  fine[i].w=volcanoElevation(xy);
}
fn fineAt(xy:vec2<i32>)->f32{return fine[u32(clamp(xy.y,0,1023)*1024+clamp(xy.x,0,1023))].w;}
fn fineSample(pos:vec2<f32>)->f32{
  let q=clamp(pos,vec2<f32>(0.0),vec2<f32>(1023.0));let xy=vec2<i32>(floor(q));let t=fract(q);
  var value=mix(mix(fineAt(xy),fineAt(xy+vec2<i32>(1,0)),t.x),mix(fineAt(xy+vec2<i32>(0,1)),fineAt(xy+1),t.x),t.y);
  if(pos.x!=q.x){let a=vec2<f32>(max(0.0,q.x-1.0),q.y);let b=vec2<f32>(min(1023.0,q.x+1.0),q.y);value+=(pos.x-q.x)*(fineAt(vec2<i32>(b))-fineAt(vec2<i32>(a)))/(b.x-a.x);}
  if(pos.y!=q.y){let a=vec2<f32>(q.x,max(0.0,q.y-1.0));let b=vec2<f32>(q.x,min(1023.0,q.y+1.0));value+=(pos.y-q.y)*(fineAt(vec2<i32>(b))-fineAt(vec2<i32>(a)))/(b.y-a.y);}
  return value;
}
@compute @workgroup_size(256)
fn surfaceLoad(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=count()){return;}let xy=(vec2<f32>(f32(i%size()),f32(i/size()))+0.5)*p.values[1].x+p.values[1].y;let h=fineSample(xy/p.values[2].w-0.5);nodes[i].h=h;nodes[i].uplift=h;nodes[i].acc=1.0;nodes[i].routingPriority=seededRoutingPriority(i);}
// Coast assembly uses x for height. Preserve signed meters throughout erosion.
@compute @workgroup_size(256)
fn coastLoad(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<1048576u){fine[i].w=fine[i].x;}}
@compute @workgroup_size(256)
fn coastResult(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<1048576u){fine[i].x=fine[i].w;}}
@compute @workgroup_size(256)
fn surfaceFlowInit(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<count()){nodes[i].flood[0]=vec2<f32>(nodes[i].h,0.0);}}
@compute @workgroup_size(256)
fn surfaceDelta(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i<count()){nodes[i].h-=nodes[i].uplift;}}
@compute @workgroup_size(256)
fn surfaceReconstruct(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;if(i>=1048576u){return;}let xy=(vec2<f32>(f32(i%1024u),f32(i/1024u))+0.5)*p.values[2].w;fine[i].w+=surfaceSample((xy-p.values[1].y)/p.values[1].x-0.5);}

fn surfaceWeights(t:f32)->vec4<f32>{let t3=t*t*t;let omt=1.0-t;return vec4<f32>(omt*omt*omt,3.0*t3-6.0*t*t+4.0,-3.0*t3+3.0*t*t+3.0*t+1.0,t3)/6.0;}
fn surfaceSample(pos:vec2<f32>)->f32{
  let xy=vec2<i32>(floor(pos));let wx=surfaceWeights(fract(pos.x));let wy=surfaceWeights(fract(pos.y));var result=0.0;
  for(var y=0u;y<4u;y++){for(var x=0u;x<4u;x++){result+=at(xy+vec2<i32>(i32(x)-1,i32(y)-1),false)*wx[x]*wy[y];}}
  return result;
}

// Trunk-river incision: physical catchment drives depth and bank width, not a
// pre-drawn polyline or the eight directions of a grid-breach operation.
@compute @workgroup_size(256)
fn canyonSeed(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count()){return;}
  let motif=p.values[0].w*2400.0;
  let area=nodes[i].acc*p.values[1].x*p.values[1].x/(motif*motif);
  let importance=smooth01((sqrt(area)-0.10)/0.30);
  nodes[i].nextH=importance;
  nodes[i].state[0]=select(vec2<f32>(-1.0),vec2<f32>(f32(i%size()),f32(i/size())),importance>0.0);
  nodes[i].state[1]=nodes[i].state[0];
}
fn canyonScore(xy:vec2<f32>,seed:vec2<f32>)->f32{
  if(seed.x<0.0){return 0.0;}
  let importance=nodes[u32(seed.y)*size()+u32(seed.x)].nextH;
  let dose=p.values[5].w;let motif=p.values[0].w*2400.0;
  let width=motif*(0.008+0.065*sqrt(importance))*sqrt(dose);
  let distance=length(xy-seed)*p.values[1].x;
  return p.values[3].x*0.90*dose*importance*(1.0-smooth01(distance/width));
}
@compute @workgroup_size(256)
fn canyonSpread(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count()){return;}
  let phase=u32(p.values[6].x);let jump=i32(p.values[6].y);let xy=vec2<i32>(i32(i%size()),i32(i/size()));
  var best=nodes[i].state[phase];var value=canyonScore(vec2<f32>(xy),best);
  for(var d=0u;d<8u;d++){
    let q=xy+directions[d]*jump;if(any(q<vec2<i32>(0)) || any(q>=vec2<i32>(i32(size())))){continue;}
    let seed=nodes[u32(q.y)*size()+u32(q.x)].state[phase];let candidate=canyonScore(vec2<f32>(xy),seed);
    if(candidate>value || (candidate==value && seed.x>=0.0 && (best.x<0.0 || seed.y<best.y || (seed.y==best.y && seed.x<best.x)))){best=seed;value=candidate;}
  }
  nodes[i].state[1u-phase]=best;
}
@compute @workgroup_size(256)
fn canyonApply(@builtin(global_invocation_id) id:vec3<u32>){
  let i=id.x;if(i>=count()){return;}
  let xy=vec2<f32>(f32(i%size()),f32(i/size()));
  nodes[i].h-=canyonScore(xy,nodes[i].state[u32(p.values[6].x)]);
}
