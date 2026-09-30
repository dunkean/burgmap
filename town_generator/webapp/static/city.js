// M3 + M5 City Roofscape Editor — fast WebGL renderer

let cityData = null;
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartTX = 0;
let panStartTY = 0;
let populatorList = [];
let renderQueued = false;

const canvas = document.getElementById("canvas-main");
const statusBar = document.getElementById("status-bar");
const canvasArea = document.getElementById("canvas-area");

const DISTRICT_COLORS = {
    market: "#d4a76a",
    cathedral: "#b8860b",
    castle: "#8b7355",
    craftsmen: "#c8b48a",
    merchant: "#d4c4a0",
    patriciate: "#d8cca8",
    slum: "#a09888",
    administration: "#c0b898",
    military: "#a8a090",
    park: "#8ab080",
    farm: "#b8c898",
    gate: "#beb8a8",
    shanty_town: "#908880",
    residential: "#c0b8a8",
    empty: "#3a3f50",
};

const BUILDING_COLORS = {
    house: "#c4b08b",
    insula: "#ccb795",
    shop: "#d6ab72",
    stall: "#d6ab72",
    chapel: "#c3ae7f",
    refectory: "#cdbb93",
    dormitory: "#c4b392",
    chapter_house: "#b8a681",
    tower: "#af9871",
    farmhouse: "#d0bc94",
    barracks: "#b8b19c",
    headquarters: "#a99d86",
    armory: "#a8a08c",
    great_hall: "#d8c5a2",
    wing: "#cbb997",
    gatehouse: "#bda98c",
    outbuilding: "#beb39b",
    keep: "#b59d77",
    ger: "#d9cb9e",
    field: "#9ab774",
};

const renderer = createRenderer(canvas);
if (!renderer) {
    statusBar.textContent = "WebGL is unavailable in this browser/environment.";
}

function hexToRgba(hex, alpha = 1) {
    const n = hex.startsWith("#") ? hex.slice(1) : hex;
    return [
        parseInt(n.slice(0, 2), 16) / 255,
        parseInt(n.slice(2, 4), 16) / 255,
        parseInt(n.slice(4, 6), 16) / 255,
        alpha,
    ];
}

function stableHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function roofColor(direction, level = 0, building = null) {
    const hash = building ? stableHash(`${building.id}|${building.type}|${building.massing_type || "original"}`) : 0;
    const palettes = [
        [178, 118, 72],
        [164, 104, 66],
        [154, 92, 58],
        [142, 100, 74],
        [118, 112, 105],
    ];
    const palette = palettes[hash % palettes.length];
    const dot = (direction?.[0] || 0) * -0.7071 + (direction?.[1] ?? -1) * -0.7071;
    const brightness = 0.38 + 0.62 * Math.max(0, (dot + 1) / 2);
    const lift = Math.min(level * 6, 20);
    return [
        ((palette[0] + lift) * brightness) / 255,
        ((palette[1] + lift) * brightness) / 255,
        ((palette[2] + lift) * brightness) / 255,
        1,
    ];
}

function isLayerOn(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
}

function fitView() {
    if (!cityData) return;
    const bounds = cityData.bounds || { cx: 0, cy: 0, radius: 200 };
    const padding = 56;
    const radius = Math.max(bounds.radius || 200, 60);
    scale = Math.min(
        (canvas.width - padding * 2) / (radius * 2.8),
        (canvas.height - padding * 2) / (radius * 2.8),
    );
    translateX = canvas.width / 2 - bounds.cx * scale;
    translateY = canvas.height / 2 - bounds.cy * scale;
}

function resizeCanvas() {
    const rect = canvasArea.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    if (renderer) renderer.resize(rect.width, rect.height);
    requestRender();
}

function polygonArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return area / 2;
}

