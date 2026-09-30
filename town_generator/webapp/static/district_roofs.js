let districtData = null;
let customPolygon = null;
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartTX = 0;
let panStartTY = 0;
let hoveredBuilding = null;
let selectedBuilding = null;
let populatorList = [];

const canvas = document.getElementById("canvas-main");
const ctx = canvas.getContext("2d");
const canvasArea = document.getElementById("canvas-area");
const tooltip = document.getElementById("tooltip");
const statusBar = document.getElementById("status-bar");

const COLORS = {
    boundary: "#9c3f2b",
    boundaryFill: "#eadac0",
    alleyFill: "rgba(132, 155, 112, 0.20)",
    alleyStroke: "#708a58",
    lotStroke: "rgba(52, 66, 92, 0.70)",
    shadow: "rgba(46, 33, 19, 0.22)",
    wallStroke: "#5d4a31",
    ridge: "#5a4030",
    label: "#4b3c2f",
};

const BUILDING_COLORS = {
    house:        { fill: "#c4b08b", stroke: "#58452f" },
    insula:       { fill: "#ccb795", stroke: "#5e4930" },
    shop:         { fill: "#d6ab72", stroke: "#6a4a22" },
    stall:        { fill: "#d6ab72", stroke: "#6a4a22" },
    chapel:       { fill: "#c3ae7f", stroke: "#66522e" },
    refectory:    { fill: "#cdbb93", stroke: "#5f4d32" },
    dormitory:    { fill: "#c4b392", stroke: "#5c4b34" },
    chapter_house:{ fill: "#b8a681", stroke: "#56492f" },
    tower:        { fill: "#af9871", stroke: "#56452f" },
    farmhouse:    { fill: "#d0bc94", stroke: "#6a5838" },
    barracks:     { fill: "#b8b19c", stroke: "#58544a" },
    headquarters: { fill: "#a99d86", stroke: "#4f493c" },
    armory:       { fill: "#a8a08c", stroke: "#4d473c" },
    great_hall:   { fill: "#d8c5a2", stroke: "#66543a" },
    wing:         { fill: "#cbb997", stroke: "#5f4c34" },
    gatehouse:    { fill: "#bda98c", stroke: "#5b4b35" },
    outbuilding:  { fill: "#beb39b", stroke: "#58524a" },
    keep:         { fill: "#b59d77", stroke: "#58452f" },
    ger:          { fill: "#d9cb9e", stroke: "#726338" },
    field:        { fill: "#9ab774", stroke: "#6d8350" },
};
const DEFAULT_BLDG = { fill: "#c4b08b", stroke: "#58452f" };

const LIGHT_DX = -0.7071;
const LIGHT_DY = -0.7071;
const SHADOW_DX = 0.75;
const SHADOW_DY = 0.95;

function stableHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function isLayerOn(id) {
    const el = document.getElementById(id);
    return !!(el && el.checked);
}

function faceBrightness(direction) {
    const dir = direction || [0, -1];
    const dot = dir[0] * LIGHT_DX + dir[1] * LIGHT_DY;
    return 0.38 + 0.62 * Math.max(0, (dot + 1) / 2);
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
    const roofShift = (((hash >>> 3) % 11) - 5) * 1.6;
    const warmth = (((hash >>> 7) % 7) - 3) * 1.4;
    const base = [
        palette[0] + roofShift,
        palette[1] + roofShift * 0.45 + warmth,
        palette[2] + roofShift * 0.25,
    ];
    const lift = Math.min(level * 6, 20);
    const brightness = faceBrightness(direction);
    return `rgb(${Math.round((base[0] + lift) * brightness)},${Math.round((base[1] + lift) * brightness)},${Math.round((base[2] + lift) * brightness)})`;
}

function resizeCanvas() {
    const rect = canvasArea.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    render();
}

function worldToScreen(x, y) {
    return [x * scale + translateX, y * scale + translateY];
}

function screenToWorld(sx, sy) {
    return [(sx - translateX) / scale, (sy - translateY) / scale];
}

