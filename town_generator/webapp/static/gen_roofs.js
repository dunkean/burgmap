const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const wrap = document.getElementById("canvasWrap");

const COLORS = {
    bg: "#e8dcc8",
    shadow: "rgba(40,30,20,0.28)",
    wallStroke: "#6b5a42",
    ridge: "#5a4030",
    handle: "#1f4f8f",
    handleActive: "#ffcc66",
    label: "#6a5a4a",
    selected: "#3766ac",
};

const LIGHT_DX = -0.7071;
const LIGHT_DY = -0.7071;
const SHADOW_DX = 0.8;
const SHADOW_DY = 1.0;

const state = {
    levels: [],
    selectedLevel: 0,
    mode: "edit",
    generated: null,
    viewX: 0,
    viewY: 0,
    viewScale: 12,
    draggingView: false,
    draggingVertex: -1,
    hoverClose: false,
    lastPreset: "irregular_stack",
};

let dragStartX = 0;
let dragStartY = 0;
let generateTimer = null;

function round(v) {
    return Math.round(v * 100) / 100;
}

function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), t | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function randRange(rng, min, max) {
    return min + (max - min) * rng();
}

function jitter(rng, value, pct = 0.18) {
    return value * randRange(rng, 1 - pct, 1 + pct);
}

function randomSeed() {
    return Math.floor(Math.random() * 900000) + 1000;
}

function rect(cx, cy, w, h) {
    return [
        [round(cx - w / 2), round(cy - h / 2)],
        [round(cx + w / 2), round(cy - h / 2)],
        [round(cx + w / 2), round(cy + h / 2)],
        [round(cx - w / 2), round(cy + h / 2)],
    ];
}

function octagon(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 8; i++) {
        const angle = -Math.PI / 8 + i * (Math.PI * 2 / 8);
        pts.push([
            round(cx + Math.cos(angle) * r),
            round(cy + Math.sin(angle) * r),
        ]);
    }
    return pts;
}