function pointInTriangle(p, a, b, c) {
    const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

function triangulate(points) {
    if (!points || points.length < 3) return [];
    const verts = polygonArea(points) > 0 ? points.slice() : points.slice().reverse();
    const idx = Array.from({ length: verts.length }, (_, i) => i);
    const out = [];
    while (idx.length > 2) {
        let earFound = false;
        for (let i = 0; i < idx.length; i++) {
            const ia = idx[(i - 1 + idx.length) % idx.length];
            const ib = idx[i];
            const ic = idx[(i + 1) % idx.length];
            const a = verts[ia], b = verts[ib], c = verts[ic];
            const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if (cross <= 1e-8) continue;
            let contains = false;
            for (let j = 0; j < idx.length; j++) {
                const ip = idx[j];
                if (ip === ia || ip === ib || ip === ic) continue;
                if (pointInTriangle(verts[ip], a, b, c)) {
                    contains = true;
                    break;
                }
            }
            if (contains) continue;
            out.push(a, b, c);
            idx.splice(i, 1);
            earFound = true;
            break;
        }
        if (!earFound) break;
    }
    return out;
}

function pushVertex(batch, x, y, color) {
    batch.push(x, y, color[0], color[1], color[2], color[3]);
}

function pushTriangle(batch, a, b, c, color) {
    pushVertex(batch, a[0], a[1], color);
    pushVertex(batch, b[0], b[1], color);
    pushVertex(batch, c[0], c[1], color);
}

function pushPolygon(batch, points, color) {
    const tris = triangulate(points);
    for (let i = 0; i < tris.length; i += 3) {
        pushTriangle(batch, tris[i], tris[i + 1], tris[i + 2], color);
    }
}

function pushSegment(batch, a, b, width, color) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const nx = -dy / len * width * 0.5;
    const ny = dx / len * width * 0.5;
    const p0 = [a[0] - nx, a[1] - ny];
    const p1 = [a[0] + nx, a[1] + ny];
    const p2 = [b[0] + nx, b[1] + ny];
    const p3 = [b[0] - nx, b[1] - ny];
    pushTriangle(batch, p0, p1, p2, color);
    pushTriangle(batch, p0, p2, p3, color);
}

function pushPolyline(batch, points, width, color, closed = false) {
    for (let i = 1; i < points.length; i++) {
        pushSegment(batch, points[i - 1], points[i], width, color);
    }
    if (closed && points.length > 2) {
        pushSegment(batch, points[points.length - 1], points[0], width, color);
    }
}

function pushCircle(batch, center, radius, color, segments = 12) {
    for (let i = 0; i < segments; i++) {
        const a0 = i / segments * Math.PI * 2;
        const a1 = (i + 1) / segments * Math.PI * 2;
        pushTriangle(
            batch,
            center,
            [center[0] + Math.cos(a0) * radius, center[1] + Math.sin(a0) * radius],
            [center[0] + Math.cos(a1) * radius, center[1] + Math.sin(a1) * radius],
            color,
        );
    }
}