function fitView() {
    if (!districtData || !districtData.polygon) {
        return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of districtData.polygon) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    const padding = 52;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    scale = Math.min((canvas.width - padding * 2) / width, (canvas.height - padding * 2) / height);
    translateX = canvas.width / 2 - cx * scale;
    translateY = canvas.height / 2 - cy * scale;
}

function drawPolygon(points, fillStyle, strokeStyle, lineWidth = 0.15, dash = []) {
    if (!points || points.length < 3) {
        return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
    ctx.setLineDash(dash);
    if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
    }
    if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth / Math.max(scale, 0.001);
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

function drawGroundShadow(points) {
    if (!points || points.length < 3) {
        return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0][0] + SHADOW_DX, points[0][1] + SHADOW_DY);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0] + SHADOW_DX, points[i][1] + SHADOW_DY);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.shadow;
    ctx.fill();
}

function getBuildingFootprint(building) {
    if (!building) {
        return null;
    }
    if (building.outline && building.outline.length >= 3) {
        return building.outline;
    }
    return building.footprint;
}

function getBuildingRoof(building) {
    if (!building) {
        return null;
    }
    if (building.roof) {
        return building.roof;
    }
    const groups = building.height_groups || [];
    return groups.length ? groups[groups.length - 1].roof : null;
}

function drawBoundary() {
    drawPolygon(districtData.polygon, COLORS.boundaryFill, COLORS.boundary, 0.18);
}

function drawAlleys() {
    for (const alley of districtData.alleys || []) {
        drawPolygon(alley.points || alley, COLORS.alleyFill, COLORS.alleyStroke, 0.05);
    }
}

function drawLotEnvelopes() {
    for (const building of districtData.buildings || []) {
        if (building.source_lots && building.source_lots.length) {
            for (const lot of building.source_lots) {
                drawPolygon(lot, null, COLORS.lotStroke, 0.05, [0.45, 0.45]);
            }
        } else if (building.lot_footprint) {
            drawPolygon(building.lot_footprint, null, COLORS.lotStroke, 0.05, [0.45, 0.45]);
        }
    }
}

function drawRoofFaces(roof, building, level = 0) {
    if (!roof || !roof.faces) {
        return;
    }
    for (const face of roof.faces) {
        if (face.polygon && face.polygon.length >= 3) {
            drawPolygon(face.polygon, roofColor(face.direction, level, building), null, 0);
        }
    }
}

function drawRoofOutline(roof, selected) {
    if (roof && roof.polygon && roof.polygon.length >= 3) {
        drawPolygon(roof.polygon, null, selected ? "rgba(44,34,22,0.52)" : "rgba(62,49,32,0.16)", selected ? 0.10 : 0.05);
    }
}

function drawRidges(roof) {
    if (!roof) {
        return;
    }
    const segments = roof.extras && roof.extras.segments ? roof.extras.segments : [];
    ctx.strokeStyle = COLORS.ridge;
    ctx.lineWidth = 0.05 / Math.max(scale, 0.001);
    if (segments.length) {
        for (const segment of segments) {
            ctx.beginPath();
            ctx.moveTo(segment[0][0], segment[0][1]);
            ctx.lineTo(segment[1][0], segment[1][1]);
            ctx.stroke();
        }
        return;
    }
    const ridge = roof.ridge_polygon || [];
    if (ridge.length < 2) {
        return;
    }
    if (roof.type === "hipped" && ridge.length > 2) {
        return;
    }
    if (roof.type === "gabled" || roof.type === "vaulted") {
        for (let i = 0; i < ridge.length - 1; i += 2) {
            ctx.beginPath();
            ctx.moveTo(ridge[i][0], ridge[i][1]);
            ctx.lineTo(ridge[i + 1][0], ridge[i + 1][1]);
            ctx.stroke();
        }
        return;
    }
    ctx.beginPath();
    ctx.moveTo(ridge[0][0], ridge[0][1]);
    for (let i = 1; i < ridge.length; i++) {
        ctx.lineTo(ridge[i][0], ridge[i][1]);
    }
    if (ridge.length >= 3) {
        ctx.closePath();
    }
    ctx.stroke();
}

