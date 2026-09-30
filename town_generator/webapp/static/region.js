// ===== Region Editor — M2 (City Site + Landmarks + Satellites) =====

const canvas = document.getElementById('region-canvas');
const ctx = canvas.getContext('2d');
const viewer = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const infoPanel = document.getElementById('city-info');

// Controls
const seedInput = document.getElementById('seed');
const sizeSelect = document.getElementById('size');
const mapExtentSelect = document.getElementById('map_extent');
const noiseScaleInput = document.getElementById('noise_scale');
const riverCountInput = document.getElementById('river_count');
const riverWidthInput = document.getElementById('river_width');
const coastSelect = document.getElementById('coast');
const coastDirSelect = document.getElementById('coast_direction');
const populationInput = document.getElementById('population');
const cityRadiusMInput = document.getElementById('city_radius_m');
const nSatellitesInput = document.getElementById('n_satellites');
const styleSelect = document.getElementById('style');
const buildRoadsCheck = document.getElementById('build_roads');

// Display elements
const noiseScaleVal = document.getElementById('noise_scale_val');
const riverWidthVal = document.getElementById('river_width_val');
const populationVal = document.getElementById('population_val');
const cityRadiusVal = document.getElementById('city_radius_val');
const cellSizeDisplay = document.getElementById('cell_size_display');
const derivedRadius = document.getElementById('derived_radius');
const derivedCells = document.getElementById('derived_cells');
const derivedPct = document.getElementById('derived_pct');

noiseScaleInput.addEventListener('input', () => { noiseScaleVal.textContent = parseFloat(noiseScaleInput.value).toFixed(1); });
riverWidthInput.addEventListener('input', () => { riverWidthVal.textContent = riverWidthInput.value + ' m'; });
populationInput.addEventListener('input', () => {
    populationVal.textContent = parseInt(populationInput.value).toLocaleString();
    updateDerivedInfo();
});
cityRadiusMInput.addEventListener('input', () => {
    const v = parseInt(cityRadiusMInput.value);
    cityRadiusVal.textContent = v === 0 ? '0 (auto)' : v + ' m';
    updateDerivedInfo();
});

function updateCellSize() {
    const extent = parseFloat(mapExtentSelect.value);
    const gridSize = parseInt(sizeSelect.value);
    cellSizeDisplay.textContent = (extent / gridSize).toFixed(1);
    updateDerivedInfo();
}

function updateDerivedInfo() {
    const pop = parseInt(populationInput.value);
    const overrideM = parseInt(cityRadiusMInput.value);
    const extent = parseFloat(mapExtentSelect.value);
    const gridSize = parseInt(sizeSelect.value);
    const cellSizeM = extent / gridSize;

    // radius_m = sqrt(population / (150 * pi)) * 100
    let radiusM = overrideM > 0 ? overrideM : Math.sqrt(pop / (150 * Math.PI)) * 100;
    let cells = Math.max(5, Math.round(radiusM / cellSizeM));
    let pct = Math.round(cells * 2 / gridSize * 100);

    derivedRadius.textContent = Math.round(radiusM);
    derivedCells.textContent = cells;
    derivedPct.textContent = pct;
}

mapExtentSelect.addEventListener('change', updateCellSize);
sizeSelect.addEventListener('change', updateCellSize);
updateCellSize();

// State
let regionData = null;
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
    water: document.getElementById('layer_water'),
    heatmap: document.getElementById('layer_heatmap'),
    city: document.getElementById('layer_city'),
    landmarks: document.getElementById('layer_landmarks'),
    satellites: document.getElementById('layer_satellites'),
    roads: document.getElementById('layer_roads'),
    labels: document.getElementById('layer_labels'),
};

Object.values(layers).forEach(cb => cb.addEventListener('change', render));

// ===== Color Maps =====

const COVER_COLORS = {
    water:    [41, 128, 185],
    meadow:   [160, 200, 110],
    forest:   [40, 100, 40],
    swamp:    [70, 110, 75],
    farmland: [200, 190, 100],
    scrub:    [140, 145, 90],
};

const LANDMARK_ICONS = {
    castle:  { color: '#ff4444', symbol: '\u25B2' },
    docks:   { color: '#4488ff', symbol: '\u2693' },
    mill:    { color: '#88aa44', symbol: '\u2699' },
    citadel: { color: '#ff8844', symbol: '\u25C6' },
    market:  { color: '#ffcc44', symbol: '\u25CF' },
};

