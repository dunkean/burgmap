/* M5 — Building Detail & Roofscape — standalone editor JS */

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const wrap = document.getElementById("canvasWrap");

let data = null;
let viewX = 0, viewY = 0, viewScale = 12;
let dragging = false, dragStartX = 0, dragStartY = 0;

// Light direction: from upper-left (normalized)
const LIGHT_DX = -0.7071;
const LIGHT_DY = -0.7071;

// Shadow offset in world units
const SHADOW_DX = 0.8;
const SHADOW_DY = 1.0;

// --- Colors ---
const COLORS = {
    bg: "#e8dcc8",             // warm paper background
    ground: "#d4c8b0",         // ground around building
    shadow: "rgba(40,30,20,0.35)",
    wallLight: "#c8b898",      // wall lit side
    wallDark: "#a89878",       // wall shade side
    wallStroke: "#6b5a42",
    roofBase: [180, 120, 70],  // RGB base for roof shading
    ridgeLine: "#5a4030",
    parapet: "#8a7a6a",
    facadeWindow: "#4a6680",
    facadeDoor: "#7a5030",
    facadeChimney: "#5a4a3a",
    facadeButtress: "#9a8a7a",
    facadeMinaret: "#c8a050",
    facadeBalcony: "#8a7a6a",
};

// --- Sizing ---
function resize() {
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
}
window.addEventListener("resize", resize);

// --- View transforms ---
function worldToScreen(wx, wy) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return [cx + (wx - viewX) * viewScale, cy + (wy - viewY) * viewScale];
}

function screenToWorld(sx, sy) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return [(sx - cx) / viewScale + viewX, (sy - cy) / viewScale + viewY];
}

function resetView() {
    viewX = 0; viewY = 0; viewScale = 12;
    draw();
}

// --- Pan & Zoom ---
canvas.addEventListener("mousedown", e => {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
});
canvas.addEventListener("mousemove", e => {
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY);
    document.getElementById("statusCoords").textContent =
        `Cursor: ${wx.toFixed(1)}, ${wy.toFixed(1)}`;
    if (dragging) {
        viewX -= (e.clientX - dragStartX) / viewScale;
        viewY -= (e.clientY - dragStartY) / viewScale;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        draw();
    }
});
canvas.addEventListener("mouseup", () => { dragging = false; });
canvas.addEventListener("mouseleave", () => { dragging = false; });
canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY);
    viewScale *= factor;
    viewScale = Math.max(1, Math.min(120, viewScale));
    viewX = wx - (e.offsetX - canvas.width / 2) / viewScale;
    viewY = wy - (e.offsetY - canvas.height / 2) / viewScale;
    draw();
}, { passive: false });

// --- Overhang slider ---
const overhangSlider = document.getElementById("overhang");
const overhangVal = document.getElementById("overhangVal");
overhangSlider.addEventListener("input", () => {
    const v = parseFloat(overhangSlider.value);
    overhangVal.textContent = v < 0 ? "auto" : v.toFixed(1);
});
overhangSlider.addEventListener("change", generate);

// --- Shape mode toggle ---
function onShapeModeChange() {
    const mode = document.getElementById("shapeMode").value;
    document.getElementById("simpleControls").style.display = mode === "simple" ? "" : "none";
    document.getElementById("compoundControls").style.display = mode === "compound" ? "" : "none";
    generate();
}

// --- API call ---
async function generate() {
    const mode = document.getElementById("shapeMode").value;
    const roofType = document.getElementById("roofType").value;
    const overhang = parseFloat(document.getElementById("overhang").value);
    const facadeDensity = parseInt(document.getElementById("facadeDensity").value);
    const style = document.getElementById("style").value;
    const buildingType = document.getElementById("buildingType").value;
    const stories = parseInt(document.getElementById("stories").value);

    let seed = parseInt(document.getElementById("seed").value);

    // Auto-randomize seed for compound shapes when seed is -1
    if (mode === "compound" && seed === -1) {
        seed = Math.floor(Math.random() * 9999);
        document.getElementById("seed").value = seed;
    }

    const params = new URLSearchParams({
        roof_type: roofType,
        overhang: overhang.toString(),
        facade_density: facadeDensity.toString(),
        style,
        building_type: buildingType,
        stories: stories.toString(),
        seed: seed.toString(),
    });

    if (mode === "compound") {
        const shape = document.getElementById("compoundShape").value;
        params.set("compound", shape);
    } else {
        const preset = document.getElementById("preset").value;
        params.set("preset", preset);
    }

    document.getElementById("infoText").textContent = "Generating...";
    try {
        const resp = await fetch(`/api/building?${params}`);
        data = await resp.json();
        updateStatusBar();
        resetView();
    } catch (err) {
        document.getElementById("infoText").textContent = `Error: ${err.message}`;
    }
}

