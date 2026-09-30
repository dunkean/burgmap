// ===== Carte Geologique — Etape 1 =====

const canvas = document.getElementById('map-canvas');
const ctx = canvas.getContext('2d');
const viewer = document.getElementById('viewer');
const statusEl = document.getElementById('status');

// Controls
const seedInput = document.getElementById('seed');
const scaleSelect = document.getElementById('scale');
const reliefSelect = document.getElementById('relief');
const coastSelect = document.getElementById('coast');
const nRiversInput = document.getElementById('n_rivers');
const lakesSelect = document.getElementById('lakes');
const scaleInfo = document.getElementById('scale-info');

// Scale info
const SCALE_INFO = {
    hamlet:        { grid: 128, cell: 5.9 },
    village:       { grid: 192, cell: 7.8 },
    town:          { grid: 256, cell: 13.7 },
    city:          { grid: 320, cell: 23.4 },
    agglomeration: { grid: 384, cell: 45.6 },
};

scaleSelect.addEventListener('change', () => {
    const s = SCALE_INFO[scaleSelect.value];
    if (s) scaleInfo.textContent = `Grille: ${s.grid} x ${s.grid} — cellule: ${s.cell}m`;
});

// View mode
let viewMode = 'elevation';
const viewBtns = document.querySelectorAll('#view-mode button');
viewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        viewBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        viewMode = btn.dataset.mode;
        render();
    });
});

// Layer toggles
const layers = {
    contours:      document.getElementById('layer_contours'),
    rivers:        document.getElementById('layer_rivers'),
    lakes:         document.getElementById('layer_lakes'),
    coastline:     document.getElementById('layer_coastline'),
    biome_borders: document.getElementById('layer_biome_borders'),
};
Object.values(layers).forEach(cb => cb.addEventListener('change', render));

// State
let mapData = null;
let scale = 1, translateX = 0, translateY = 0;
let isPanning = false, panStartX = 0, panStartY = 0, panStartTX = 0, panStartTY = 0;

// ===== Color Maps =====

const BIOME_COLORS = {
    water:   [41, 128, 185],
    meadow:  [144, 200, 112],
    forest:  [43, 110, 43],
    marsh:   [74, 122, 106],
    field:   [200, 184, 80],
    pasture: [144, 200, 112],
    scrub:   [160, 144, 106],
};

function elevationColor(elev, maxElev, isWater) {
    if (isWater) {
        const d = Math.max(0, Math.min(1, elev / maxElev));
        return [
            Math.floor(15 + d * 30),
            Math.floor(40 + d * 60),
            Math.floor(90 + d * 80),
        ];
    }
    const t = Math.max(0, Math.min(1, elev / maxElev));
    if (t < 0.25) {
        const u = t / 0.25;
        return [Math.floor(60 + u * 80), Math.floor(130 + u * 50), Math.floor(50 + u * 10)];
    }
    if (t < 0.5) {
        const u = (t - 0.25) / 0.25;
        return [Math.floor(140 + u * 60), Math.floor(180 - u * 20), Math.floor(60 - u * 10)];
    }
    if (t < 0.75) {
        const u = (t - 0.5) / 0.25;
        return [Math.floor(200 - u * 20), Math.floor(160 - u * 40), Math.floor(50 + u * 40)];
    }
    const u = (t - 0.75) / 0.25;
    return [Math.floor(180 - u * 40), Math.floor(120 - u * 30), Math.floor(90 + u * 40)];
}

// Topo: soft pastel tints for each contour level
function topoLevelColor(level, maxElev, nLevels) {
    const t = level / maxElev;
    // Very soft tint: nearly white with slight coloring
    if (t < 0.3) {
        return [235, 245, 230]; // pale green
    } else if (t < 0.55) {
        return [245, 240, 220]; // pale yellow
    } else if (t < 0.75) {
        return [240, 230, 215]; // pale tan
    }
    return [235, 230, 225]; // pale gray
}

