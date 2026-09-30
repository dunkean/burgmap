// M4 District Population Editor — Canvas 2D renderer + controls

// --- State ---
let districtData = null;      // API response (buildings, alleys, polygon, params)
let customPolygon = null;     // User-supplied polygon [[x,y],...] or null for preset
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let panStartX = 0, panStartY = 0, panStartTX = 0, panStartTY = 0;
let hoveredBuilding = null;
let selectedBuilding = null;
let populatorList = [];

// --- DOM refs ---
const canvas = document.getElementById('canvas-main');
const ctx = canvas.getContext('2d');
const canvasArea = document.getElementById('canvas-area');
const tooltip = document.getElementById('tooltip');
const statusBar = document.getElementById('status-bar');

// --- Colors ---
const PAPER_COLOR = '#CCC5B8';
const BOUNDARY_STROKE = '#C53030';
const BUILDING_COLORS = {
    house:          { fill: '#B8A888', stroke: '#4A3C28' },
    insula:         { fill: '#C8B898', stroke: '#5A4C38' },
    shop:           { fill: '#D4A870', stroke: '#6A5030' },
    stall:          { fill: '#D4A870', stroke: '#6A5030' },
    ger:            { fill: '#D8C8A0', stroke: '#6A5A30' },
    chapel:         { fill: '#B8860B', stroke: '#6B4C0A' },
    refectory:      { fill: '#C0A868', stroke: '#5A4828' },
    dormitory:      { fill: '#B8A080', stroke: '#5A4838' },
    chapter_house:  { fill: '#A89870', stroke: '#585040' },
    tower:          { fill: '#8B7355', stroke: '#4A3C28' },
    farmhouse:      { fill: '#C8B090', stroke: '#6A5838' },
    field:          { fill: '#A8C880', stroke: '#5A7838' },
    barracks:       { fill: '#A0A088', stroke: '#585848' },
    headquarters:   { fill: '#909078', stroke: '#484838' },
    armory:         { fill: '#888878', stroke: '#484838' },
    great_hall:     { fill: '#D4C4A0', stroke: '#6A5A38' },
    wing:           { fill: '#C8B898', stroke: '#5A4C38' },
    gatehouse:      { fill: '#A89878', stroke: '#585040' },
    outbuilding:    { fill: '#B8B098', stroke: '#585848' },
};
const DEFAULT_BLDG = { fill: '#B8A888', stroke: '#4A3C28' };
const ALLEY_COLOR = '#8AB08044';
const ALLEY_STROKE = '#5A7A50';

// --- Layer visibility ---
function isLayerOn(id) {
    const el = document.getElementById(id);
    return el && el.checked;
}

// --- Resize canvas ---
function resizeCanvas() {
    const rect = canvasArea.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    render();
}

// --- Transform helpers ---
function worldToScreen(x, y) {
    return [x * scale + translateX, y * scale + translateY];
}
function screenToWorld(sx, sy) {
    return [(sx - translateX) / scale, (sy - translateY) / scale];
}

// --- Fit view ---
function fitView() {
    if (!districtData || !districtData.polygon) return;
    const pts = districtData.polygon;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const padding = 50;
    const pw = maxX - minX || 1;
    const ph = maxY - minY || 1;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = canvas.width;
    const h = canvas.height;
    scale = Math.min((w - padding * 2) / pw, (h - padding * 2) / ph);
    translateX = w / 2 - cx * scale;
    translateY = h / 2 - cy * scale;
}

// --- Main render ---
function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!districtData) {
        ctx.fillStyle = '#555';
        ctx.font = '16px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Click Generate to populate a district', canvas.width / 2, canvas.height / 2);
        return;
    }

    ctx.save();
    ctx.translate(translateX, translateY);
    ctx.scale(scale, scale);

    // Background paper around polygon
    const pts = districtData.polygon;
    if (pts && pts.length > 2) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of pts) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const pad = Math.max(maxX - minX, maxY - minY) * 0.3;
        ctx.fillStyle = PAPER_COLOR;
        ctx.fillRect(minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2);
    }

    // District boundary
    if (isLayerOn('layer-boundary')) {
        drawBoundary();
    }

    // Alleys / courtyards
    if (isLayerOn('layer-alleys')) {
        drawAlleys();
    }

    // Buildings
    if (isLayerOn('layer-buildings')) {
        drawBuildings();
    }

    // Labels
    if (isLayerOn('layer-labels')) {
        drawLabels();
    }

    // Debug
    if (isLayerOn('layer-debug')) {
        drawDebug();
    }

    ctx.restore();
}

// --- Drawing ---