function updateStatusBar() {
    if (!data) return;
    if (data.compound) {
        const nWings = (data.wings || []).length;
        const nGroups = (data.height_groups || []).length;
        const totalFaces = (data.height_groups || []).reduce(
            (s, g) => s + (g.roof?.faces || []).length, 0);
        const totalDetails = (data.wings || []).reduce(
            (s, w) => s + (w.facade_details || []).length, 0);
        const groupInfo = (data.height_groups || []).map(g => `${g.stories}F`).join("+");
        document.getElementById("infoText").textContent =
            `Compound: ${data.shape_type} | Wings: ${nWings} | Groups: ${groupInfo} | Faces: ${totalFaces}`;
        document.getElementById("statusRoof").textContent =
            `Shape: ${data.shape_type} (${nGroups} height group${nGroups > 1 ? "s" : ""})`;
        document.getElementById("statusDetails").textContent =
            `Details: ${totalDetails} items`;
    } else {
        document.getElementById("infoText").textContent =
            `Roof: ${data.roof?.type || "none"} | Faces: ${(data.roof?.faces || []).length} | Details: ${(data.facade_details || []).length}`;
        document.getElementById("statusRoof").textContent =
            `Roof: ${data.roof?.type || "none"} (overhang: ${data.roof?.overhang ?? "—"})`;
        document.getElementById("statusDetails").textContent =
            `Details: ${(data.facade_details || []).length} items`;
    }
}

// --- Shading helpers ---
function faceBrightness(direction) {
    const dot = direction[0] * LIGHT_DX + direction[1] * LIGHT_DY;
    return 0.35 + 0.65 * Math.max(0, (dot + 1) / 2);
}

function roofColor(direction, baseRGB) {
    const b = faceBrightness(direction);
    const r = Math.round(baseRGB[0] * b);
    const g = Math.round(baseRGB[1] * b);
    const bl = Math.round(baseRGB[2] * b);
    return `rgb(${r},${g},${bl})`;
}

// --- Drawing ---
function draw() {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const showGrid = document.getElementById("layerGrid").checked;
    const showFootprint = document.getElementById("layerFootprint").checked;
    const showRoof = document.getElementById("layerRoof").checked;
    const showRidge = document.getElementById("layerRidge").checked;
    const showFacade = document.getElementById("layerFacade").checked;
    const showLabels = document.getElementById("layerLabels").checked;

    if (showGrid) drawGrid();
    if (!data) return;

    if (data.compound) {
        drawCompound(data, { showFootprint, showRoof, showRidge, showFacade, showLabels });
    } else {
        drawSimple(data, { showFootprint, showRoof, showRidge, showFacade, showLabels });
    }
}

// --- Simple (single) building drawing ---
function drawSimple(bld, layers) {
    const fp = bld.polygon || bld.footprint;
    const roof = bld.roof;
    const fpCenter = polyCenter(fp);

    if (layers.showFootprint || layers.showRoof) {
        drawGroundShadow(roof?.polygon || fp);
    }
    if (layers.showFootprint) {
        drawWalls(fp, fpCenter, bld.stories || 1);
    }
    if (layers.showRoof && roof) {
        drawRoofFaces(roof);
    }
    if (layers.showRoof && roof) {
        drawRoofOutline(roof);
    }
    if (layers.showRidge && roof) {
        drawRidgeLines(roof);
    }
    if (layers.showFacade && bld.facade_details) {
        drawFacadeDetails(bld.facade_details);
    }
    if (layers.showLabels && roof) {
        drawSimpleLabels(bld);
    }
}