function buildScene(data) {
    const scene = {};
    const ensure = name => (scene[name] ||= []);
    const paper = hexToRgba("#f0e4cc", 1);
    const water = hexToRgba("#4a7a9b", 1);
    const alley = hexToRgba("#8ab080", 0.20);
    const lot = hexToRgba("#34425c", 0.45);
    const ridge = hexToRgba("#5a4030", 0.9);
    const wall = hexToRgba("#4a3c28", 1);
    const road = hexToRgba("#c8c0b0", 1);
    const shadow = hexToRgba("#2e2113", 0.22);
    const landmark = hexToRgba("#c53030", 1);

    const bounds = data.bounds || { cx: 0, cy: 0, radius: 200 };
    const radius = Math.max(bounds.radius || 200, 60) * 1.6;
    pushTriangle(ensure("base"), [bounds.cx - radius, bounds.cy - radius], [bounds.cx + radius, bounds.cy - radius], [bounds.cx + radius, bounds.cy + radius], paper);
    pushTriangle(ensure("base"), [bounds.cx - radius, bounds.cy - radius], [bounds.cx + radius, bounds.cy + radius], [bounds.cx - radius, bounds.cy + radius], paper);

    for (const district of data.districts || []) {
        pushPolygon(ensure("districts"), district.polygon, hexToRgba(DISTRICT_COLORS[district.type] || DISTRICT_COLORS.empty, 1));
        if (district.alleys) {
            for (const alleyGeom of district.alleys) {
                const points = alleyGeom.points || alleyGeom;
                if (points.length >= 3) pushPolygon(ensure("alleys"), points, alley);
            }
        }
        for (const building of district.buildings || []) {
            const footprint = building.outline && building.outline.length >= 3 ? building.outline : building.footprint;
            if (!footprint || footprint.length < 3) continue;
            const shadowPts = footprint.map(([x, y]) => [x + 0.75, y + 0.95]);
            pushPolygon(ensure("shadows"), shadowPts, shadow);
            if (building.source_lots) {
                for (const lotShape of building.source_lots) pushPolyline(ensure("lots"), lotShape, 0.05, lot, true);
            } else if (building.lot_footprint) {
                pushPolyline(ensure("lots"), building.lot_footprint, 0.05, lot, true);
            }
            pushPolygon(ensure("buildings"), footprint, hexToRgba(BUILDING_COLORS[building.type] || "#c4b08b", 1));
            const groups = building.compound && building.height_groups?.length ? building.height_groups : [{ roof: building.roof, stories: building.stories || 1 }];
            for (const group of groups) {
                if (!group.roof?.faces) continue;
                for (const face of group.roof.faces) {
                    if (face.polygon?.length >= 3) pushPolygon(ensure("roofs"), face.polygon, roofColor(face.direction, group.stories || 1, building));
                }
                const roof = group.roof;
                if (roof.polygon?.length >= 2) pushPolyline(ensure("roofOutlines"), roof.polygon, 0.05, hexToRgba("#3e3120", 0.2), true);
                const segments = roof.extras?.segments || [];
                if (segments.length) {
                    for (const seg of segments) pushSegment(ensure("ridges"), seg[0], seg[1], 0.05, ridge);
                } else if (roof.ridge_polygon?.length >= 2 && roof.type !== "hipped") {
                    for (let i = 1; i < roof.ridge_polygon.length; i++) pushSegment(ensure("ridges"), roof.ridge_polygon[i - 1], roof.ridge_polygon[i], 0.05, ridge);
                }
            }
        }
    }

    if (data.coast_water?.length >= 3) pushPolygon(ensure("water"), data.coast_water, water);
    for (const river of data.rivers || []) if (river.polygon?.length >= 3) pushPolygon(ensure("water"), river.polygon, water);
    for (const street of data.streets || []) pushPolyline(ensure("streets"), street.points, (street.width || 2) * 0.18, road);
    for (const wallData of data.walls || []) {
        pushPolyline(ensure("walls"), wallData.polygon, 0.22, wall, true);
        for (const tower of wallData.towers || []) pushCircle(ensure("walls"), tower, 0.8, wall, 10);
    }
    for (const river of data.rivers || []) for (const bridge of river.bridges || []) pushSegment(ensure("bridges"), bridge.start, bridge.end, 0.45, hexToRgba("#c4b08b", 1));
    for (const lm of data.landmarks || []) pushCircle(ensure("landmarks"), lm.centroid, 1.2, landmark, 10);

    return scene;
}

function createRenderer(target) {
    const contextOptions = {
        antialias: false,
        alpha: false,
        desynchronized: true,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
    };
    const gl = target.getContext("webgl", contextOptions) || target.getContext("experimental-webgl", contextOptions);
    if (!gl) return null;
    const vert = `
        attribute vec2 a_position;
        attribute vec4 a_color;
        uniform vec2 u_resolution;
        uniform float u_scale;
        uniform vec2 u_translate;
        varying vec4 v_color;
        void main() {
            vec2 p = a_position * u_scale + u_translate;
            vec2 clip = (p / u_resolution) * 2.0 - 1.0;
            gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
            v_color = a_color;
        }`;
    const frag = `
        precision mediump float;
        varying vec4 v_color;
        void main() { gl_FragColor = v_color; }`;
    const program = linkProgram(gl, vert, frag);
    const aPos = gl.getAttribLocation(program, "a_position");
    const aColor = gl.getAttribLocation(program, "a_color");
    const uRes = gl.getUniformLocation(program, "u_resolution");
    const uScale = gl.getUniformLocation(program, "u_scale");
    const uTranslate = gl.getUniformLocation(program, "u_translate");
    const layers = {};
    gl.useProgram(program);
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aColor);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.09, 0.10, 0.12, 1);
    return {
        resize(width, height) { gl.viewport(0, 0, width, height); },
        setScene(scene) {
            for (const key of Object.keys(layers)) gl.deleteBuffer(layers[key].buffer);
            for (const [name, values] of Object.entries(scene)) {
                const buffer = gl.createBuffer();
                const data = new Float32Array(values);
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
                layers[name] = { buffer, count: data.length / 6 };
            }
        },
        render(transform) {
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(program);
            gl.uniform2f(uRes, target.width, target.height);
            gl.uniform1f(uScale, transform.scale);
            gl.uniform2f(uTranslate, transform.translateX, transform.translateY);
            const order = ["base", "districts", "water", "streets", "alleys", "lots", "shadows", "buildings", "roofs", "roofOutlines", "ridges", "walls", "bridges", "landmarks"];
            for (const name of order) {
                if (!shouldDrawLayer(name) || !layers[name]) continue;
                gl.bindBuffer(gl.ARRAY_BUFFER, layers[name].buffer);
                gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 24, 0);
                gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 24, 8);
                gl.drawArrays(gl.TRIANGLES, 0, layers[name].count);
            }
        },
    };
}