// Contour line color by altitude
function contourLineColor(level, maxElev) {
    const t = level / maxElev;
    if (t < 0.3) return 'rgba(50, 120, 50, 0.6)';
    if (t < 0.55) return 'rgba(120, 100, 40, 0.6)';
    if (t < 0.75) return 'rgba(140, 90, 50, 0.6)';
    return 'rgba(100, 80, 70, 0.6)';
}

// ===== API =====

async function generate() {
    const coastVal = coastSelect.value;
    const params = new URLSearchParams({
        seed: seedInput.value,
        scale: scaleSelect.value,
        terrain_type: reliefSelect.value,
        coast: coastVal !== 'false' ? 'true' : 'false',
        n_rivers: nRiversInput.value,
        lakes: lakesSelect.value,
    });

    if (coastVal !== 'false') {
        const dirMap = { north: 0, east: 1, south: 2, west: 3 };
        params.set('coast_direction', dirMap[coastVal] ?? 2);
    }

    statusEl.textContent = 'Generation en cours...';
    const t0 = performance.now();

    try {
        const resp = await fetch('/api/geology?' + params);
        if (!resp.ok) throw new Error('Erreur serveur: ' + resp.status);
        mapData = await resp.json();

        // Decode compact display_water (coast+lakes, no river pixels)
        const gs = mapData.scale.grid_size;
        const waterSource = mapData.display_water || mapData.water_mask;
        mapData._water = [];
        for (let y = 0; y < gs; y++) {
            const row = [];
            const s = (waterSource && waterSource[y]) || '';
            for (let x = 0; x < gs; x++) {
                row.push(s.charAt(x) === '1');
            }
            mapData._water.push(row);
        }

        // Decode compact biome raster (int[][] + legend -> string[][])
        const legend = mapData.biotopes.legend || [];
        mapData._biomes = [];
        for (let y = 0; y < gs; y++) {
            const row = [];
            for (let x = 0; x < gs; x++) {
                const idx = mapData.biotopes.raster[y][x];
                row.push(legend[idx] || 'meadow');
            }
            mapData._biomes.push(row);
        }

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        statusEl.textContent = `OK (${elapsed}s) — seed=${seedInput.value}, ${gs}x${gs}, ${mapData.scale.name}`;

        resizeCanvas();
        resetZoom();
        render();
    } catch (e) {
        statusEl.textContent = 'Erreur: ' + e.message;
        console.error(e);
    }
}

// ===== Rendering =====

function resizeCanvas() {
    if (!mapData) return;
    const size = mapData.scale.grid_size;
    const vr = viewer.getBoundingClientRect();
    const maxDim = Math.min(vr.width, vr.height) - 40;
    const ps = Math.max(1, Math.floor(maxDim / size));
    canvas.width = size * ps;
    canvas.height = size * ps;
    canvas._ps = ps;
    canvas._size = size;
}

function render() {
    if (!mapData) return;
    const size = canvas._size;
    const ps = canvas._ps;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Base layer
    if (viewMode === 'elevation') {
        drawElevationLayer(size, ps);
    } else if (viewMode === 'topo') {
        drawTopoLayer(size, ps);
    } else if (viewMode === 'biomes') {
        drawBiomesLayer(size, ps);
    }

    // Overlays
    if (layers.lakes.checked) drawLakes(size, ps);
    if (layers.coastline.checked) drawCoastline(size, ps);
    if (layers.rivers.checked) drawRivers(size, ps);
    if (layers.contours.checked) drawContourLines(size, ps);
    if (layers.biome_borders.checked) drawBiomeBorders(size, ps);

    applyTransform();
}

// ── Base Layers ──

function drawElevationLayer(size, ps) {
    const imgData = ctx.createImageData(size, size);
    const maxElev = mapData.elevation.max_m;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const v = mapData.elevation.raw[y][x];
            const w = mapData._water[y][x];
            const [r, g, b] = elevationColor(v, maxElev, w);
            const idx = (y * size + x) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    drawScaled(imgData, size, ps);
}