function polyCenter(points) {
    if (!points.length) {
        return [0, 0];
    }
    const sum = points.reduce((acc, pt) => [acc[0] + pt[0], acc[1] + pt[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
}

function scalePolygon(points, sx, sy = sx, center = polyCenter(points)) {
    return points.map(([x, y]) => [
        round(center[0] + (x - center[0]) * sx),
        round(center[1] + (y - center[1]) * sy),
    ]);
}

function translatePolygon(points, dx, dy) {
    return points.map(([x, y]) => [round(x + dx), round(y + dy)]);
}

function radialPolygon(cx, cy, radius, count, rng) {
    const pts = [];
    for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + i * (Math.PI * 2 / count) + randRange(rng, -0.08, 0.08);
        const dist = radius * randRange(rng, 0.72, 1.05);
        pts.push([round(cx + Math.cos(angle) * dist), round(cy + Math.sin(angle) * dist)]);
    }
    return pts;
}

function levelSpec(label, stories, polygon, extras = {}) {
    return {
        label,
        stories,
        polygon,
        ...extras,
    };
}

function buildSingleIrregular(seed) {
    const rng = mulberry32(seed);
    const radius = jitter(rng, 13, 0.22);
    const count = 7 + Math.floor(rng() * 3);
    return [
        levelSpec("Main", 2, radialPolygon(0, 0, radius, count, rng)),
    ];
}

function buildIrregularStack(seed) {
    const rng = mulberry32(seed);
    const base = radialPolygon(0, 0, jitter(rng, 17, 0.2), 8 + Math.floor(rng() * 2), rng);
    const upper = translatePolygon(
        scalePolygon(base, randRange(rng, 0.48, 0.62), randRange(rng, 0.46, 0.58)),
        randRange(rng, -1.5, 1.5),
        randRange(rng, -1.5, 1.5),
    );
    return [
        levelSpec("Base", 2, base),
        levelSpec("Upper", 4, upper),
    ];
}

function buildLShape(seed) {
    const rng = mulberry32(seed);
    const w1 = jitter(rng, 24);
    const h1 = jitter(rng, 8);
    const w2 = jitter(rng, 10);
    const h2 = jitter(rng, 20);
    const x0 = -w1 / 2;
    const y0 = -h2 / 2;
    return [
        levelSpec("Main", 2, [
            [round(x0), round(y0)],
            [round(x0 + w1), round(y0)],
            [round(x0 + w1), round(y0 + h1)],
            [round(x0 + w2), round(y0 + h1)],
            [round(x0 + w2), round(y0 + h2)],
            [round(x0), round(y0 + h2)],
        ]),
    ];
}

function buildTShape(seed) {
    const rng = mulberry32(seed);
    const wt = jitter(rng, 22);
    const ht = jitter(rng, 7);
    const ws = jitter(rng, 8);
    const hs = jitter(rng, 18);
    const yTop = -hs / 2;
    return [
        levelSpec("Main", 2, [
            [round(-wt / 2), round(yTop)],
            [round(wt / 2), round(yTop)],
            [round(wt / 2), round(yTop + ht)],
            [round(ws / 2), round(yTop + ht)],
            [round(ws / 2), round(yTop + hs)],
            [round(-ws / 2), round(yTop + hs)],
            [round(-ws / 2), round(yTop + ht)],
            [round(-wt / 2), round(yTop + ht)],
        ]),
    ];
}

function buildUShape(seed) {
    const rng = mulberry32(seed);
    const wl = jitter(rng, 6);
    const wr = jitter(rng, 6);
    const hs = jitter(rng, 20);
    const wb = jitter(rng, 24);
    const hb = jitter(rng, 6);
    const x0 = -wb / 2;
    const y0 = -hs / 2;
    return [
        levelSpec("Main", 2, [
            [round(x0), round(y0)],
            [round(x0 + wb), round(y0)],
            [round(x0 + wb), round(y0 + hs)],
            [round(x0 + wb - wr), round(y0 + hs)],
            [round(x0 + wb - wr), round(y0 + hb)],
            [round(x0 + wl), round(y0 + hb)],
            [round(x0 + wl), round(y0 + hs)],
            [round(x0), round(y0 + hs)],
        ]),
    ];
}

function buildHCompound(seed) {
    const rng = mulberry32(seed);
    const wingW = jitter(rng, 6);
    const wingH = jitter(rng, 24);
    const bridgeH = jitter(rng, 6);
    const gap = jitter(rng, 10);
    return [
        levelSpec("West Wing", 2, rect(-gap / 2 - wingW / 2, 0, wingW, wingH)),
        levelSpec("Bridge", 2, rect(0, 0, gap + wingW * 2, bridgeH)),
        levelSpec("East Wing", 2, rect(gap / 2 + wingW / 2, 0, wingW, wingH)),
    ];
}

function buildCourtyardCompound(seed) {
    const rng = mulberry32(seed);
    const outerW = jitter(rng, 28);
    const outerH = jitter(rng, 24);
    const wing = jitter(rng, 5);
    const hw = outerW / 2;
    const hh = outerH / 2;
    return [
        levelSpec("North Wing", 2, rect(0, -hh + wing / 2, outerW, wing)),
        levelSpec("South Wing", 1, rect(0, hh - wing / 2, outerW * randRange(rng, 0.78, 0.92), wing)),
        levelSpec("West Wing", 2, rect(-hw + wing / 2, 0, wing, outerH - wing * 2)),
        levelSpec("East Wing", 2, rect(hw - wing / 2, 0, wing, outerH - wing * 2)),
    ];
}

function buildPlusCompound(seed) {
    const rng = mulberry32(seed);
    const arm = jitter(rng, 8);
    const length = jitter(rng, 28);
    return [
        levelSpec("Nave", 3, rect(0, 0, arm, length), { building_type: "cathedral" }),
        levelSpec("Transept", 3, rect(0, 0, length, arm), { building_type: "cathedral" }),
        levelSpec("Crossing", 4, rect(0, 0, arm * 1.15, arm * 1.15), { building_type: "tower" }),
    ];
}

function buildTowerStack(seed) {
    const rng = mulberry32(seed);
    const base = jitter(rng, 18);
    const middle = base * randRange(rng, 0.55, 0.68);
    const top = middle * randRange(rng, 0.48, 0.62);
    return [
        levelSpec("Base", 2, rect(0, 0, base, base), { building_type: "tower" }),
        levelSpec("Upper", 4, rect(0, 0, middle, middle), { building_type: "tower" }),
        levelSpec("Spire Base", 6, rect(0, 0, top, top), { building_type: "tower" }),
    ];
}

function buildOctagonTower(seed) {
    const rng = mulberry32(seed);
    return [
        levelSpec("Tower", 5, octagon(0, 0, jitter(rng, 11)), { building_type: "tower" }),
    ];
}

function buildMosqueComplex(seed) {
    const rng = mulberry32(seed);
    const hall = jitter(rng, 22);
    const minaretR = jitter(rng, 3.4);
    const offset = hall / 2 + minaretR * 0.9;
    return [
        levelSpec("Prayer Hall", 2, rect(0, 0, hall, hall), { building_type: "mosque" }),
        levelSpec("Northwest Minaret", 5, octagon(-offset, -offset, minaretR), { building_type: "tower" }),
        levelSpec("Northeast Minaret", 5, octagon(offset, -offset, minaretR), { building_type: "tower" }),
    ];
}

function buildPagodaStack(seed) {
    const rng = mulberry32(seed);
    const baseW = jitter(rng, 24);
    const baseH = jitter(rng, 18);
    const secondScale = randRange(rng, 0.62, 0.74);
    const thirdScale = randRange(rng, 0.44, 0.56);
    return [
        levelSpec("Base", 2, rect(0, 0, baseW, baseH), { building_type: "pagoda" }),
        levelSpec("Middle", 3, rect(0, 0, baseW * secondScale, baseH * secondScale), { building_type: "pagoda" }),
        levelSpec("Top", 4, rect(0, 0, baseW * thirdScale, baseH * thirdScale), { building_type: "pagoda" }),
    ];
}

function buildCathedralCompound(seed) {
    const rng = mulberry32(seed);
    const naveW = jitter(rng, 9);
    const naveH = jitter(rng, 30);
    const transeptW = jitter(rng, 24);
    const transeptH = jitter(rng, 8);
    const apseW = jitter(rng, 7);
    const apseH = jitter(rng, 6);
    const towerSize = jitter(rng, 5);
    return [
        levelSpec("Nave", 3, rect(0, 0, naveW, naveH), { building_type: "cathedral" }),
        levelSpec("Transept", 3, rect(0, -naveH * 0.12, transeptW, transeptH), { building_type: "cathedral" }),
        levelSpec("Apse", 2, rect(0, -naveH / 2 - apseH / 2 + 0.5, apseW, apseH), { building_type: "chapel" }),
        levelSpec("Crossing Tower", 4, rect(0, -naveH * 0.12, towerSize, towerSize), { building_type: "tower" }),
        levelSpec("West Tower", 4, octagon(0, naveH / 2 - towerSize * 0.65, towerSize * 0.62), { building_type: "tower" }),
    ];
}

function buildKeepCompound(seed) {
    const rng = mulberry32(seed);
    const keepSize = jitter(rng, 12);
    const hallW = jitter(rng, 8);
    const hallH = jitter(rng, 16);
    const towerR = jitter(rng, 3.4);
    const offset = keepSize / 2;
    return [
        levelSpec("Keep", 4, rect(0, 0, keepSize, keepSize), { building_type: "keep" }),
        levelSpec("Great Hall", 2, rect(0, keepSize / 2 + hallH / 2 - 1.5, hallW, hallH), { building_type: "great_hall" }),
        levelSpec("Chapel Wing", 2, rect(keepSize / 2 + hallH / 2 - 1.5, 0, hallH, hallW), { building_type: "chapel" }),
        levelSpec("Northwest Tower", 5, octagon(-offset, -offset, towerR), { building_type: "tower" }),
        levelSpec("Northeast Tower", 5, octagon(offset, -offset, towerR), { building_type: "tower" }),
        levelSpec("Southeast Tower", 5, octagon(offset, offset, towerR), { building_type: "tower" }),
        levelSpec("Southwest Tower", 5, octagon(-offset, offset, towerR), { building_type: "tower" }),
    ];
}

function buildLonghouse(seed) {
    const rng = mulberry32(seed);
    return [
        levelSpec("Hall", 2, rect(0, 0, jitter(rng, 36), jitter(rng, 12)), { building_type: "great_hall" }),
    ];
}

function buildZigzag(seed) {
    const rng = mulberry32(seed);
    const a = jitter(rng, 18);
    const b = jitter(rng, 12);
    const c = jitter(rng, 8);
    const d = jitter(rng, 6);
    return [
        levelSpec("Main", 3, [
            [round(-a), round(-10)],
            [round(b), round(-10)],
            [round(b), round(-d)],
            [round(c / 2), round(-d)],
            [round(c / 2), round(d / 2)],
            [round(b + 2), round(d / 2)],
            [round(b + 2), round(9)],
            [round(-6), round(9)],
            [round(-6), round(4)],
            [round(-a), round(4)],
        ]),
    ];
}

const PRESET_DEFS = {
    irregular_stack: {
        config: { roofType: "skeleton", buildingType: "house", style: "generic" },
        build: buildIrregularStack,
    },
    single_irregular: {
        config: { roofType: "skeleton", buildingType: "house", style: "generic" },
        build: buildSingleIrregular,
    },
    l_shape: {
        config: { roofType: "auto", buildingType: "house", style: "european_medieval" },
        build: buildLShape,
    },
    t_shape: {
        config: { roofType: "auto", buildingType: "house", style: "european_medieval" },
        build: buildTShape,
    },
    h_compound: {
        config: { roofType: "auto", buildingType: "house", style: "european_medieval" },
        build: buildHCompound,
    },
    u_shape: {
        config: { roofType: "auto", buildingType: "house", style: "european_medieval" },
        build: buildUShape,
    },
    courtyard_compound: {
        config: { roofType: "auto", buildingType: "house", style: "european_medieval" },
        build: buildCourtyardCompound,
    },
    plus_compound: {
        config: { roofType: "auto", buildingType: "cathedral", style: "european_medieval" },
        build: buildPlusCompound,
    },
    tower_stack: {
        config: { roofType: "auto", buildingType: "tower", style: "generic" },
        build: buildTowerStack,
    },
    octagon_tower: {
        config: { roofType: "auto", buildingType: "tower", style: "generic" },
        build: buildOctagonTower,
    },
    mosque_complex: {
        config: { roofType: "auto", buildingType: "mosque", style: "arabic_islamic" },
        build: buildMosqueComplex,
    },
    pagoda_stack: {
        config: { roofType: "auto", buildingType: "pagoda", style: "east_asian" },
        build: buildPagodaStack,
    },
    cathedral_compound: {
        config: { roofType: "auto", buildingType: "cathedral", style: "european_medieval" },
        build: buildCathedralCompound,
    },
    keep_compound: {
        config: { roofType: "auto", buildingType: "keep", style: "european_medieval" },
        build: buildKeepCompound,
    },
    longhouse: {
        config: { roofType: "auto", buildingType: "great_hall", style: "viking" },
        build: buildLonghouse,
    },
    zigzag: {
        config: { roofType: "skeleton", buildingType: "house", style: "generic" },
        build: buildZigzag,
    },
};

function selectedLevel() {
    return state.levels[state.selectedLevel] || null;
}

function normalizeLevels(levels) {
    return levels.map((level, index) => ({
        id: level.id || `level_${index + 1}`,
        label: level.label || `Level ${index + 1}`,
        stories: Math.max(1, parseInt(level.stories || 1, 10)),
        polygon: (level.polygon || []).map(([x, y]) => [Number(x), Number(y)]),
        building_type: level.building_type || "",
        style: level.style || "",
        roof_type: level.roof_type || "",
    }));
}

function setLevels(levels, options = {}) {
    state.levels = normalizeLevels(levels);
    state.selectedLevel = Math.min(state.selectedLevel, Math.max(0, state.levels.length - 1));
    state.generated = null;
    updateLevelList();
    updateJsonEditor();
    if (options.fit !== false) {
        fitView();
    } else {
        draw();
    }
    scheduleGenerate();
}

function currentSeed(forceRandom = false) {
    const input = document.getElementById("seed");
    let seed = parseInt(input.value, 10);
    if (!Number.isFinite(seed) || seed < 0 || forceRandom) {
        seed = randomSeed();
        input.value = seed;
    }
    return seed;
}

function applyPreset(name, options = {}) {
    const def = PRESET_DEFS[name];
    if (!def) {
        return;
    }
    const seed = currentSeed(Boolean(options.randomize));
    const config = def.config || {};
    if (config.roofType) {
        document.getElementById("roofType").value = config.roofType;
    }
    if (config.buildingType) {
        document.getElementById("buildingType").value = config.buildingType;
    }
    if (config.style) {
        document.getElementById("style").value = config.style;
    }
    state.lastPreset = name;
    syncContextControls();
    updateStatus();
    setLevels(def.build(seed), { fit: options.fit !== false });
}

function unionBounds(polygons) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polygons) {
        for (const [x, y] of poly) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function resize() {
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
}

function worldToScreen(wx, wy) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return [cx + (wx - state.viewX) * state.viewScale, cy + (wy - state.viewY) * state.viewScale];
}

function screenToWorld(sx, sy) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return [(sx - cx) / state.viewScale + state.viewX, (sy - cy) / state.viewScale + state.viewY];
}

