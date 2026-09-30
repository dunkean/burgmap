#!/bin/sh
cd "$(dirname "$0")/.."
run() { npm run -s preview:png -- "$@" | grep -E '"ms.total"|"ms.site"|"ms.roads"|"ms.landuse"|"roads"|"bridges"|landuse\.|svgKB|"site\.'; }
run --seed 1 --size town --opt relief=hills --opt coast=S --opt river=river --out out/m2_s1.png &
run --seed 2 --size town --opt relief=valley --opt river=major --out out/m2_s2.png &
run --seed 5 --size village --opt relief=flat --opt river=river --out out/m2_s5.png &
run --seed 7 --size city --opt relief=hills --opt coast=W --opt river=river --out out/m2_s7.png &
run --seed 8 --size hamlet --opt relief=mountains --opt river=stream --out out/m2_s8.png &
wait