function drawTopoLayer(size, ps) {
    const imgData = ctx.createImageData(size, size);
    const maxElev = mapData.elevation.max_m;
    const nLevels = mapData.elevation.n_levels;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            if (mapData._water[y][x]) {
                imgData.data[idx] = 180;
                imgData.data[idx + 1] = 210;
                imgData.data[idx + 2] = 230;
                imgData.data[idx + 3] = 255;
                continue;
            }
            const v = mapData.elevation.quantized[y][x];
            const [r, g, b] = topoLevelColor(v, maxElev, nLevels);
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    drawScaled(imgData, size, ps);
}

function drawBiomesLayer(size, ps) {
    const imgData = ctx.createImageData(size, size);
    const raster = mapData._biomes;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const biome = raster[y][x];
            const [r, g, b] = BIOME_COLORS[biome] || [128, 128, 128];
            const idx = (y * size + x) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    drawScaled(imgData, size, ps);
}

function drawScaled(imgData, size, ps) {
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    off.getContext('2d').putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, size * ps, size * ps);
}

// ── Overlays ──

function drawContourLines(size, ps) {
    if (!mapData.contours || mapData.contours.length === 0) return;
    const maxElev = mapData.elevation.max_m;
    const interval = mapData.elevation.contour_interval_m;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const contour of mapData.contours) {
        const pts = contour.points;
        if (!pts || pts.length < 2) continue;

        // Major contour every 5 intervals
        const levelIdx = Math.round(contour.level_m / interval);
        const isMajor = levelIdx % 5 === 0;

        ctx.strokeStyle = viewMode === 'topo'
            ? contourLineColor(contour.level_m, maxElev)
            : 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = isMajor ? Math.max(1.5, ps * 0.15) : Math.max(0.5, ps * 0.06);

        ctx.beginPath();
        ctx.moveTo(pts[0][0] * ps, pts[0][1] * ps);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * ps, pts[i][1] * ps);
        }
        if (contour.closed) ctx.closePath();
        ctx.stroke();
    }
    ctx.restore();
}

function drawRivers(size, ps) {
    if (!mapData.rivers || mapData.rivers.length === 0) return;
    const cellM = mapData.scale.cell_m;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const river of mapData.rivers) {
        const pts = river.centerline;
        const widths = river.widths;
        if (!pts || pts.length < 2) continue;

        // Draw river as filled polygon outline for smooth variable width
        // Build left and right bank polylines
        const n = pts.length;
        const leftBank = [];
        const rightBank = [];

        for (let i = 0; i < n; i++) {
            const w = (widths && widths[i] !== undefined) ? widths[i] : 10;
            const halfW = Math.max(0.5, (w / cellM) / 2) * ps;

            // Tangent direction
            let tx, ty;
            if (i === 0) {
                tx = pts[1][0] - pts[0][0];
                ty = pts[1][1] - pts[0][1];
            } else if (i === n - 1) {
                tx = pts[n-1][0] - pts[n-2][0];
                ty = pts[n-1][1] - pts[n-2][1];
            } else {
                tx = pts[i+1][0] - pts[i-1][0];
                ty = pts[i+1][1] - pts[i-1][1];
            }
            const len = Math.sqrt(tx*tx + ty*ty) || 1;
            // Normal (perpendicular to tangent)
            const nx = -ty / len;
            const ny = tx / len;

            leftBank.push([
                (pts[i][0] + nx * halfW / ps) * ps,
                (pts[i][1] + ny * halfW / ps) * ps,
            ]);
            rightBank.push([
                (pts[i][0] - nx * halfW / ps) * ps,
                (pts[i][1] - ny * halfW / ps) * ps,
            ]);
        }

        // Fill the river polygon (left bank forward, right bank reversed)
        ctx.fillStyle = 'rgba(30, 90, 180, 0.85)';
        ctx.beginPath();
        ctx.moveTo(leftBank[0][0], leftBank[0][1]);
        for (let i = 1; i < leftBank.length; i++) {
            ctx.lineTo(leftBank[i][0], leftBank[i][1]);
        }
        for (let i = rightBank.length - 1; i >= 0; i--) {
            ctx.lineTo(rightBank[i][0], rightBank[i][1]);
        }
        ctx.closePath();
        ctx.fill();

        // Stroke the centerline with a thin dark line for definition
        ctx.strokeStyle = 'rgba(20, 60, 140, 0.3)';
        ctx.lineWidth = Math.max(0.5, ps * 0.04);
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * ps, pts[0][1] * ps);
        for (let i = 1; i < n; i++) {
            ctx.lineTo(pts[i][0] * ps, pts[i][1] * ps);
        }
        ctx.stroke();
    }
    ctx.restore();
}