function fitView() {
    const bounds = unionBounds(state.levels.map(level => level.polygon).filter(poly => poly.length));
    if (!bounds) {
        state.viewX = 0;
        state.viewY = 0;
        state.viewScale = 12;
        draw();
        return;
    }
    const width = Math.max(8, bounds.maxX - bounds.minX);
    const height = Math.max(8, bounds.maxY - bounds.minY);
    state.viewX = (bounds.minX + bounds.maxX) / 2;
    state.viewY = (bounds.minY + bounds.maxY) / 2;
    state.viewScale = Math.max(6, Math.min(canvas.width / (width + 12), canvas.height / (height + 12)));
    draw();
}

function updateOverhangLabel() {
    const value = parseFloat(document.getElementById("overhang").value);
    document.getElementById("overhangVal").textContent = value < 0 ? "auto" : value.toFixed(2);
}

function syncModeButtons() {
    document.querySelectorAll(".mode-grid button").forEach(button => {
        button.classList.toggle("active", button.id === `mode${state.mode[0].toUpperCase()}${state.mode.slice(1)}Btn`);
    });
}

function syncContextControls() {
    const auto = document.getElementById("roofType").value === "auto";
    document.getElementById("buildingType").disabled = !auto;
    document.getElementById("style").disabled = !auto;
}

