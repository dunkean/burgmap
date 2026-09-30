const seedInput = document.getElementById('seed');
const sizeInput = document.getElementById('size');
const paletteSelect = document.getElementById('palette');
const generateBtn = document.getElementById('generate');
const randomBtn = document.getElementById('random');
const container = document.getElementById('svg-container');
const viewer = document.getElementById('viewer');
const status = document.getElementById('status');
const resetZoomBtn = document.getElementById('reset-zoom');

const toggleIds = ['plaza', 'citadel', 'walls', 'temple', 'river', 'coast', 'shanty_town'];

let debounceTimer = null;

// Zoom/pan state
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartTransX = 0;
let panStartTransY = 0;

function applyTransform() {
    container.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

function resetZoom() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
}

async function generate() {
    const seed = seedInput.value;
    const size = sizeInput.value;
    const palette = paletteSelect.value;

    const roads = document.getElementById('roads').value;

    let url = `/api/generate?seed=${seed}&size=${size}&palette=${palette}`;

    if (roads) {
        url += `&roads=${roads}`;
    }

    const roadStyle = document.getElementById('road_style').value;
    if (roadStyle) {
        url += `&road_style=${roadStyle}`;
    }

    const buildingStyle = document.getElementById('building_style').value;
    if (buildingStyle) {
        url += `&building_style=${buildingStyle}`;
    }

    for (const numId of ['elongation', 'river_curvature', 'coast_roughness', 'building_density']) {
        const val = document.getElementById(numId).value;
        if (val) {
            url += `&${numId}=${val}`;
        }
    }

    for (const id of toggleIds) {
        const val = document.getElementById(id).value;
        if (val) {
            url += `&${id}=${val}`;
        }
    }

    status.textContent = 'Generating...';
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const svg = await resp.text();
        container.innerHTML = svg;
        status.textContent = `Generated (seed=${seed}, size=${size})`;
        resetZoom();
    } catch (e) {
        status.textContent = `Error: ${e.message}`;
    }
}

generateBtn.addEventListener('click', generate);

randomBtn.addEventListener('click', () => {
    seedInput.value = Math.floor(Math.random() * 999999) + 1;
    generate();
});

paletteSelect.addEventListener('change', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(generate, 200);
});

resetZoomBtn.addEventListener('click', resetZoom);

// Zoom with mouse wheel
viewer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = viewer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = scale * zoomFactor;

    // Adjust translate to zoom toward cursor
    translateX = mouseX - (mouseX - translateX) * (newScale / scale);
    translateY = mouseY - (mouseY - translateY) * (newScale / scale);
    scale = newScale;

    applyTransform();
}, { passive: false });

// Pan with mouse drag
viewer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartTransX = translateX;
    panStartTransY = translateY;
    viewer.classList.add('grabbing');
});

window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    translateX = panStartTransX + (e.clientX - panStartX);
    translateY = panStartTransY + (e.clientY - panStartY);
    applyTransform();
});

window.addEventListener('mouseup', () => {
    isPanning = false;
    viewer.classList.remove('grabbing');
});