function lighten(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return "#" +
        Math.min(255, r + amount).toString(16).padStart(2, "0") +
        Math.min(255, g + amount).toString(16).padStart(2, "0") +
        Math.min(255, b + amount).toString(16).padStart(2, "0");
}

function drawBuildings() {
    for (const building of districtData.buildings || []) {
        const footprint = getBuildingFootprint(building);
        drawGroundShadow(footprint);
    }

    for (const building of districtData.buildings || []) {
        const colors = BUILDING_COLORS[building.type] || DEFAULT_BLDG;
        const isHovered = hoveredBuilding && hoveredBuilding.id === building.id;
        const isSelected = selectedBuilding && selectedBuilding.id === building.id;
        const fill = building.type === "field"
            ? colors.fill
            : (isSelected ? "#ffe08c" : (isHovered ? lighten(colors.fill, 18) : colors.fill));

        const footprint = getBuildingFootprint(building);

        if (building.compound && (building.wings || []).length) {
            for (const wing of building.wings) {
                drawPolygon(wing.footprint, fill, colors.stroke, isSelected ? 0.08 : 0.04);
            }
            drawPolygon(footprint, null, colors.stroke, isSelected ? 0.08 : 0.05);
            continue;
        }

        drawPolygon(footprint, fill, colors.stroke, isSelected ? 0.08 : 0.04);
    }

    if (!isLayerOn("layer-roofs")) {
        return;
    }

    for (const building of districtData.buildings || []) {
        const isSelected = selectedBuilding && selectedBuilding.id === building.id;
        if (building.compound && (building.height_groups || []).length) {
            for (const group of building.height_groups || []) {
                if (group.roof) {
                    drawRoofFaces(group.roof, building, group.stories || building.stories || 1);
                    drawRoofOutline(group.roof, isSelected);
                }
            }
            continue;
        }

        if (building.roof) {
            drawRoofFaces(building.roof, building, building.stories || 1);
            drawRoofOutline(building.roof, isSelected);
        }
    }
}

function drawLabels() {
    const fontSize = Math.max(1.6, 3 / scale * (scale > 2 ? 1 : 0.7));
    ctx.font = `${fontSize}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS.label;
    for (const building of districtData.buildings || []) {
        const footprint = getBuildingFootprint(building);
        if (!footprint || footprint.length < 3) {
            continue;
        }
        let cx = 0;
        let cy = 0;
        for (const [x, y] of footprint) {
            cx += x;
            cy += y;
        }
        cx /= footprint.length;
        cy /= footprint.length;
        ctx.globalAlpha = 0.72;
        ctx.fillText(building.sub_type || building.type, cx, cy - fontSize * 0.15);
        const roof = getBuildingRoof(building);
        if (roof) {
            ctx.globalAlpha = 0.48;
            ctx.fillText(roof.type, cx, cy + fontSize * 0.95);
        }
        ctx.globalAlpha = 1;
    }
}

function drawDebug() {
    const fontSize = Math.max(1.1, 2.2 / scale);
    ctx.font = `${fontSize}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#8a4738";
    for (const building of districtData.buildings || []) {
        const footprint = getBuildingFootprint(building);
        if (!footprint || footprint.length < 3) {
            continue;
        }
        let cx = 0;
        let cy = 0;
        for (const [x, y] of footprint) {
            cx += x;
            cy += y;
        }
        cx /= footprint.length;
        cy /= footprint.length;
        ctx.fillText(`${building.id} - ${building.massing_type || "original"} - v${building.vertex_count || footprint.length}`, cx, cy + fontSize * 1.4);
    }
}

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!districtData) {
        ctx.fillStyle = "#6d624f";
        ctx.font = "16px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Click Generate to build a district roofscape", canvas.width / 2, canvas.height / 2);
        return;
    }
    ctx.save();
    ctx.translate(translateX, translateY);
    ctx.scale(scale, scale);
    if (isLayerOn("layer-boundary")) drawBoundary();
    if (isLayerOn("layer-alleys")) drawAlleys();
    if (isLayerOn("layer-lots")) drawLotEnvelopes();
    if (isLayerOn("layer-walls")) drawBuildings();
    if (isLayerOn("layer-ridges")) {
        for (const building of districtData.buildings || []) {
            if (building.compound && (building.height_groups || []).length) {
                for (const group of building.height_groups) {
                    if (group.roof) drawRidges(group.roof);
                }
            } else if (building.roof) {
                drawRidges(building.roof);
            }
        }
    }
    if (isLayerOn("layer-labels")) drawLabels();
    if (isLayerOn("layer-debug")) drawDebug();
    ctx.restore();
}