function setMode(mode) {
    state.mode = mode;
    document.getElementById("statusMode").textContent = `Mode: ${mode}`;
    syncModeButtons();
    draw();
}

function updateLevelList() {
    const list = document.getElementById("levelList");
    list.innerHTML = "";
    state.levels.forEach((level, index) => {
        const btn = document.createElement("button");
        btn.className = `level-item secondary${index === state.selectedLevel ? " active" : ""}`;
        btn.innerHTML = `<span>${level.label}</span><span>${level.stories}F</span>`;
        btn.addEventListener("click", () => {
            state.selectedLevel = index;
            document.getElementById("levelStories").value = level.stories;
            updateLevelList();
            updateJsonEditor();
            updateStatus();
            draw();
        });
        list.appendChild(btn);
    });
    const level = selectedLevel();
    if (level) {
        document.getElementById("levelStories").value = level.stories;
    }
    updateStatus();
}

function updateJsonEditor() {
    document.getElementById("polygonJson").value = JSON.stringify(selectedLevel()?.polygon || [], null, 2);
}

function updateStatus() {
    const level = selectedLevel();
    const roofType = document.getElementById("roofType").value || "auto";
    document.getElementById("statusLevel").textContent = level
        ? `Level: ${state.selectedLevel + 1} / ${state.levels.length} (${level.stories}F)`
        : "Level: -";
    document.getElementById("statusRoof").textContent = `Roof: ${roofType}`;
}