function drawLakes(size, ps) {
    if (!mapData.lakes || mapData.lakes.length === 0) return;

    ctx.save();
    ctx.fillStyle = 'rgba(41, 128, 185, 0.7)';
    ctx.strokeStyle = 'rgba(30, 90, 160, 0.8)';
    ctx.lineWidth = Math.max(1, ps * 0.1);

    for (const lake of mapData.lakes) {
        const boundary = lake.boundary;
        if (!boundary || boundary.length < 3) continue;

        ctx.beginPath();
        ctx.moveTo(boundary[0][0] * ps, boundary[0][1] * ps);
        for (let i = 1; i < boundary.length; i++) {
            ctx.lineTo(boundary[i][0] * ps, boundary[i][1] * ps);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}

function drawCoastline(size, ps) {
    if (!mapData.coastline || !mapData.coastline.points) return;
    const pts = mapData.coastline.points;
    if (pts.length < 2) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(40, 70, 120, 0.8)';
    ctx.lineWidth = Math.max(1.5, ps * 0.15);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0][0] * ps, pts[0][1] * ps);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] * ps, pts[i][1] * ps);
    }
    ctx.stroke();

    // Draw river mouth markers
    if (mapData.coastline.river_mouths) {
        ctx.fillStyle = 'rgba(30, 90, 180, 0.9)';
        for (const [mx, my] of mapData.coastline.river_mouths) {
            ctx.beginPath();
            ctx.arc(mx * ps, my * ps, Math.max(3, ps * 0.4), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.restore();
}

function drawBiomeBorders(size, ps) {
    if (!mapData.biotopes || !mapData.biotopes.regions) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(80, 60, 40, 0.3)';
    ctx.lineWidth = Math.max(0.5, ps * 0.06);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const region of mapData.biotopes.regions) {
        const pts = region.boundary;
        if (!pts || pts.length < 3) continue;

        ctx.beginPath();
        ctx.moveTo(pts[0][0] * ps, pts[0][1] * ps);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * ps, pts[i][1] * ps);
        }
        ctx.closePath();
        ctx.stroke();
    }
    ctx.restore();
}

// ===== Zoom / Pan =====

function applyTransform() {
    canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    canvas.style.transformOrigin = '0 0';
}

function resetZoom() {
    scale = 1;
    const vr = viewer.getBoundingClientRect();
    translateX = (vr.width - canvas.width) / 2;
    translateY = (vr.height - canvas.height) / 2;
    applyTransform();
}

viewer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = viewer.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx - translateX) / scale;
    const wy = (my - translateY) / scale;
    scale *= zoomFactor;
    scale = Math.max(0.1, Math.min(20, scale));
    translateX = mx - wx * scale;
    translateY = my - wy * scale;
    applyTransform();
}, { passive: false });

viewer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartTX = translateX;
    panStartTY = translateY;
    viewer.classList.add('grabbing');
});

window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    translateX = panStartTX + (e.clientX - panStartX);
    translateY = panStartTY + (e.clientY - panStartY);
    applyTransform();
});

window.addEventListener('mouseup', () => {
    isPanning = false;
    viewer.classList.remove('grabbing');
});

// ===== Events =====

document.getElementById('generate').addEventListener('click', generate);

document.getElementById('random').addEventListener('click', () => {
    seedInput.value = Math.floor(Math.random() * 999999) + 1;
    generate();
});

document.getElementById('reset-zoom').addEventListener('click', resetZoom);

window.addEventListener('resize', () => {
    resizeCanvas();
    render();
});