function drawPolygon(pts, fillColor, strokeColor, lineWidth) {
    if (!pts || pts.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
    if (strokeColor) { ctx.strokeStyle = strokeColor; ctx.lineWidth = lineWidth || 0.3; ctx.stroke(); }
}

function drawBoundary() {
    const pts = districtData.polygon;
    if (!pts) return;
    // Fill with light color
    drawPolygon(pts, '#E8E0D4', BOUNDARY_STROKE, 0.8);
    // Vertices
    ctx.fillStyle = BOUNDARY_STROKE;
    for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, 0.8, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawAlleys() {
    for (const alley of (districtData.alleys || [])) {
        const pts = alley.points || alley;
        if (pts && pts.length >= 3) {
            drawPolygon(pts, ALLEY_COLOR, ALLEY_STROKE, 0.3);
        }
    }
}

function drawBuildings() {
    for (const bldg of (districtData.buildings || [])) {
        const colors = BUILDING_COLORS[bldg.type] || DEFAULT_BLDG;
        const isHovered = hoveredBuilding && hoveredBuilding.id === bldg.id;
        const isSelected = selectedBuilding && selectedBuilding.id === bldg.id;

        let fill = colors.fill;
        if (isSelected) fill = '#FFD700';
        else if (isHovered) fill = lighten(colors.fill, 25);

        drawPolygon(bldg.footprint, fill, colors.stroke, isSelected ? 0.8 : 0.3);
    }
}

function drawLabels() {
    const fontSize = Math.max(1.5, 3 / scale * (scale > 2 ? 1 : 0.7));
    ctx.font = `${fontSize}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const bldg of (districtData.buildings || [])) {
        const fp = bldg.footprint;
        if (!fp || fp.length < 3) continue;
        let cx = 0, cy = 0;
        for (const [x, y] of fp) { cx += x; cy += y; }
        cx /= fp.length;
        cy /= fp.length;

        ctx.fillStyle = '#000';
        ctx.globalAlpha = 0.5;
        let label = bldg.type;
        if (bldg.sub_type) label = bldg.sub_type;
        ctx.fillText(label, cx, cy);
        ctx.globalAlpha = 1;
    }
}

function drawDebug() {
    const fontSize = Math.max(1, 2 / scale * (scale > 2 ? 1 : 0.7));
    ctx.font = `${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const bldg of (districtData.buildings || [])) {
        const fp = bldg.footprint;
        if (!fp || fp.length < 3) continue;
        let cx = 0, cy = 0;
        for (const [x, y] of fp) { cx += x; cy += y; }
        cx /= fp.length;
        cy /= fp.length;

        // Area
        let area = 0;
        for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
            area += (fp[j][0] * fp[i][1] - fp[i][0] * fp[j][1]);
        }
        area = Math.abs(area / 2);

        ctx.fillStyle = '#C53030';
        ctx.fillText(`${bldg.id} (${area.toFixed(0)})`, cx, cy + fontSize + 0.5);
    }
}

// --- Color helpers ---
function lighten(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return '#' +
        Math.min(255, r + amount).toString(16).padStart(2, '0') +
        Math.min(255, g + amount).toString(16).padStart(2, '0') +
        Math.min(255, b + amount).toString(16).padStart(2, '0');
}

// --- Hit testing ---
function findBuildingAt(wx, wy) {
    if (!districtData || !districtData.buildings) return null;
    for (let i = districtData.buildings.length - 1; i >= 0; i--) {
        const bldg = districtData.buildings[i];
        if (pointInPolygon(wx, wy, bldg.footprint)) return bldg;
    }
    return null;
}

function pointInPolygon(x, y, pts) {
    if (!pts || pts.length < 3) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1];
        const xj = pts[j][0], yj = pts[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// --- API call ---
async function generate() {
    const params = new URLSearchParams();

    const popSelect = document.getElementById('populator').value;
    if (popSelect !== 'auto') {
        params.set('populator', popSelect);
    }

    params.set('seed', document.getElementById('seed').value);
    params.set('min_area', document.getElementById('min-area').value);
    params.set('grid_chaos', document.getElementById('grid-chaos').value);
    params.set('size_chaos', document.getElementById('size-chaos').value);
    params.set('empty_prob', document.getElementById('empty-prob').value);
    params.set('density', document.getElementById('density').value);
    params.set('alley_width', document.getElementById('alley-width').value);
    params.set('district_type', document.getElementById('district-type').value);
    params.set('style', document.getElementById('style').value);

    if (customPolygon) {
        params.set('polygon', JSON.stringify(customPolygon));
    } else {
        params.set('preset', document.getElementById('preset').value);
    }

    statusBar.textContent = 'Generating...';
    const t0 = performance.now();
    try {
        const resp = await fetch(`/api/district?${params}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        districtData = await resp.json();
        const elapsed = Math.round(performance.now() - t0);
        const nBldg = (districtData.buildings || []).length;
        const nAlley = (districtData.alleys || []).length;
        statusBar.textContent = `Generated in ${elapsed}ms — ${nBldg} buildings, ${nAlley} alleys — populator: ${districtData.populator}`;
        selectedBuilding = null;
        hoveredBuilding = null;
        fitView();
        render();
    } catch (e) {
        statusBar.textContent = `Error: ${e.message}`;
    }
}

// --- Load available populators ---
async function loadPopulators() {
    try {
        const resp = await fetch('/api/district/populators');
        if (!resp.ok) return;
        populatorList = await resp.json();
        const select = document.getElementById('populator');
        for (const p of populatorList) {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = `${p.name} — ${p.description}`;
            select.appendChild(opt);
        }
    } catch (e) {
        // silently fail
    }
}

// --- Slider value displays ---
function setupSlider(id) {
    const slider = document.getElementById(id);
    const valSpan = document.getElementById(id + '-val');
    if (!slider || !valSpan) return;
    slider.addEventListener('input', () => {
        valSpan.textContent = parseFloat(slider.value).toFixed(
            slider.step && slider.step.includes('.') ? slider.step.split('.')[1].length : 0
        );
    });
}
['min-area', 'grid-chaos', 'size-chaos', 'density', 'empty-prob', 'alley-width'].forEach(setupSlider);

// --- Import polygon ---
function showImportPanel(mode) {
    document.getElementById('import-panel').style.display = 'block';
    document.getElementById('import-overlay').style.display = 'block';
    document.getElementById('citymap-district-picker').style.display = 'none';
    if (mode === 'citymap') {
        document.getElementById('import-text').placeholder = 'Paste CityMap JSON here...';
    } else {
        document.getElementById('import-text').placeholder = '[[0,0],[50,0],[50,40],[0,40]]';
    }
    document.getElementById('import-text').dataset.mode = mode || 'polygon';
}

function hideImportPanel() {
    document.getElementById('import-panel').style.display = 'none';
    document.getElementById('import-overlay').style.display = 'none';
}

document.getElementById('import-polygon-btn').addEventListener('click', () => showImportPanel('polygon'));
document.getElementById('import-citymap-btn').addEventListener('click', () => showImportPanel('citymap'));
document.getElementById('import-cancel').addEventListener('click', hideImportPanel);
document.getElementById('import-overlay').addEventListener('click', hideImportPanel);

document.getElementById('import-text').addEventListener('input', () => {
    const mode = document.getElementById('import-text').dataset.mode;
    if (mode !== 'citymap') return;

    try {
        const data = JSON.parse(document.getElementById('import-text').value);
        if (data.districts && Array.isArray(data.districts)) {
            const picker = document.getElementById('citymap-district-picker');
            const select = document.getElementById('pick-district');
            select.innerHTML = '';
            for (const d of data.districts) {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = `${d.id}: ${d.type}${d.landmark ? ' [' + d.landmark + ']' : ''}`;
                select.appendChild(opt);
            }
            picker.style.display = 'block';
        }
    } catch (e) {
        // Not valid JSON yet
    }
});

document.getElementById('import-apply').addEventListener('click', () => {
    const mode = document.getElementById('import-text').dataset.mode;
    const text = document.getElementById('import-text').value.trim();
    try {
        const data = JSON.parse(text);
        if (mode === 'citymap' && data.districts) {
            const distId = document.getElementById('pick-district').value;
            const dist = data.districts.find(d => d.id === distId);
            if (dist && dist.polygon) {
                customPolygon = dist.polygon;
                // Also set district type
                if (dist.type) {
                    document.getElementById('district-type').value = dist.type;
                }
                statusBar.textContent = `Imported district ${dist.id} (${dist.type}) from CityMap`;
            } else {
                statusBar.textContent = 'No valid district found';
                return;
            }
        } else if (Array.isArray(data)) {
            // Direct polygon array
            if (data.length >= 3 && Array.isArray(data[0])) {
                customPolygon = data;
                statusBar.textContent = `Imported polygon with ${data.length} vertices`;
            } else {
                statusBar.textContent = 'Invalid polygon format';
                return;
            }
        } else {
            statusBar.textContent = 'Unrecognized JSON format';
            return;
        }
    } catch (e) {
        statusBar.textContent = `JSON parse error: ${e.message}`;
        return;
    }
    hideImportPanel();
    generate();
});

// --- Event handlers ---

document.getElementById('generate').addEventListener('click', generate);

document.getElementById('random').addEventListener('click', () => {
    document.getElementById('seed').value = Math.floor(Math.random() * 999999) + 1;
    generate();
});

document.getElementById('reset-zoom').addEventListener('click', () => {
    fitView();
    render();
});

// Clear custom polygon when preset changes
document.getElementById('preset').addEventListener('change', () => {
    customPolygon = null;
});

// Zoom
canvasArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasArea.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = scale * factor;
    translateX = mx - (mx - translateX) * (newScale / scale);
    translateY = my - (my - translateY) * (newScale / scale);
    scale = newScale;
    render();
}, { passive: false });

// Pan
canvasArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartTX = translateX;
    panStartTY = translateY;
    canvasArea.classList.add('grabbing');
});

window.addEventListener('mousemove', (e) => {
    if (isPanning) {
        translateX = panStartTX + (e.clientX - panStartX);
        translateY = panStartTY + (e.clientY - panStartY);
        render();
        return;
    }

    // Hover detection
    if (!districtData) return;
    const rect = canvasArea.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(mx, my);
    const b = findBuildingAt(wx, wy);
    if (b !== hoveredBuilding) {
        hoveredBuilding = b;
        render();
        if (b) {
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX - canvasArea.getBoundingClientRect().left + 12) + 'px';
            tooltip.style.top = (e.clientY - canvasArea.getBoundingClientRect().top - 8) + 'px';
            let text = `${b.id}: ${b.type}`;
            if (b.sub_type) text += ` (${b.sub_type})`;
            if (b.stories) text += ` ${b.stories}F`;
            // Compute area
            let area = 0;
            for (let i = 0, j = b.footprint.length - 1; i < b.footprint.length; j = i++) {
                area += (b.footprint[j][0] * b.footprint[i][1] - b.footprint[i][0] * b.footprint[j][1]);
            }
            area = Math.abs(area / 2);
            text += ` — area: ${area.toFixed(1)}`;
            tooltip.textContent = text;
        } else {
            tooltip.style.display = 'none';
        }
    } else if (b) {
        tooltip.style.left = (e.clientX - canvasArea.getBoundingClientRect().left + 12) + 'px';
        tooltip.style.top = (e.clientY - canvasArea.getBoundingClientRect().top - 8) + 'px';
    }
});

window.addEventListener('mouseup', () => {
    if (isPanning) {
        isPanning = false;
        canvasArea.classList.remove('grabbing');
    }
});

// Click to select building
canvasArea.addEventListener('click', (e) => {
    if (!districtData) return;
    const rect = canvasArea.getBoundingClientRect();
    const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const b = findBuildingAt(wx, wy);
    selectedBuilding = (b && selectedBuilding && b.id === selectedBuilding.id) ? null : b;
    render();
    if (selectedBuilding) {
        const hints = selectedBuilding.style_hints || {};
        const hintsStr = Object.entries(hints).map(([k, v]) => `${k}=${v}`).join(', ');
        statusBar.textContent = `Selected: ${selectedBuilding.id} — ${selectedBuilding.type}` +
            (selectedBuilding.sub_type ? ` (${selectedBuilding.sub_type})` : '') +
            ` — ${selectedBuilding.stories || 1} stories` +
            (hintsStr ? ` — ${hintsStr}` : '');
    }
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'Escape') {
        selectedBuilding = null;
        render();
    }
    if (e.key === 'g' || e.key === 'G') generate();
    if (e.key === ' ') { e.preventDefault(); fitView(); render(); }
    if (e.key === 'l' || e.key === 'L') {
        const cb = document.getElementById('layer-labels');
        cb.checked = !cb.checked;
        render();
    }
    if (e.key === 'd' || e.key === 'D') {
        const cb = document.getElementById('layer-debug');
        cb.checked = !cb.checked;
        render();
    }
});

// Layer toggles
document.querySelectorAll('.layer-toggle input').forEach(cb => {
    cb.addEventListener('change', render);
});

// Collapsible sections
document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
        const section = header.dataset.section;
        const content = document.getElementById(`sec-${section}`);
        if (content) {
            header.classList.toggle('collapsed');
            content.classList.toggle('hidden');
        }
    });
});

// Export JSON
document.getElementById('export-btn').addEventListener('click', () => {
    if (!districtData) {
        statusBar.textContent = 'Nothing to export — generate first';
        return;
    }
    const text = JSON.stringify(districtData, null, 2);
    navigator.clipboard.writeText(text).then(() => {
        statusBar.textContent = 'JSON copied to clipboard';
    }).catch(() => {
        // Fallback: show in import panel
        document.getElementById('import-text').value = text;
        showImportPanel('polygon');
    });
});

// --- Init ---
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
loadPopulators();