function scheduleGenerate() {
    clearTimeout(generateTimer);
    generateTimer = setTimeout(generate, 120);
}

async function generate() {
    const levels = state.levels
        .filter(level => level.polygon.length >= 3)
        .map(level => ({
            id: level.id,
            label: level.label,
            stories: level.stories,
            polygon: level.polygon.map(([x, y]) => [round(x), round(y)]),
            building_type: level.building_type || document.getElementById("buildingType").value,
            style: level.style || document.getElementById("style").value,
            roof_type: level.roof_type || "",
        }));

    if (!levels.length) {
        state.generated = null;
        document.getElementById("infoText").textContent = "Add at least three vertices";
        draw();
        return;
    }

    const params = new URLSearchParams({
        roof_type: document.getElementById("roofType").value || "auto",
        overhang: document.getElementById("overhang").value,
        style: document.getElementById("style").value,
        building_type: document.getElementById("buildingType").value,
        stories: document.getElementById("levelStories").value,
        levels: JSON.stringify(levels),
    });

    document.getElementById("infoText").textContent = "Generating roofs...";
    try {
        const resp = await fetch(`/api/gen_roofs?${params.toString()}`);
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        state.generated = await resp.json();
        const totalFaces = state.generated.levels.reduce((sum, level) => sum + ((level.roof?.faces || []).length), 0);
        const algorithms = [...new Set(state.generated.levels
            .map(level => level.roof?.extras?.algorithm)
            .filter(Boolean))];
        document.getElementById("infoText").textContent = `${state.generated.levels.length} part${state.generated.levels.length > 1 ? "s" : ""} | ${totalFaces} faces${algorithms.length ? ` | ${algorithms.join(", ")}` : ""}`;
        updateStatus();
        draw();
    } catch (err) {
        document.getElementById("infoText").textContent = `Error: ${err.message}`;
    }
}

function faceBrightness(direction) {
    const dot = direction[0] * LIGHT_DX + direction[1] * LIGHT_DY;
    return 0.38 + 0.62 * Math.max(0, (dot + 1) / 2);
}

function roofColor(direction, levelIndex) {
    const base = [178, 118, 72];
    const lift = Math.min(levelIndex * 10, 28);
    const b = faceBrightness(direction || [0, -1]);
    return `rgb(${Math.round((base[0] + lift) * b)},${Math.round((base[1] + lift) * b)},${Math.round((base[2] + lift) * b)})`;
}

function drawGrid() {
    const step = state.viewScale >= 10 ? 5 : 10;
    const [wl, wt] = screenToWorld(0, 0);
    const [wr, wb] = screenToWorld(canvas.width, canvas.height);
    ctx.strokeStyle = "#c8bca8";
    ctx.lineWidth = 0.3;
    for (let x = Math.floor(wl / step) * step; x <= wr; x += step) {
        const [sx] = worldToScreen(x, 0);
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, canvas.height);
        ctx.stroke();
    }
    for (let y = Math.floor(wt / step) * step; y <= wb; y += step) {
        const [, sy] = worldToScreen(0, y);
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(canvas.width, sy);
        ctx.stroke();
    }
}

function drawGroundShadow(pts) {
    if (!pts || pts.length < 3) {
        return;
    }
    ctx.fillStyle = COLORS.shadow;
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(pts[0][0] + SHADOW_DX, pts[0][1] + SHADOW_DY));
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(...worldToScreen(pts[i][0] + SHADOW_DX, pts[i][1] + SHADOW_DY));
    }
    ctx.closePath();
    ctx.fill();
}

function drawWalls(pts, levelIndex, stories) {
    if (!pts || pts.length < 3) {
        return;
    }
    const tint = Math.min(levelIndex * 8 + stories * 2, 26);
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(pts[0][0], pts[0][1]));
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(...worldToScreen(pts[i][0], pts[i][1]));
    }
    ctx.closePath();
    ctx.fillStyle = `rgb(${200 + tint}, ${184 + tint}, ${152 + tint})`;
    ctx.fill();
    ctx.strokeStyle = COLORS.wallStroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
}

function drawRoofFaces(roof, levelIndex) {
    if (!roof?.faces?.length) {
        return;
    }
    const fallbackFaces = String(roof?.extras?.algorithm || "").startsWith("fallback_");
    for (const face of roof.faces) {
        if (!face.polygon || face.polygon.length < 3) {
            continue;
        }
        ctx.beginPath();
        ctx.moveTo(...worldToScreen(face.polygon[0][0], face.polygon[0][1]));
        for (let i = 1; i < face.polygon.length; i++) {
            ctx.lineTo(...worldToScreen(face.polygon[i][0], face.polygon[i][1]));
        }
        ctx.closePath();
        ctx.fillStyle = roofColor(face.direction, levelIndex);
        ctx.fill();
        if (!fallbackFaces) {
            ctx.strokeStyle = "rgba(80,60,40,0.20)";
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
    }
}

function drawRoofOutline(roof, selected) {
    if (!roof?.polygon || roof.polygon.length < 3) {
        return;
    }
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(roof.polygon[0][0], roof.polygon[0][1]));
    for (let i = 1; i < roof.polygon.length; i++) {
        ctx.lineTo(...worldToScreen(roof.polygon[i][0], roof.polygon[i][1]));
    }
    ctx.closePath();
    ctx.strokeStyle = selected ? "rgba(50,35,20,0.85)" : "rgba(60,45,30,0.6)";
    ctx.lineWidth = selected ? 1.8 : 1.2;
    ctx.stroke();
}