function elevationColor(elev, isWater) {
    if (isWater) {
        const d = Math.max(0, elev);
        return [
            Math.floor(20 + d * 60),
            Math.floor(50 + d * 100),
            Math.floor(100 + d * 120),
        ];
    }
    const t = Math.max(0, Math.min(1, elev));
    if (t < 0.4) {
        const u = t / 0.4;
        return [Math.floor(80 + u * 80), Math.floor(140 + u * 50), 60];
    }
    if (t < 0.65) {
        const u = (t - 0.4) / 0.25;
        return [Math.floor(160 + u * 40), Math.floor(190 - u * 40), Math.floor(60 - u * 10)];
    }
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
        octaves: '4',
        persistence: '0.5',
        coast: coastSelect.value,
        coast_direction: coastDirSelect.value,
        sea_level: '0.15',
        river_count: riverCountInput.value,
        river_width_m: riverWidthInput.value,
        population: populationInput.value,
        city_radius_m: cityRadiusMInput.value,
        n_satellites: nSatellitesInput.value,
        style: styleSelect.value,
        build_roads: buildRoadsCheck.checked,
    });

    statusEl.textContent = 'Generating...';
    const t0 = performance.now();

    try {
        const resp = await fetch('/api/region?' + params);
        if (!resp.ok) throw new Error('Server error: ' + resp.status);
        regionData = await resp.json();

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const nL = regionData.landmarks.length;
        const nS = regionData.satellites.length;
        const rM = regionData.city_radius_m ? Math.round(regionData.city_radius_m) + 'm' : '?';
        statusEl.textContent = `Done (${elapsed}s) — radius ${rM}, ${nL} landmarks, ${nS} satellites`;

        // Update scale bar
        const scaleCellM = document.getElementById('scale_cell_m');
        if (scaleCellM && regionData.terrain) {
            const extent = parseFloat(mapExtentSelect.value);
            const gridSize = parseInt(sizeSelect.value);
            scaleCellM.textContent = (extent / gridSize).toFixed(1);
        }

        showCityInfo();
        resizeCanvas();
        resetZoom();
        render();
    } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
    }
}

function showCityInfo() {
    if (!regionData || !regionData.city) return;
    const c = regionData.city;
    infoPanel.style.display = 'block';
    document.getElementById('info-pos').textContent = `(${c.x}, ${c.y})`;
    document.getElementById('info-score').textContent = c.score.toFixed(3);
    document.getElementById('info-spec').textContent = c.specialization;
    document.getElementById('info-harbor').textContent = c.features.has_harbor ? 'Yes' : 'No';

    // Update derived info from server response
    if (regionData.city_radius_m) {
        derivedRadius.textContent = Math.round(regionData.city_radius_m);
        derivedCells.textContent = regionData.city_radius_cells;
        const gridSize = parseInt(sizeSelect.value);
        derivedPct.textContent = Math.round(regionData.city_radius_cells * 2 / gridSize * 100);
    }

    const landmarkEl = document.getElementById('info-landmarks');
    landmarkEl.innerHTML = regionData.landmarks
        .map(l => `${l.type} (${l.x}, ${l.y})`)
        .join('<br>');
}

// ===== Rendering =====

function resizeCanvas() {
    if (!regionData) return;
    const size = regionData.world_map_size;
    const viewerRect = viewer.getBoundingClientRect();
    const maxDim = Math.min(viewerRect.width, viewerRect.height) - 40;
    const pixelSize = Math.max(1, Math.floor(maxDim / size));
    canvas.width = size * pixelSize;
    canvas.height = size * pixelSize;
    canvas._pixelSize = pixelSize;
}

function render() {
    if (!regionData) return;
    const size = regionData.world_map_size;
    const ps = canvas._pixelSize || 1;
    const terrain = regionData.terrain;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    if (layers.ground_cover.checked) {
        drawGroundCoverLayer(terrain, size, ps);
    } else if (layers.elevation.checked) {
        drawElevationLayer(terrain, size, ps);
    }

    if (layers.water.checked) drawWater(terrain, size, ps);
    if (layers.heatmap.checked) drawHeatmap(size, ps);
    if (layers.roads.checked) drawRoads(size, ps);
    if (layers.city.checked) drawCity(size, ps);
    if (layers.landmarks.checked) drawLandmarks(size, ps);
    if (layers.satellites.checked) drawSatellites(size, ps);
    if (layers.labels.checked) drawLabels(size, ps);

    applyTransform();
}