function pointInPolygon(x, y, points) {
    if (!points || points.length < 3) {
        return false;
    }
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function findBuildingAt(wx, wy) {
    if (!districtData || !districtData.buildings) {
        return null;
    }
    for (let i = districtData.buildings.length - 1; i >= 0; i--) {
        const building = districtData.buildings[i];
        if (pointInPolygon(wx, wy, getBuildingFootprint(building))) {
            return building;
        }
    }
    return null;
}

function polygonArea(points) {
    if (!points || points.length < 3) {
        return 0;
    }
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return Math.abs(area / 2);
}

async function generate() {
    const params = new URLSearchParams();
    const popSelect = document.getElementById("populator").value;
    if (popSelect !== "auto") {
        params.set("populator", popSelect);
    }

    params.set("seed", document.getElementById("seed").value);
    params.set("min_area", document.getElementById("min-area").value);
    params.set("grid_chaos", document.getElementById("grid-chaos").value);
    params.set("size_chaos", document.getElementById("size-chaos").value);
    params.set("empty_prob", document.getElementById("empty-prob").value);
    params.set("density", document.getElementById("density").value);
    params.set("alley_width", document.getElementById("alley-width").value);
    params.set("district_type", document.getElementById("district-type").value);
    params.set("style", document.getElementById("style").value);
    params.set("roof_type", document.getElementById("roof-type").value);
    params.set("overhang", document.getElementById("overhang").value);
    params.set("facade_density", document.getElementById("facade-density").value);
    params.set("massing_mode", document.getElementById("massing-mode").value);
    params.set("complexity", document.getElementById("complexity").value);
    params.set("complex_ratio", document.getElementById("complex-ratio").value);
    params.set("join_ratio", document.getElementById("join-ratio").value);
    params.set("setback", document.getElementById("setback").value);

    if (customPolygon) {
        params.set("polygon", JSON.stringify(customPolygon));
    } else {
        params.set("preset", document.getElementById("preset").value);
    }

    const t0 = performance.now();
    statusBar.textContent = "Generating roofscape...";
    try {
        const resp = await fetch(`/api/district_roofs?${params.toString()}`);
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        districtData = await resp.json();
        selectedBuilding = null;
        hoveredBuilding = null;
        fitView();
        render();

        const elapsed = Math.round(performance.now() - t0);
        const total = (districtData.buildings || []).length;
        const roofed = (districtData.buildings || []).filter(b => b.roof || (b.height_groups || []).length).length;
        const complex = (districtData.buildings || []).filter(b => (b.massing_type || "original") !== "original").length;
        const joined = (districtData.buildings || []).filter(b => (b.source_count || 1) > 1).length;
        const complexPct = roofed ? Math.round((complex / roofed) * 100) : 0;
        const joinedPct = total ? Math.round((joined / total) * 100) : 0;
        statusBar.textContent = `Generated in ${elapsed}ms - ${total} buildings, ${roofed} roofed, ${complex} reshaped (${complexPct}%), ${joined} merged (${joinedPct}%) - populator: ${districtData.populator}`;
    } catch (err) {
        statusBar.textContent = `Error: ${err.message}`;
    }
}

async function loadPopulators() {
    try {
        const resp = await fetch("/api/district/populators");
        if (!resp.ok) {
            return;
        }
        populatorList = await resp.json();
        const select = document.getElementById("populator");
        for (const populator of populatorList) {
            const opt = document.createElement("option");
            opt.value = populator.name;
            opt.textContent = `${populator.name} - ${populator.description}`;
            select.appendChild(opt);
        }
    } catch (err) {
        // ignore
    }
}

function setupSlider(id, formatter = null) {
    const slider = document.getElementById(id);
    const value = document.getElementById(`${id}-val`);
    if (!slider || !value) {
        return;
    }
    const renderValue = () => {
        if (formatter) {
            value.textContent = formatter(parseFloat(slider.value));
            return;
        }
        const decimals = slider.step && slider.step.includes(".") ? slider.step.split(".")[1].length : 0;
        value.textContent = parseFloat(slider.value).toFixed(decimals);
    };
    slider.addEventListener("input", renderValue);
    renderValue();
}

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

function showImportPanel(mode) {
    document.getElementById("import-panel").style.display = "block";
    document.getElementById("import-overlay").style.display = "block";
    document.getElementById("citymap-district-picker").style.display = "none";
    document.getElementById("import-text").dataset.mode = mode || "polygon";
    document.getElementById("import-text").placeholder = mode === "citymap"
        ? "Paste CityMap JSON here..."
        : "[[0,0],[50,0],[50,40],[0,40]]";
}

function hideImportPanel() {
    document.getElementById("import-panel").style.display = "none";
    document.getElementById("import-overlay").style.display = "none";
}

document.getElementById("import-polygon-btn").addEventListener("click", () => showImportPanel("polygon"));
document.getElementById("import-citymap-btn").addEventListener("click", () => showImportPanel("citymap"));
document.getElementById("import-cancel").addEventListener("click", hideImportPanel);
document.getElementById("import-overlay").addEventListener("click", hideImportPanel);

document.getElementById("import-text").addEventListener("input", () => {
    const mode = document.getElementById("import-text").dataset.mode;
    if (mode !== "citymap") {
        return;
    }
    try {
        const data = JSON.parse(document.getElementById("import-text").value);
        if (data.districts && Array.isArray(data.districts)) {
            const picker = document.getElementById("citymap-district-picker");
            const select = document.getElementById("pick-district");
            select.innerHTML = "";
            for (const district of data.districts) {
                const opt = document.createElement("option");
                opt.value = district.id;
                opt.textContent = `${district.id}: ${district.type}${district.landmark ? ` [${district.landmark}]` : ""}`;
                select.appendChild(opt);
            }
            picker.style.display = "block";
        }
    } catch (err) {
        // ignore partial input
    }
});

document.getElementById("import-apply").addEventListener("click", () => {
    const mode = document.getElementById("import-text").dataset.mode;
    const text = document.getElementById("import-text").value.trim();
    try {
        const data = JSON.parse(text);
        if (mode === "citymap" && data.districts) {
            const districtId = document.getElementById("pick-district").value;
            const district = data.districts.find(item => item.id === districtId);
            if (!district || !district.polygon) {
                statusBar.textContent = "No valid district found";
                return;
            }
            customPolygon = district.polygon;
            if (district.type) {
                document.getElementById("district-type").value = district.type;
            }
            statusBar.textContent = `Imported district ${district.id} (${district.type}) from CityMap`;
        } else if (Array.isArray(data) && data.length >= 3 && Array.isArray(data[0])) {
            customPolygon = data;
            statusBar.textContent = `Imported polygon with ${data.length} vertices`;
        } else {
            statusBar.textContent = "Unrecognized JSON format";
            return;
        }
    } catch (err) {
        statusBar.textContent = `JSON parse error: ${err.message}`;
        return;
    }
    hideImportPanel();
    generate();
});

document.getElementById("generate").addEventListener("click", generate);
document.getElementById("random").addEventListener("click", () => {
    document.getElementById("seed").value = Math.floor(Math.random() * 999999) + 1;
    generate();
});
document.getElementById("reset-zoom").addEventListener("click", () => {
    fitView();
    render();
});
document.getElementById("preset").addEventListener("change", () => {
    customPolygon = null;
});

canvasArea.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvasArea.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    const newScale = scale * factor;
    translateX = mx - (mx - translateX) * (newScale / scale);
    translateY = my - (my - translateY) * (newScale / scale);
    scale = Math.max(1.5, Math.min(80, newScale));
    render();
}, { passive: false });