function drawRidges(roof) {
    ctx.strokeStyle = COLORS.ridge;
    ctx.lineWidth = 1.6;
    const segments = roof?.extras?.segments || [];
    if (segments.length) {
        for (const segment of segments) {
            ctx.beginPath();
            ctx.moveTo(...worldToScreen(segment[0][0], segment[0][1]));
            ctx.lineTo(...worldToScreen(segment[1][0], segment[1][1]));
            ctx.stroke();
        }
        return;
    }
    const ridge = roof?.ridge_polygon || [];
    if (ridge.length < 2) {
        return;
    }
    if (roof.type === "gabled" || roof.type === "vaulted") {
        for (let i = 0; i < ridge.length - 1; i += 2) {
            ctx.beginPath();
            ctx.moveTo(...worldToScreen(ridge[i][0], ridge[i][1]));
            ctx.lineTo(...worldToScreen(ridge[i + 1][0], ridge[i + 1][1]));
            ctx.stroke();
        }
        return;
    }
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(ridge[0][0], ridge[0][1]));
    for (let i = 1; i < ridge.length; i++) {
        ctx.lineTo(...worldToScreen(ridge[i][0], ridge[i][1]));
    }
    if (ridge.length >= 3) {
        ctx.closePath();
    }
    ctx.stroke();
}

function drawLevelOutline(points, selected) {
    if (!points || points.length < 2) {
        return;
    }
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(points[0][0], points[0][1]));
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(...worldToScreen(points[i][0], points[i][1]));
    }
    if (points.length >= 3) {
        ctx.closePath();
    }
    ctx.strokeStyle = selected ? COLORS.selected : "rgba(74,111,165,0.55)";
    ctx.lineWidth = selected ? 2.0 : 1.0;
    ctx.stroke();
}

function drawLabel(level, points, roof) {
    if (!points?.length) {
        return;
    }
    const [cx, cy] = polyCenter(points);
    const [sx, sy] = worldToScreen(cx, cy);
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.label;
    ctx.fillText(`${level.label || level.id} · ${level.stories}F`, sx, sy - 3);
    ctx.fillText(roof?.type || (document.getElementById("roofType").value || "auto"), sx, sy + 11);
}

function drawHandles() {
    const level = selectedLevel();
    if (!level) {
        return;
    }
    level.polygon.forEach(([x, y], index) => {
        const [sx, sy] = worldToScreen(x, y);
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fillStyle = index === state.draggingVertex ? COLORS.handleActive : COLORS.handle;
        ctx.fill();
        ctx.strokeStyle = "#f6efe4";
        ctx.lineWidth = 1.2;
        ctx.stroke();
    });
    if (state.mode === "draw" && level.polygon.length) {
        const [sx, sy] = worldToScreen(level.polygon[0][0], level.polygon[0][1]);
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.strokeStyle = state.hoverClose ? COLORS.handleActive : "rgba(31,79,143,0.45)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (document.getElementById("layerGrid").checked) {
        drawGrid();
    }

    const levels = state.generated?.levels || state.levels.map(level => ({ ...level, roof: null, footprint: level.polygon }));
    levels.forEach((level, index) => {
        const footprint = level.footprint || level.polygon;
        if (document.getElementById("layerFootprint").checked) {
            drawGroundShadow(level.roof?.polygon || footprint);
            drawWalls(footprint, index, level.stories || 1);
        }
        if (document.getElementById("layerRoof").checked) {
            drawRoofFaces(level.roof, index);
            drawRoofOutline(level.roof, index === state.selectedLevel);
        }
        if (document.getElementById("layerLevels").checked) {
            drawLevelOutline(footprint, index === state.selectedLevel);
        }
        if (document.getElementById("layerRidge").checked) {
            drawRidges(level.roof);
        }
        if (document.getElementById("layerLabels").checked) {
            drawLabel(level, footprint, level.roof);
        }
    });
    if (document.getElementById("layerHandles").checked) {
        drawHandles();
    }
}

function nearestVertex(points, sx, sy, maxDist = 10) {
    let best = -1;
    let bestDist = maxDist;
    points.forEach(([x, y], index) => {
        const [px, py] = worldToScreen(x, y);
        const dist = Math.hypot(px - sx, py - sy);
        if (dist <= bestDist) {
            best = index;
            bestDist = dist;
        }
    });
    return best;
}

function pointToSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (!len2) {
        return Math.hypot(p[0] - a[0], p[1] - a[1]);
    }
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    return Math.hypot(p[0] - px, p[1] - py);
}