// --- Compound building drawing ---
function drawCompound(cmpd, layers) {
    const outline = cmpd.outline;
    const wings = cmpd.wings || [];
    const groups = cmpd.height_groups || [];

    // 1. Ground shadow from the overall outline
    if (layers.showFootprint || layers.showRoof) {
        drawGroundShadow(outline);
    }

    // 2. Draw each height group bottom-to-top (already sorted by stories)
    for (const group of groups) {
        const groupOutline = group.outline;
        const roof = group.roof;

        // Walls for this height group's outline
        if (layers.showFootprint && groupOutline && groupOutline.length >= 3) {
            drawWalls(groupOutline, polyCenter(groupOutline), group.stories || 1);
        }

        // Merged roof faces
        if (layers.showRoof && roof) {
            drawRoofFaces(roof);
        }

        // Roof outline
        if (layers.showRoof && roof) {
            drawRoofOutline(roof);
        }

        // Ridge lines
        if (layers.showRidge && roof) {
            drawRidgeLines(roof);
        }
    }

    // 3. Facade details for each wing
    if (layers.showFacade) {
        for (const wing of wings) {
            if (wing.facade_details) drawFacadeDetails(wing.facade_details);
        }
    }

    // 4. Labels
    if (layers.showLabels) {
        drawCompoundLabels(cmpd);
    }
}

// --- Grid ---
function drawGrid() {
    const step = viewScale >= 5 ? 5 : 10;
    const [wl, wt] = screenToWorld(0, 0);
    const [wr, wb] = screenToWorld(canvas.width, canvas.height);
    ctx.strokeStyle = "#c8bca8";
    ctx.lineWidth = 0.3;
    const startX = Math.floor(wl / step) * step;
    const startY = Math.floor(wt / step) * step;
    for (let x = startX; x <= wr; x += step) {
        const [sx] = worldToScreen(x, 0);
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
    }
    for (let y = startY; y <= wb; y += step) {
        const [, sy] = worldToScreen(0, y);
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
    }
    const [ox, oy] = worldToScreen(0, 0);
    ctx.strokeStyle = "#b0a490";
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(ox - 8, oy); ctx.lineTo(ox + 8, oy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, oy - 8); ctx.lineTo(ox, oy + 8); ctx.stroke();
}

// --- Ground shadow ---
function drawGroundShadow(pts) {
    if (!pts || pts.length < 3) return;
    ctx.fillStyle = COLORS.shadow;
    ctx.beginPath();
    const [sx, sy] = worldToScreen(pts[0][0] + SHADOW_DX, pts[0][1] + SHADOW_DY);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < pts.length; i++) {
        const [x, y] = worldToScreen(pts[i][0] + SHADOW_DX, pts[i][1] + SHADOW_DY);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
}

