// ===== Terrain Editor — M1 (City Scale) =====

const canvas = document.getElementById('terrain-canvas');
const ctx = canvas.getContext('2d');
const viewer = document.getElementById('viewer');
const statusEl = document.getElementById('status');

// Controls
const seedInput = document.getElementById('seed');
const sizeSelect = document.getElementById('size');
const noiseScaleInput = document.getElementById('noise_scale');
const octavesInput = document.getElementById('octaves');
const persistenceInput = document.getElementById('persistence');
const coastSelect = document.getElementById('coast');
const coastDirSelect = document.getElementById('coast_direction');
const seaLevelInput = document.getElementById('sea_level');
const riverCountInput = document.getElementById('river_count');
const riverWidthInput = document.getElementById('river_width');
const mapExtentSelect = document.getElementById('map_extent');
const cellSizeDisplay = document.getElementById('cell_size_display');

// Slider value displays
const noiseScaleVal = document.getElementById('noise_scale_val');
const seaLevelVal = document.getElementById('sea_level_val');
const riverWidthVal = document.getElementById('river_width_val');

noiseScaleInput.addEventListener('input', () => { noiseScaleVal.textContent = parseFloat(noiseScaleInput.value).toFixed(1); });
seaLevelInput.addEventListener('input', () => { seaLevelVal.textContent = parseFloat(seaLevelInput.value).toFixed(2); });
riverWidthInput.addEventListener('input', () => { riverWidthVal.textContent = riverWidthInput.value + ' m'; });

function updateCellSize() {
    const extent = parseFloat(mapExtentSelect.value);
    const gridSize = parseInt(sizeSelect.value);
    cellSizeDisplay.textContent = (extent / gridSize).toFixed(1);
}
mapExtentSelect.addEventListener('change', updateCellSize);
sizeSelect.addEventListener('change', updateCellSize);
updateCellSize();

// State
let worldData = null;
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartTX = 0, panStartTY = 0;

// Layer toggles
const layers = {
    elevation: document.getElementById('layer_elevation'),
    ground_cover: document.getElementById('layer_ground_cover'),
    terrain_type: document.getElementById('layer_terrain_type'),
    water: document.getElementById('layer_water'),
    rivers: document.getElementById('layer_rivers'),
    coastline: document.getElementById('layer_coastline'),
};

Object.values(layers).forEach(cb => cb.addEventListener('change', render));

// ===== Color Maps =====

const TERRAIN_COLORS = {
    water:   [41, 128, 185],
    wetland: [87, 132, 100],
    flat:    [160, 190, 120],
    slope:   [170, 155, 110],
    hill:    [140, 130, 100],
};

const COVER_COLORS = {
    water:    [41, 128, 185],
    meadow:   [160, 200, 110],
    forest:   [40, 100, 40],
    swamp:    [70, 110, 75],
    farmland: [200, 190, 100],
    scrub:    [140, 145, 90],
};

function elevationColor(elev, isWater) {
    if (isWater) {
        // Water: dark blue to lighter blue by depth
        const d = Math.max(0, elev);
        return [
            Math.floor(20 + d * 60),
            Math.floor(50 + d * 100),
            Math.floor(100 + d * 120),
        ];
    }
    // Land: green lowlands to brown hills
    const t = Math.max(0, Math.min(1, elev));
    if (t < 0.4) {
        const u = t / 0.4;
        return [Math.floor(80 + u * 80), Math.floor(140 + u * 50), Math.floor(60)];
    }
    if (t < 0.65) {
        const u = (t - 0.4) / 0.25;
        return [Math.floor(160 + u * 40), Math.floor(190 - u * 40), Math.floor(60 - u * 10)];
    }
    // High ground
    const u = (t - 0.65) / 0.35;
    return [Math.floor(200 - u * 30), Math.floor(150 - u * 30), Math.floor(50 + u * 60)];
}

// ===== API =====