function nearestEdge(points, sx, sy, maxDist = 14) {
    let best = -1;
    let bestDist = maxDist;
    for (let i = 0; i < points.length; i++) {
        const a = worldToScreen(points[i][0], points[i][1]);
        const b = worldToScreen(points[(i + 1) % points.length][0], points[(i + 1) % points.length][1]);
        const dist = pointToSegmentDistance([sx, sy], a, b);
        if (dist < bestDist) {
            best = i;
            bestDist = dist;
        }
    }
    return best;
}

function addLevel() {
    const base = selectedLevel();
    const polygon = base && base.polygon.length >= 3
        ? base.polygon.map(([x, y]) => {
            const [cx, cy] = polyCenter(base.polygon);
            return [round(cx + (x - cx) * 0.72), round(cy + (y - cy) * 0.72)];
        })
        : rect(0, 0, 12, 8);

    state.levels.push({
        id: `level_${state.levels.length + 1}`,
        label: `Level ${state.levels.length + 1}`,
        stories: base ? base.stories + 1 : 1,
        polygon,
        building_type: base?.building_type || document.getElementById("buildingType").value,
        style: base?.style || document.getElementById("style").value,
        roof_type: base?.roof_type || "",
    });
    state.selectedLevel = state.levels.length - 1;
    updateLevelList();
    updateJsonEditor();
    scheduleGenerate();
    draw();
}

function duplicateLevel() {
    const level = selectedLevel();
    if (!level) {
        return;
    }
    state.levels.push({
        id: `level_${state.levels.length + 1}`,
        label: `${level.label} Copy`,
        stories: level.stories + 1,
        polygon: clone(level.polygon),
        building_type: level.building_type,
        style: level.style,
        roof_type: level.roof_type,
    });
    state.selectedLevel = state.levels.length - 1;
    updateLevelList();
    updateJsonEditor();
    scheduleGenerate();
    draw();
}

function removeLevel() {
    if (state.levels.length <= 1) {
        return;
    }
    state.levels.splice(state.selectedLevel, 1);
    state.selectedLevel = Math.max(0, state.selectedLevel - 1);
    updateLevelList();
    updateJsonEditor();
    scheduleGenerate();
    draw();
}

function beginNewPolygon() {
    const level = selectedLevel();
    if (!level) {
        return;
    }
    level.polygon = [];
    level.building_type = level.building_type || document.getElementById("buildingType").value;
    level.style = level.style || document.getElementById("style").value;
    state.generated = null;
    updateJsonEditor();
    setMode("draw");
}

function applyJson() {
    try {
        const parsed = JSON.parse(document.getElementById("polygonJson").value);
        if (!Array.isArray(parsed) || parsed.length < 3) {
            throw new Error("need at least three vertices");
        }
        const level = selectedLevel();
        level.polygon = parsed.map(([x, y]) => [Number(x), Number(y)]);
        state.generated = null;
        updateJsonEditor();
        scheduleGenerate();
        draw();
    } catch (err) {
        document.getElementById("infoText").textContent = `Invalid polygon JSON: ${err.message}`;
    }
}

function exportSetup() {
    const payload = {
        levels: state.levels,
        params: {
            preset: document.getElementById("preset").value,
            seed: parseInt(document.getElementById("seed").value, 10),
            roof_type: document.getElementById("roofType").value,
            overhang: parseFloat(document.getElementById("overhang").value),
            building_type: document.getElementById("buildingType").value,
            style: document.getElementById("style").value,
        },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "roofs_setup.json";
    a.click();
    URL.revokeObjectURL(url);
}

function importSetup() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async event => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        const parsed = JSON.parse(await file.text());
        if (parsed.params) {
            if (parsed.params.preset) {
                document.getElementById("preset").value = parsed.params.preset;
                state.lastPreset = parsed.params.preset;
            }
            if (parsed.params.seed !== undefined) {
                document.getElementById("seed").value = parsed.params.seed;
            }
            if (parsed.params.roof_type) {
                document.getElementById("roofType").value = parsed.params.roof_type;
            }
            if (parsed.params.overhang !== undefined) {
                document.getElementById("overhang").value = parsed.params.overhang;
            }
            if (parsed.params.building_type) {
                document.getElementById("buildingType").value = parsed.params.building_type;
            }
            if (parsed.params.style) {
                document.getElementById("style").value = parsed.params.style;
            }
            updateOverhangLabel();
            syncContextControls();
        }
        if (parsed.levels) {
            setLevels(parsed.levels);
        }
    };
    input.click();
}

canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("mousedown", event => {
    const level = selectedLevel();
    if (state.mode === "pan" || event.button === 1) {
        state.draggingView = true;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        return;
    }
    if (!level) {
        return;
    }
    if (event.button === 2 && state.mode === "edit") {
        const vertex = nearestVertex(level.polygon, event.offsetX, event.offsetY);
        if (vertex !== -1 && level.polygon.length > 3) {
            level.polygon.splice(vertex, 1);
            updateJsonEditor();
            scheduleGenerate();
            draw();
        }
        return;
    }
    if (state.mode === "draw") {
        const close = nearestVertex(level.polygon, event.offsetX, event.offsetY, 12);
        if (close === 0 && level.polygon.length >= 3) {
            setMode("edit");
            scheduleGenerate();
            draw();
            return;
        }
        const [wx, wy] = screenToWorld(event.offsetX, event.offsetY);
        level.polygon.push([round(wx), round(wy)]);
        updateJsonEditor();
        draw();
        return;
    }
    state.draggingVertex = nearestVertex(level.polygon, event.offsetX, event.offsetY);
    if (state.draggingVertex === -1) {
        state.draggingView = true;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
    }
});