// --- Walls (footprint) ---
function drawWalls(fp, center, stories) {
    if (!fp || fp.length < 3) return;
    const n = fp.length;

    // Fill footprint with base wall color
    ctx.beginPath();
    const [sx0, sy0] = worldToScreen(fp[0][0], fp[0][1]);
    ctx.moveTo(sx0, sy0);
    for (let i = 1; i < n; i++) {
        const [x, y] = worldToScreen(fp[i][0], fp[i][1]);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.wallLight;
    ctx.fill();

    // Shade each wall face by orientation
    for (let i = 0; i < n; i++) {
        const a = fp[i];
        const b = fp[(i + 1) % n];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const dot = nx * LIGHT_DX + ny * LIGHT_DY;
        if (dot < 0) {
            const inset = 0.6 * Math.min(stories, 3);
            const ax = a[0] + nx * inset;
            const ay = a[1] + ny * inset;
            const bx2 = b[0] + nx * inset;
            const by2 = b[1] + ny * inset;
            ctx.beginPath();
            const [sa, sb] = [worldToScreen(a[0], a[1]), worldToScreen(b[0], b[1])];
            const [sc, sd] = [worldToScreen(bx2, by2), worldToScreen(ax, ay)];
            ctx.moveTo(sa[0], sa[1]);
            ctx.lineTo(sb[0], sb[1]);
            ctx.lineTo(sc[0], sc[1]);
            ctx.lineTo(sd[0], sd[1]);
            ctx.closePath();
            ctx.fillStyle = `rgba(40,30,20,${0.15 * Math.abs(dot)})`;
            ctx.fill();
        }
    }

    // Wall outline
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    for (let i = 1; i < n; i++) {
        const [x, y] = worldToScreen(fp[i][0], fp[i][1]);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = COLORS.wallStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

// --- Roof faces ---
function drawRoofFaces(roof) {
    if (!roof.faces || roof.faces.length === 0) {
        fillPoly(roof.polygon, COLORS.wallLight, 0.5);
        return;
    }

    const baseRGB = COLORS.roofBase;
    const fallbackFaces = String(roof?.extras?.algorithm || "").startsWith("fallback_");

    for (const face of roof.faces) {
        const pts = face.polygon;
        if (!pts || pts.length < 3) continue;

        const color = roofColor(face.direction, baseRGB);

        ctx.beginPath();
        const [sx, sy] = worldToScreen(pts[0][0], pts[0][1]);
        ctx.moveTo(sx, sy);
        for (let i = 1; i < pts.length; i++) {
            const [x, y] = worldToScreen(pts[i][0], pts[i][1]);
            ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        if (!fallbackFaces) {
            ctx.strokeStyle = "rgba(80,60,40,0.25)";
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
    }

    if (roof.type === "thatched") {
        drawHatchOverlay(roof.polygon);
    }
}

// --- Roof outline ---
function drawRoofOutline(roof) {
    const pts = roof.polygon;
    if (!pts || pts.length < 3) return;

    ctx.beginPath();
    const [sx, sy] = worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < pts.length; i++) {
        const [x, y] = worldToScreen(pts[i][0], pts[i][1]);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(60,45,30,0.6)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
}

// --- Ridge lines ---
function drawRidgeLines(roof) {
    const ridge = roof.ridge_polygon;
    if (!ridge || ridge.length === 0) return;

    const type = roof.type;

    ctx.strokeStyle = COLORS.ridgeLine;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([]);

    if (type === "gabled" || type === "vaulted") {
        for (let i = 0; i < ridge.length - 1; i += 2) {
            const [ax, ay] = worldToScreen(ridge[i][0], ridge[i][1]);
            const [bx, by] = worldToScreen(ridge[i + 1][0], ridge[i + 1][1]);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
        }
    } else if (type === "domed") {
        if (roof.extras?.dome_center && roof.extras?.dome_radius) {
            const [cx, cy] = worldToScreen(roof.extras.dome_center[0], roof.extras.dome_center[1]);
            const r = roof.extras.dome_radius * viewScale;
            for (let ring = 1; ring <= 3; ring++) {
                const rr = r * ring / 3;
                ctx.strokeStyle = `rgba(90,70,48,${0.5 - ring * 0.12})`;
                ctx.lineWidth = 1.5 - ring * 0.3;
                ctx.beginPath();
                ctx.arc(cx, cy, rr, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.fillStyle = COLORS.ridgeLine;
            ctx.beginPath();
            ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    } else if (type === "conical") {
        if (ridge.length > 0) {
            const [cx, cy] = worldToScreen(ridge[0][0], ridge[0][1]);
            ctx.fillStyle = COLORS.ridgeLine;
            ctx.beginPath();
            ctx.arc(cx, cy, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    } else if (type === "flat") {
        if (ridge.length >= 3) {
            ctx.strokeStyle = COLORS.parapet;
            ctx.lineWidth = 0.8;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            const [sx, sy] = worldToScreen(ridge[0][0], ridge[0][1]);
            ctx.moveTo(sx, sy);
            for (let i = 1; i < ridge.length; i++) {
                const [x, y] = worldToScreen(ridge[i][0], ridge[i][1]);
                ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
        }
    } else if (type === "pagoda") {
        ctx.strokeStyle = COLORS.ridgeLine;
        ctx.lineWidth = 0.8;
        if (ridge.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(...worldToScreen(ridge[0][0], ridge[0][1]));
            for (let i = 1; i < ridge.length; i++) {
                ctx.lineTo(...worldToScreen(ridge[i][0], ridge[i][1]));
            }
            ctx.stroke();
        }
    } else {
        // Hipped / thatched — inner polygon ridge
        if (ridge.length >= 3) {
            ctx.strokeStyle = COLORS.ridgeLine;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const [sx, sy] = worldToScreen(ridge[0][0], ridge[0][1]);
            ctx.moveTo(sx, sy);
            for (let i = 1; i < ridge.length; i++) {
                const [x, y] = worldToScreen(ridge[i][0], ridge[i][1]);
                ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
        }
    }
}

// --- Hatch overlay (thatched) ---
function drawHatchOverlay(pts) {
    if (!pts || pts.length < 3) return;
    const allX = pts.map(p => p[0]);
    const allY = pts.map(p => p[1]);
    const minX = Math.min(...allX), maxX = Math.max(...allX);
    const minY = Math.min(...allY), maxY = Math.max(...allY);
    const step = Math.max(0.6, 1.2 / viewScale * 8);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(pts[0][0], pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...worldToScreen(pts[i][0], pts[i][1]));
    ctx.closePath();
    ctx.clip();

    ctx.strokeStyle = "rgba(70,50,30,0.20)";
    ctx.lineWidth = 0.6;
    for (let d = minX + minY; d <= maxX + maxY; d += step) {
        ctx.beginPath();
        ctx.moveTo(...worldToScreen(d - minY, minY));
        ctx.lineTo(...worldToScreen(d - maxY, maxY));
        ctx.stroke();
    }
    ctx.restore();
}

// --- Facade details ---
function drawFacadeDetails(details) {
    for (const d of details) {
        const [sx, sy] = worldToScreen(d.pos[0], d.pos[1]);
        const sz = d.size * viewScale * 0.25;

        switch (d.type) {
            case "window": {
                ctx.fillStyle = COLORS.facadeWindow;
                ctx.strokeStyle = "rgba(30,40,50,0.5)";
                ctx.lineWidth = 0.5;
                const ww = sz * 0.7, wh = sz * 0.9;
                ctx.fillRect(sx - ww / 2, sy - wh / 2, ww, wh);
                ctx.strokeRect(sx - ww / 2, sy - wh / 2, ww, wh);
                break;
            }
            case "door": {
                ctx.fillStyle = COLORS.facadeDoor;
                ctx.strokeStyle = "rgba(40,20,10,0.6)";
                ctx.lineWidth = 0.6;
                const dw = sz * 0.8, dh = sz * 1.2;
                ctx.fillRect(sx - dw / 2, sy - dh / 2, dw, dh);
                ctx.strokeRect(sx - dw / 2, sy - dh / 2, dw, dh);
                break;
            }
            case "chimney": {
                ctx.fillStyle = COLORS.facadeChimney;
                const cs = sz * 0.6;
                ctx.fillRect(sx - cs / 2, sy - cs / 2, cs, cs);
                ctx.strokeStyle = "rgba(30,20,10,0.4)";
                ctx.lineWidth = 0.4;
                ctx.strokeRect(sx - cs / 2, sy - cs / 2, cs, cs);
                break;
            }
            case "buttress": {
                ctx.fillStyle = COLORS.facadeButtress;
                const angle = d.orientation * Math.PI / 180;
                const bw = sz * 0.35, bh = sz * 0.7;
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(angle);
                ctx.fillRect(-bw / 2, 0, bw, bh);
                ctx.restore();
                break;
            }
            case "balcony": {
                ctx.strokeStyle = COLORS.facadeBalcony;
                ctx.lineWidth = 0.8;
                const bs = Math.max(sz, viewScale * 0.4);
                ctx.strokeRect(sx - bs, sy - bs * 0.25, bs * 2, bs * 0.5);
                break;
            }
            case "minaret": {
                ctx.fillStyle = COLORS.facadeMinaret;
                ctx.beginPath();
                ctx.arc(sx, sy, sz * 0.7, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = "rgba(100,70,30,0.5)";
                ctx.lineWidth = 0.6;
                ctx.stroke();
                ctx.fillStyle = "#e8c060";
                ctx.beginPath();
                ctx.arc(sx, sy, sz * 0.2, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
        }
    }
}

// --- Labels ---
function drawSimpleLabels(bld) {
    if (!bld || !bld.roof) return;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#6a5a4a";
    ctx.textAlign = "center";

    const fp = bld.polygon || bld.footprint;
    if (fp && fp.length > 0) {
        const minY = Math.min(...fp.map(p => p[1]));
        const cx = fp.reduce((s, p) => s + p[0], 0) / fp.length;
        const [sx, sy] = worldToScreen(cx, minY);
        ctx.fillText(`${bld.roof.type} roof`, sx, sy - 12);
    }

    const count = (bld.facade_details || []).length;
    if (count > 0 && fp) {
        const maxY = Math.max(...fp.map(p => p[1]));
        const cx = fp.reduce((s, p) => s + p[0], 0) / fp.length;
        const [sx, sy] = worldToScreen(cx, maxY);
        ctx.fillText(`${count} detail${count > 1 ? "s" : ""}`, sx, sy + 18);
    }
}

function drawCompoundLabels(cmpd) {
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#6a5a4a";
    ctx.textAlign = "center";

    // Title above outline
    const outline = cmpd.outline;
    if (outline && outline.length > 0) {
        const minY = Math.min(...outline.map(p => p[1]));
        const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length;
        const [sx, sy] = worldToScreen(cx, minY);
        const nGroups = (cmpd.height_groups || []).length;
        const groupInfo = nGroups > 1 ? ` (${nGroups} levels)` : "";
        ctx.fillText(`${cmpd.shape_type} compound${groupInfo}`, sx, sy - 14);
    }

    // Per-height-group label
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#8a7a6a";
    for (const group of cmpd.height_groups || []) {
        const go = group.outline;
        if (!go || go.length < 3) continue;
        const c = polyCenter(go);
        const [sx, sy] = worldToScreen(c[0], c[1]);
        ctx.fillText(`${group.stories}F`, sx, sy + 4);
    }
}

// --- Helpers ---
function polyCenter(pts) {
    if (!pts || pts.length === 0) return [0, 0];
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [cx, cy];
}

function fillPoly(pts, color, alpha) {
    if (!pts || pts.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(...worldToScreen(pts[0][0], pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...worldToScreen(pts[i][0], pts[i][1]));
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
}

// --- Quick presets ---
function applyQuickPreset(name) {
    const presets = {
        european_house: { mode: "simple", preset: "house", buildingType: "house", style: "european_medieval", roofType: "" },
        arabic_house: { mode: "simple", preset: "house", buildingType: "house", style: "arabic_islamic", roofType: "" },
        asian_pagoda: { mode: "simple", preset: "cathedral", buildingType: "pagoda", style: "east_asian", roofType: "pagoda" },
        viking_hall: { mode: "simple", preset: "longhouse", buildingType: "great_hall", style: "viking", roofType: "" },
        roman_insula: { mode: "simple", preset: "large", buildingType: "house", style: "roman", roofType: "" },
        gothic_church: { mode: "simple", preset: "cathedral", buildingType: "cathedral", style: "european_medieval", roofType: "gabled" },
        tower: { mode: "simple", preset: "tower", buildingType: "tower", style: "generic", roofType: "" },
        mosque: { mode: "simple", preset: "mosque", buildingType: "mosque", style: "arabic_islamic", roofType: "" },
        keep_simple: { mode: "simple", preset: "large", buildingType: "keep", style: "european_medieval", roofType: "" },
        // Compound presets
        c_l_shape: { mode: "compound", compound: "l_shape", buildingType: "house", style: "european_medieval", roofType: "" },
        c_t_shape: { mode: "compound", compound: "t_shape", buildingType: "house", style: "european_medieval", roofType: "" },
        c_h_shape: { mode: "compound", compound: "h_shape", buildingType: "house", style: "european_medieval", roofType: "" },
        c_u_shape: { mode: "compound", compound: "u_shape", buildingType: "house", style: "european_medieval", roofType: "" },
        c_plus: { mode: "compound", compound: "plus", buildingType: "cathedral", style: "european_medieval", roofType: "gabled" },
        c_courtyard: { mode: "compound", compound: "courtyard", buildingType: "house", style: "european_medieval", roofType: "hipped" },
        c_cathedral: { mode: "compound", compound: "cathedral", buildingType: "cathedral", style: "european_medieval", roofType: "" },
        c_keep: { mode: "compound", compound: "keep", buildingType: "keep", style: "european_medieval", roofType: "" },
    };
    const p = presets[name];
    if (!p) return;

    // Set mode
    document.getElementById("shapeMode").value = p.mode;
    onShapeModeChange();

    if (p.mode === "compound") {
        document.getElementById("compoundShape").value = p.compound;
    } else {
        document.getElementById("preset").value = p.preset;
    }
    document.getElementById("buildingType").value = p.buildingType;
    document.getElementById("style").value = p.style;
    document.getElementById("roofType").value = p.roofType;
    generate();
}

// --- JSON export/import ---
function exportJSON() {
    if (!data) { alert("No data to export. Generate first."); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "building_detail.json";
    a.click();
    URL.revokeObjectURL(url);
}

function importJSON() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        try {
            data = JSON.parse(text);
            document.getElementById("infoText").textContent =
                data.compound ? `Imported: ${data.shape_type} compound` : `Imported: ${data.roof?.type || "unknown"} roof`;
            draw();
        } catch (err) {
            alert("Invalid JSON: " + err.message);
        }
    };
    input.click();
}

// --- Init ---
resize();
generate();