canvasArea.addEventListener("mousedown", event => {
    if (event.button !== 0) {
        return;
    }
    isPanning = true;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panStartTX = translateX;
    panStartTY = translateY;
    canvasArea.classList.add("grabbing");
});

window.addEventListener("mousemove", event => {
    if (isPanning) {
        translateX = panStartTX + (event.clientX - panStartX);
        translateY = panStartTY + (event.clientY - panStartY);
        render();
        return;
    }
    if (!districtData) {
        return;
    }

    const rect = canvasArea.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const [wx, wy] = screenToWorld(mx, my);
    const building = findBuildingAt(wx, wy);
    if (building !== hoveredBuilding) {
        hoveredBuilding = building;
        render();
    }

    if (building) {
        const footprint = getBuildingFootprint(building);
        const roof = getBuildingRoof(building);
        const roofType = roof ? roof.type : "none";
        tooltip.style.display = "block";
        tooltip.style.left = `${event.clientX - canvasArea.getBoundingClientRect().left + 12}px`;
        tooltip.style.top = `${event.clientY - canvasArea.getBoundingClientRect().top - 8}px`;
        tooltip.textContent = `${building.id}: ${building.type}${building.sub_type ? ` (${building.sub_type})` : ""} - ${building.stories || 1}F - roof: ${roofType} - massing: ${building.massing_type || "original"} - area: ${polygonArea(footprint).toFixed(1)}`;
    } else {
        tooltip.style.display = "none";
    }
});

