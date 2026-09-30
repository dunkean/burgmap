#!/bin/sh
cd "$(dirname "$0")/.."
run() { npm run -s preview:png -- "$@" | grep -E '"ms.terrain"|seaFraction|"rivers"|"lakes"'; }
run --seed 1 --opt relief=hills --opt river=river --opt coast=S --out out/s1.png &
run --seed 2 --opt relief=valley --opt river=major --opt coast=none --out out/s2.png &
run --seed 3 --opt relief=mountains --opt river=stream --opt coast=none --out out/s3.png &
run --seed 4 --opt relief=flat --opt river=river --opt coast=E --out out/s4.png &
wait