canvas.addEventListener("mousemove", event => {
    const [wx, wy] = screenToWorld(event.offsetX, event.offsetY);
    document.getElementById("statusCoords").textContent = `Cursor: ${wx.toFixed(2)}, ${wy.toFixed(2)}`;
    const level = selectedLevel();
    state.hoverClose = state.mode === "draw"
        && level
        && level.polygon.length >= 3
        && nearestVertex(level.polygon, event.offsetX, event.offsetY, 12) === 0;

    if (state.draggingVertex !== -1 && level) {
        level.polygon[state.draggingVertex] = [round(wx), round(wy)];
        updateJsonEditor();
        draw();
        return;
    }

    if (state.draggingView) {
        state.viewX -= (event.clientX - dragStartX) / state.viewScale;
        state.viewY -= (event.clientY - dragStartY) / state.viewScale;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        draw();
        return;
    }

    draw();
});

canvas.addEventListener("mouseup", () => {
    if (state.draggingVertex !== -1) {
        scheduleGenerate();
    }
    state.draggingVertex = -1;
    state.draggingView = false;
    draw();
});

canvas.addEventListener("mouseleave", () => {
    if (state.draggingVertex !== -1) {
        scheduleGenerate();
    }
    state.draggingVertex = -1;
    state.draggingView = false;
    state.hoverClose = false;
    draw();
});

canvas.addEventListener("dblclick", event => {
    if (state.mode !== "edit") {
        return;
    }
    const level = selectedLevel();
    if (!level || level.polygon.length < 2) {
        return;
    }
    const edge = nearestEdge(level.polygon, event.offsetX, event.offsetY);
    if (edge === -1) {
        return;
    }
    const [wx, wy] = screenToWorld(event.offsetX, event.offsetY);
    level.polygon.splice(edge + 1, 0, [round(wx), round(wy)]);
    updateJsonEditor();
    scheduleGenerate();
    draw();
});

canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    const [wx, wy] = screenToWorld(event.offsetX, event.offsetY);
    state.viewScale = Math.max(2, Math.min(120, state.viewScale * factor));
    state.viewX = wx - (event.offsetX - canvas.width / 2) / state.viewScale;
    state.viewY = wy - (event.offsetY - canvas.height / 2) / state.viewScale;
    draw();
}, { passive: false });

window.addEventListener("resize", resize);

document.getElementById("preset").addEventListener("change", event => applyPreset(event.target.value));
document.getElementById("seed").addEventListener("change", () => applyPreset(document.getElementById("preset").value, { fit: false }));
document.getElementById("randomizeBtn").addEventListener("click", () => applyPreset(document.getElementById("preset").value, { randomize: true }));
document.getElementById("fitViewBtn").addEventListener("click", fitView);
document.getElementById("modeEditBtn").addEventListener("click", () => setMode("edit"));
document.getElementById("modeDrawBtn").addEventListener("click", () => setMode("draw"));
document.getElementById("modePanBtn").addEventListener("click", () => setMode("pan"));
document.getElementById("addLevelBtn").addEventListener("click", addLevel);
document.getElementById("duplicateLevelBtn").addEventListener("click", duplicateLevel);
document.getElementById("removeLevelBtn").addEventListener("click", removeLevel);
document.getElementById("newPolygonBtn").addEventListener("click", beginNewPolygon);
document.getElementById("applyJsonBtn").addEventListener("click", applyJson);
document.getElementById("copyJsonBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("polygonJson").value);
});
document.getElementById("exportBtn").addEventListener("click", exportSetup);
document.getElementById("importBtn").addEventListener("click", importSetup);
document.getElementById("levelStories").addEventListener("change", event => {
    const level = selectedLevel();
    if (!level) {
        return;
    }
    level.stories = Math.max(1, parseInt(event.target.value, 10) || 1);
    updateLevelList();
    scheduleGenerate();
});

document.getElementById("roofType").addEventListener("change", () => {
    syncContextControls();
    updateStatus();
    scheduleGenerate();
});
document.getElementById("buildingType").addEventListener("change", scheduleGenerate);
document.getElementById("style").addEventListener("change", scheduleGenerate);
document.getElementById("overhang").addEventListener("input", () => {
    updateOverhangLabel();
    draw();
});
document.getElementById("overhang").addEventListener("change", scheduleGenerate);
document.querySelectorAll(".layer-toggles input").forEach(input => input.addEventListener("change", draw));
document.querySelectorAll("[data-preset]").forEach(button => button.addEventListener("click", () => {
    document.getElementById("preset").value = button.dataset.preset;
    applyPreset(button.dataset.preset);
}));

resize();
updateOverhangLabel();
syncContextControls();
applyPreset("irregular_stack");
setMode("edit");