window.addEventListener("mouseup", () => {
    if (isPanning) {
        isPanning = false;
        canvasArea.classList.remove("grabbing");
    }
});

canvasArea.addEventListener("click", event => {
    if (!districtData) {
        return;
    }
    const rect = canvasArea.getBoundingClientRect();
    const [wx, wy] = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const building = findBuildingAt(wx, wy);
    selectedBuilding = (building && selectedBuilding && building.id === selectedBuilding.id) ? null : building;
    render();
    if (selectedBuilding) {
        const footprint = getBuildingFootprint(selectedBuilding);
        const roof = getBuildingRoof(selectedBuilding);
        statusBar.textContent = `Selected ${selectedBuilding.id} - ${selectedBuilding.type} - ${roof ? roof.type : "no roof"} - ${selectedBuilding.massing_type || "original"} - ${selectedBuilding.vertex_count || footprint.length} vertices`;
    }
});

window.addEventListener("keydown", event => {
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        return;
    }
    if (event.key === "Escape") {
        selectedBuilding = null;
        render();
    }
    if (event.key === "g" || event.key === "G") {
        generate();
    }
    if (event.key === " ") {
        event.preventDefault();
        fitView();
        render();
    }
});

document.querySelectorAll(".layer-toggle input").forEach(input => input.addEventListener("change", render));
document.querySelectorAll(".section-header").forEach(header => {
    header.addEventListener("click", () => {
        const section = header.dataset.section;
        const content = document.getElementById(`sec-${section}`);
        header.classList.toggle("collapsed");
        content.classList.toggle("hidden");
    });
});

document.getElementById("export-btn").addEventListener("click", () => {
    if (!districtData) {
        statusBar.textContent = "Nothing to export";
        return;
    }
    const text = JSON.stringify(districtData, null, 2);
    navigator.clipboard.writeText(text).then(() => {
        statusBar.textContent = "JSON copied to clipboard";
    }).catch(() => {
        document.getElementById("import-text").value = text;
        showImportPanel("polygon");
    });
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
loadPopulators();