function shouldDrawLayer(name) {
    const map = {
        districts: "layer-districts",
        water: "layer-water",
        streets: "layer-streets",
        alleys: "layer-alleys",
        lots: "layer-lots",
        shadows: "layer-buildings",
        buildings: "layer-buildings",
        roofs: "layer-roofs",
        roofOutlines: "layer-roofs",
        ridges: "layer-ridges",
        walls: "layer-walls",
        bridges: "layer-water",
        landmarks: "layer-landmarks",
    };
    return !map[name] || isLayerOn(map[name]);
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
}

function linkProgram(gl, vertSrc, fragSrc) {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
}

function render() {
    if (!renderer) return;
    renderer.render({ scale, translateX, translateY });
}

function requestRender() {
    if (!renderer || renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(() => {
        renderQueued = false;
        render();
    });
}

async function generate() {
    const params = new URLSearchParams();
    params.set("seed", document.getElementById("seed").value);
    params.set("size", document.getElementById("size").value);
    params.set("style", document.getElementById("style").value);
    params.set("min_area", document.getElementById("min-area").value);
    params.set("grid_chaos", document.getElementById("grid-chaos").value);
    params.set("size_chaos", document.getElementById("size-chaos").value);
    params.set("empty_prob", document.getElementById("empty-prob").value);
    params.set("density", document.getElementById("density").value);
    params.set("alley_width", document.getElementById("alley-width").value);
    params.set("roofscape", "true");
    params.set("roof_type", document.getElementById("roof-type").value);
    params.set("overhang", document.getElementById("overhang").value);
    params.set("facade_density", document.getElementById("facade-density").value);
    params.set("massing_mode", document.getElementById("massing-mode").value);
    params.set("complexity", document.getElementById("complexity").value);
    params.set("complex_ratio", document.getElementById("complex-ratio").value);
    params.set("join_ratio", document.getElementById("join-ratio").value);
    params.set("setback", document.getElementById("setback").value);
    const populator = document.getElementById("populator").value;
    if (populator !== "auto") params.set("populator", populator);
    for (const id of ["roads", "elongation", "building_density", "river_curvature", "coast_roughness"]) {
        const val = document.getElementById(id).value;
        if (val) params.set(id, val);
    }
    for (const id of ["road_style", "building_style", "plaza", "citadel", "walls", "temple", "river", "coast", "shanty_town"]) {
        const val = document.getElementById(id).value;
        if (val) params.set(id, val);
    }

    statusBar.textContent = "Generating roofscape...";
    const t0 = performance.now();
    const resp = await fetch(`/api/city?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    cityData = await resp.json();
    if (renderer) renderer.setScene(buildScene(cityData));
    fitView();
    requestRender();
    const elapsed = Math.round(performance.now() - t0);
    const buildings = cityData.districts.flatMap(d => d.buildings || []);
    const roofed = buildings.filter(b => b.roof || (b.height_groups || []).length).length;
    statusBar.textContent = `Generated in ${elapsed}ms - ${cityData.districts.length} districts - ${buildings.length} buildings - ${roofed} roofed`;
}

async function loadPopulators() {
    try {
        const resp = await fetch("/api/district/populators");
        if (!resp.ok) return;
        populatorList = await resp.json();
        const select = document.getElementById("populator");
        for (const p of populatorList) {
            const opt = document.createElement("option");
            opt.value = p.name;
            opt.textContent = `${p.name} - ${p.description}`;
            select.appendChild(opt);
        }
    } catch (_err) {
        // ignore
    }
}

function setupSlider(id, formatter = null) {
    const slider = document.getElementById(id);
    const value = document.getElementById(`${id}-val`);
    if (!slider || !value) return;
    const renderValue = () => {
        if (formatter) value.textContent = formatter(parseFloat(slider.value));
        else {
            const decimals = slider.step && slider.step.includes(".") ? slider.step.split(".")[1].length : 0;
            value.textContent = parseFloat(slider.value).toFixed(decimals);
        }
    };
    slider.addEventListener("input", renderValue);
    renderValue();
}

async function loadRegion() {
    const regionStatus = document.getElementById("region-status");
    const params = new URLSearchParams({
        seed: document.getElementById("region-seed").value,
        size: document.getElementById("region-size").value,
        coast: document.getElementById("region-coast").value,
        river_count: document.getElementById("region-rivers").value,
        style: document.getElementById("style").value,
        build_roads: "true",
    });
    regionStatus.textContent = "Loading region...";
    const resp = await fetch(`/api/region?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const region = await resp.json();
    document.getElementById("seed").value = params.get("seed");
    if (region.style) document.getElementById("style").value = region.style;
    document.getElementById("river").value = region.terrain?.rivers?.length ? "true" : "";
    document.getElementById("coast").value = region.terrain?.coastline?.length ? "true" : "";
    if (region.city_radius_cells) document.getElementById("size").value = Math.max(5, Math.min(60, Math.round(region.city_radius_cells * 0.8)));
    regionStatus.textContent = `Region loaded - style: ${region.style || "generic"}`;
    await generate();
}

document.getElementById("load-region").addEventListener("click", () => loadRegion().catch(err => {
    document.getElementById("region-status").textContent = `Error: ${err.message}`;
}));
document.getElementById("generate").addEventListener("click", () => generate().catch(err => {
    statusBar.textContent = `Error: ${err.message}`;
}));
document.getElementById("random").addEventListener("click", () => {
    document.getElementById("seed").value = Math.floor(Math.random() * 999999) + 1;
    generate().catch(err => { statusBar.textContent = `Error: ${err.message}`; });
});
document.getElementById("reset-zoom").addEventListener("click", () => { fitView(); requestRender(); });

canvasArea.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvasArea.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    const nextScale = Math.max(1.0, Math.min(80, scale * factor));
    translateX = mx - (mx - translateX) * (nextScale / scale);
    translateY = my - (my - translateY) * (nextScale / scale);
    scale = nextScale;
    requestRender();
}, { passive: false });