async function generate() {
    const params = new URLSearchParams({
        seed: seedInput.value,
        size: sizeSelect.value,
        map_extent_m: mapExtentSelect.value,
        noise_scale: noiseScaleInput.value,
        octaves: octavesInput.value,
        persistence: persistenceInput.value,
        coast: coastSelect.value,
        coast_direction: coastDirSelect.value,
        sea_level: seaLevelInput.value,
        river_count: riverCountInput.value,
        river_width_m: riverWidthInput.value,
    });

    statusEl.textContent = 'Generating...';
    const t0 = performance.now();

    try {
        const resp = await fetch('/api/terrain?' + params);
        if (!resp.ok) throw new Error('Server error: ' + resp.status);
        worldData = await resp.json();

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        statusEl.textContent = `Done (${elapsed}s) — seed=${seedInput.value}, ${sizeSelect.value}x${sizeSelect.value}`;

        resizeCanvas();
        resetZoom();
        render();
    } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
    }
}

// ===== Rendering =====

function resizeCanvas() {
    if (!worldData) return;
    const size = worldData.size[0];
    const viewerRect = viewer.getBoundingClientRect();
    const maxDim = Math.min(viewerRect.width, viewerRect.height) - 40;
    const pixelSize = Math.max(1, Math.floor(maxDim / size));
    canvas.width = size * pixelSize;
    canvas.height = size * pixelSize;
    canvas._pixelSize = pixelSize;
}

function render() {
    if (!worldData) return;
    const size = worldData.size[0];
    const ps = canvas._pixelSize || 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Base layer
    if (layers.ground_cover.checked) {
        drawGroundCoverLayer(size, ps);
    } else if (layers.terrain_type.checked) {
        drawTerrainTypeLayer(size, ps);
    } else if (layers.elevation.checked) {
        drawElevationLayer(size, ps);
    }

    // Overlays
    if (layers.water.checked) drawWater(size, ps);
    if (layers.rivers.checked) drawRivers(size, ps);
    if (layers.coastline.checked) drawCoastline(size, ps);

    applyTransform();
}

function drawElevationLayer(size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const v = worldData.elevation[y][x];
            const w = worldData.water[y][x];
            const [r, g, b] = elevationColor(v, w);
            const idx = (y * size + x) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    drawScaledImageData(imgData, size, ps);
}

function drawTerrainTypeLayer(size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const t = worldData.terrain[y][x];
            const [r, g, b] = TERRAIN_COLORS[t] || [128, 128, 128];
            const idx = (y * size + x) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    drawScaledImageData(imgData, size, ps);
}

function drawGroundCoverLayer(size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const gc = worldData.ground_cover[y][x];
            const [r, g, b] = COVER_COLORS[gc] || [128, 128, 128];
            const idx = (y * size + x) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    drawScaledImageData(imgData, size, ps);
}

function drawWater(size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            if (worldData.water[y][x]) {
                const d = worldData.elevation[y][x];
                imgData.data[idx] = Math.floor(20 + d * 40);
                imgData.data[idx + 1] = Math.floor(60 + d * 80);
                imgData.data[idx + 2] = Math.floor(120 + d * 80);
                imgData.data[idx + 3] = 200;
            } else {
                imgData.data[idx + 3] = 0;
            }
        }
    }
    drawScaledImageData(imgData, size, ps);
}

function drawScaledImageData(imgData, size, ps) {
    const offscreen = document.createElement('canvas');
    offscreen.width = size;
    offscreen.height = size;
    offscreen.getContext('2d').putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreen, 0, 0, size * ps, size * ps);
}

function drawRivers(size, ps) {
    if (!worldData.rivers || worldData.rivers.length === 0) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(30, 90, 160, 0.7)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const river of worldData.rivers) {
        const pts = river.centerline;
        if (pts.length < 2) continue;
        ctx.lineWidth = Math.max(1, (river.width || 8) * ps / 2);
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * ps + ps / 2, pts[0][1] * ps + ps / 2);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * ps + ps / 2, pts[i][1] * ps + ps / 2);
        }
        ctx.stroke();
    }
    ctx.restore();
}

function drawCoastline(size, ps) {
    if (!worldData.coastline || worldData.coastline.length === 0) return;
    // Draw land/water boundary cells
    ctx.fillStyle = 'rgba(220, 200, 150, 0.4)';
    for (const [x, y] of worldData.coastline) {
        ctx.fillRect(x * ps, y * ps, ps, ps);
    }
}

// ===== Zoom / Pan =====

function applyTransform() {
    canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    canvas.style.transformOrigin = '0 0';
}

function resetZoom() {
    scale = 1;
    translateX = 0;
    translateY = 0;
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

// ===== Event Bindings =====

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