function drawElevationLayer(terrain, size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const v = terrain.elevation[y][x];
            const w = terrain.water[y][x];
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

function drawGroundCoverLayer(terrain, size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const gc = terrain.ground_cover[y][x];
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

function drawWater(terrain, size, ps) {
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            if (terrain.water[y][x]) {
                const d = terrain.elevation[y][x];
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

function drawHeatmap(size, ps) {
    if (!regionData.score_map) return;
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const s = regionData.score_map[y][x];
            const idx = (y * size + x) * 4;
            if (s > 0) {
                if (s < 0.5) {
                    imgData.data[idx] = Math.floor(s * 2 * 255);
                    imgData.data[idx + 1] = 200;
                } else {
                    imgData.data[idx] = 255;
                    imgData.data[idx + 1] = Math.floor((1 - s) * 2 * 200);
                }
                imgData.data[idx + 2] = 0;
                imgData.data[idx + 3] = Math.floor(s * 150);
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

function drawCity(size, ps) {
    const c = regionData.city;
    if (!c) return;
    const cx = c.x * ps + ps / 2;
    const cy = c.y * ps + ps / 2;
    const r = (regionData.city_radius_cells || 15) * ps;

    ctx.save();

    // City radius circle
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // City center marker
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(cx - 1.5, cy - 1.5, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawLandmarks(size, ps) {
    if (!regionData.landmarks) return;
    ctx.save();

    for (const lm of regionData.landmarks) {
        const lx = lm.x * ps + ps / 2;
        const ly = lm.y * ps + ps / 2;
        const icon = LANDMARK_ICONS[lm.type] || { color: '#ffffff', symbol: '?' };
        const fontSize = Math.max(12, ps * 2);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.beginPath();
        ctx.arc(lx, ly, fontSize * 0.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = icon.color;
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon.symbol, lx, ly);
    }

    ctx.restore();
}

function drawSatellites(size, ps) {
    if (!regionData.satellites || regionData.satellites.length === 0) return;
    ctx.save();

    for (const sat of regionData.satellites) {
        const sx = sat.x * ps + ps / 2;
        const sy = sat.y * ps + ps / 2;
        const r = (sat.type === 'village' ? 4 : 3) * ps / 2;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.beginPath();
        ctx.arc(sx, sy, r + 1, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = sat.type === 'village' ? '#88cc44' : '#88aacc';
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

function drawRoads(size, ps) {
    if (!regionData.roads) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const road of regionData.roads) {
        const pts = road.path;
        if (!pts || pts.length < 2) continue;

        // Outline
        ctx.strokeStyle = 'rgba(40, 30, 20, 0.4)';
        ctx.lineWidth = 2.5 * ps / 2;
        ctx.setLineDash([4 * ps / 2, 3 * ps / 2]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * ps + ps / 2, pts[0][1] * ps + ps / 2);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * ps + ps / 2, pts[i][1] * ps + ps / 2);
        }
        ctx.stroke();

        // Fill
        ctx.strokeStyle = '#8a7a60';
        ctx.lineWidth = 1.5 * ps / 2;
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * ps + ps / 2, pts[0][1] * ps + ps / 2);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * ps + ps / 2, pts[i][1] * ps + ps / 2);
        }
        ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.restore();
}

function drawLabels(size, ps) {
    const c = regionData.city;
    if (!c) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // City label
    const cx = c.x * ps + ps / 2;
    const cy = c.y * ps + ps / 2;
    const fontSize = Math.max(12, ps * 2);

    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillText('City', cx + 1, cy + 9);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('City', cx, cy + 8);

    const subFont = Math.max(9, ps * 1.3);
    ctx.font = `${subFont}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(200, 200, 200, 0.8)';
    ctx.fillText(c.specialization, cx, cy + 8 + fontSize + 2);

    // Landmark labels
    if (layers.landmarks.checked && regionData.landmarks) {
        ctx.font = `${Math.max(9, ps * 1.2)}px system-ui, sans-serif`;
        for (const lm of regionData.landmarks) {
            if (lm.type === 'market') continue;
            const lx = lm.x * ps + ps / 2;
            const ly = lm.y * ps + ps / 2;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillText(lm.type, lx + 1, ly + ps + 1);
            ctx.fillStyle = '#ddd';
            ctx.fillText(lm.type, lx, ly + ps);
        }
    }

    // Satellite labels
    if (layers.satellites.checked && regionData.satellites) {
        ctx.font = `${Math.max(8, ps * 1.0)}px system-ui, sans-serif`;
        for (const sat of regionData.satellites) {
            const sx = sat.x * ps + ps / 2;
            const sy = sat.y * ps + ps / 2;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillText(sat.type, sx + 1, sy + ps * 0.8 + 1);
            ctx.fillStyle = '#ccc';
            ctx.fillText(sat.type, sx, sy + ps * 0.8);
        }
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
