#!/bin/sh
# usage: scripts/m3.sh <prefix> <focus> [extra args]  -- renders several seeds/sizes in parallel
cd "$(dirname "$0")/.."
P=$1; F=$2; shift 2
run() { npm run -s preview:png -- "$@" | grep -E '"ms.urban"|urban.pop|urban.blocks|urban.plots|urban.buildings' | tr -d '\n'; echo; }
run --seed 2 --size town --focus $F --out out/${P}_t2.png "$@" &
run --seed 3 --size town --focus $F --out out/${P}_t3.png "$@" &
run --seed 4 --size city --focus $((F*2)) --out out/${P}_c4.png "$@" &
run --seed 5 --size town --focus $F --out out/${P}_t5.png "$@" &
wait
