"""Summarize the audit and fail on a changed sampled surface or SVG."""
import json
from pathlib import Path
from statistics import median

OUT = Path(__file__).resolve().parents[1] / "out/perf-audit"


def read(name):
    return json.loads((OUT / f"{name}.json").read_text(encoding="utf-8"))["results"]


def equal(a, b, svg=True):
    keys = ["hashes", "minHeight", "maxHeight", "globalMaxHeight"]
    if svg:
        keys.append("sceneHash")
    return all(a[k] == b[k] for k in keys)


matrix = read("matrix")
base = {x["relief"]: x for x in matrix if x["name"] == "baseline"}
experiments = read("experiments")
checks = []
for case in matrix + experiments:
    if case["name"] == "baseline":
        continue
    for sample, reference in zip(case["samples"], base[case["relief"]]["samples"]):
        checks.append({"variant": case["name"], "relief": case["relief"], "resolution": sample["resolution"], "identical": equal(sample, reference)})

comparison = read("compare")
repeats = {}
for i in range(0, len(comparison), 2):
    a, b = comparison[i:i + 2]
    assert (a["seed"], a["erosion"]) == (b["seed"], b["erosion"])
    for sample, reference in zip(a["samples"], b["samples"]):
        checks.append({"variant": "repeat", "relief": "flat", "seed": a["seed"], "erosion": a["erosion"], "resolution": sample["resolution"], "identical": equal(sample, reference)})
for erosion in [0, 0.5, 1]:
    repeats[str(erosion)] = {}
    for variant in ["baseline", "candidate-lod"]:
        cases = [x for x in comparison if x["erosion"] == erosion and x["name"] == variant]
        repeats[str(erosion)][variant] = {
            "runs": len(cases),
            "prepareMs": median(x["prepareMs"] for x in cases),
            "overviewSampleMs": median(x["samples"][0]["sampleMs"] for x in cases),
            "detailSampleMs": median(x["samples"][1]["sampleMs"] for x in cases),
            "detailRenderMs": median(x["samples"][1]["renderMs"] for x in cases),
        }

regional = read("regional")
for i in range(0, len(regional), 2):
    a, b = regional[i:i + 2]
    for sample, reference in zip(a["samples"], b["samples"]):
        checks.append({"variant": "regional", "relief": a["relief"], "region": {k: sample[k] for k in ["x", "y", "extent", "resolution"]}, "identical": equal(sample, reference, svg=False)})

cave = read("cave")
cave_checks = [equal(sample, reference) for a, b in zip(cave[::2], cave[1::2]) for sample, reference in zip(a["samples"], b["samples"])]

rows = []
for case in experiments:
    if case["name"] != "candidate-lod":
        continue
    original = base[case["relief"]]
    rows.append({
        "relief": case["relief"], "baselinePrepareMs": original["prepareMs"], "candidatePrepareMs": case["prepareMs"],
        "baselineSample768Ms": original["samples"][1]["sampleMs"], "candidateSample768Ms": case["samples"][1]["sampleMs"],
        "baselineSample512Ms": original["samples"][0]["sampleMs"], "candidateSample512Ms": case["samples"][0]["sampleMs"],
    })
png_checks = [s["nativePngIdentical"] for x in experiments for s in x["samples"] if "nativePngIdentical" in s]
summary = {"checks": checks, "identical": all(c["identical"] for c in checks), "caveIdentical": all(cave_checks), "caveChecks": len(cave_checks), "nativePngIdentical": all(png_checks), "nativePngChecks": len(png_checks), "repeatedPlain": repeats, "reliefs": rows}
(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({k: v for k, v in summary.items() if k != "checks"}, ensure_ascii=False, indent=2))
assert summary["identical"] and summary["nativePngIdentical"] and summary["caveIdentical"]