canvasArea.addEventListener("mousedown", event => {
    if (event.button !== 0) return;
    isPanning = true;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panStartTX = translateX;
    panStartTY = translateY;
    canvasArea.classList.add("grabbing");
});

window.addEventListener("mousemove", event => {
    if (!isPanning) return;
    translateX = panStartTX + (event.clientX - panStartX);
    translateY = panStartTY + (event.clientY - panStartY);
    requestRender();
});

window.addEventListener("mouseup", () => {
    if (!isPanning) return;
    isPanning = false;
    canvasArea.classList.remove("grabbing");
});

window.addEventListener("keydown", event => {
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (event.key === "g" || event.key === "G") generate().catch(err => { statusBar.textContent = `Error: ${err.message}`; });
    if (event.key === " ") {
        event.preventDefault();
        fitView();
        requestRender();
    }
});

document.querySelectorAll(".layer-toggle input").forEach(input => input.addEventListener("change", requestRender));
document.querySelectorAll(".section-header").forEach(header => {
    header.addEventListener("click", () => {
        const content = document.getElementById(`sec-${header.dataset.section}`);
        if (!content) return;
        header.classList.toggle("collapsed");
        content.classList.toggle("hidden");
    });
});

document.getElementById("export-btn").addEventListener("click", () => {
    if (!cityData) return;
    document.getElementById("export-text").value = JSON.stringify(cityData, null, 2);
    document.getElementById("export-panel").style.display = "block";
    document.getElementById("export-overlay").style.display = "block";
});
document.getElementById("copy-json").addEventListener("click", () => navigator.clipboard.writeText(document.getElementById("export-text").value));
for (const id of ["close-export", "export-overlay"]) {
    document.getElementById(id).addEventListener("click", () => {
        document.getElementById("export-panel").style.display = "none";
        document.getElementById("export-overlay").style.display = "none";
    });
}
document.getElementById("import-btn").addEventListener("click", () => document.getElementById("import-file").click());
document.getElementById("import-file").addEventListener("change", event => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        cityData = JSON.parse(ev.target.result);
        if (renderer) renderer.setScene(buildScene(cityData));
        fitView();
        requestRender();
        statusBar.textContent = `Imported: ${cityData.districts.length} districts`;
    };
    reader.readAsText(file);
    event.target.value = "";
});

setupSlider("min-area");
setupSlider("grid-chaos");
setupSlider("size-chaos");
setupSlider("density");
setupSlider("empty-prob");
setupSlider("alley-width");
setupSlider("complexity");
setupSlider("complex-ratio", value => `${Math.round(value * 100)}%`);
setupSlider("join-ratio", value => `${Math.round(value * 100)}%`);
setupSlider("setback");
setupSlider("overhang", value => value.toFixed(2));

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
loadPopulators();
