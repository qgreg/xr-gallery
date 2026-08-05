import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// --- Initialization ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 3); // Average eye height

const dolly = new THREE.Group();
dolly.add(camera);
scene.add(dolly);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
// Cap the pixel ratio: phones report 3x, which triples the fragment cost on
// exactly the hardware least able to absorb it.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// --- VR Debug Console (opt-in via ?debug) ---
const DEBUG = new URLSearchParams(window.location.search).has('debug');

let debugPlane = null;
let updateDebugPanel = () => { };

if (DEBUG) {
    const debugCanvas = document.createElement('canvas');
    debugCanvas.width = 512;
    debugCanvas.height = 512;
    const debugCtx = debugCanvas.getContext('2d');
    const debugTexture = new THREE.CanvasTexture(debugCanvas);
    const debugMaterial = new THREE.MeshBasicMaterial({ map: debugTexture, transparent: true, opacity: 0.8 });
    debugPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), debugMaterial);
    debugPlane.position.set(0, 1, -2);
    scene.add(debugPlane);

    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;

    function drawDebugConsole() {
        debugCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        debugCtx.fillRect(0, 0, 512, 512);
        debugCtx.fillStyle = 'white';
        debugCtx.font = '20px monospace';
        logs.slice(-20).forEach((msg, i) => {
            debugCtx.fillText(msg, 10, 30 + i * 24);
        });
        debugTexture.needsUpdate = true;
    }

    function record(prefix, args) {
        logs.push(prefix + args.join(' '));
        if (logs.length > 100) logs.shift();
        drawDebugConsole();
    }

    console.log = (...args) => {
        record('[LOG] ', args);
        originalLog(...args);
    };

    console.error = (...args) => {
        record('[ERR] ', args);
        originalError(...args);
    };

    window.addEventListener('error', (e) => {
        console.error(`Window: ${e.message}`);
    });

    // Keep the panel pinned in front of the headset. This runs every frame,
    // independent of whether the avatar loaded — the avatar failing to load is
    // exactly the case the console needs to report.
    const headPos = new THREE.Vector3();
    const headDir = new THREE.Vector3();
    updateDebugPanel = () => {
        if (!renderer.xr.isPresenting) return;
        const xrCamera = renderer.xr.getCamera(camera);
        xrCamera.getWorldPosition(headPos);
        xrCamera.getWorldDirection(headDir);
        debugPlane.position.copy(headPos).addScaledVector(headDir, 1.5);
        debugPlane.lookAt(headPos);
    };

    console.log("Debug console initialized");
}

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// Track manual orbiting so the follow-cam doesn't fight the user mid-drag.
let userIsOrbiting = false;
controls.addEventListener('start', () => { userIsOrbiting = true; });
controls.addEventListener('end', () => { userIsOrbiting = false; });

// The camera is parented to the dolly, so its transform is dolly-local while
// every desktop follow-cam calculation below is world-space. That only holds
// while the dolly is at identity, so restore it when the XR session ends.
renderer.xr.addEventListener('sessionend', () => {
    dolly.position.set(0, 0, 0);
    dolly.rotation.set(0, 0, 0);
});

// --- XR Controllers ---
// Parented to the dolly, not the scene. The dolly is the play-space origin and
// it travels with the avatar, so scene-parented controllers would slide out of
// the player's hands the moment they walked anywhere.
const controllerModelFactory = new XRControllerModelFactory();
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1)
]);

for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.6
    }));
    ray.scale.z = 5;
    ray.visible = false;
    controller.add(ray);
    controller.addEventListener('connected', (event) => {
        ray.visible = true;
        const data = event.data || {};
        const axisCount = data.gamepad ? data.gamepad.axes.length : 'no gamepad';
        console.log(`ctrl ${i}: ${data.handedness || '?'}, axes=${axisCount}`);
    });
    controller.addEventListener('disconnected', () => {
        ray.visible = false;
        console.log(`ctrl ${i}: disconnected`);
    });
    dolly.add(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(controllerModelFactory.createControllerModel(grip));
    dolly.add(grip);
}

// --- Eye Height ---
// With a floor-relative reference space, your physical head height becomes your
// virtual eye height — so playing seated puts your eyes at the avatar's waist.
// Measure the head once per session and offset the dolly to land at a standing
// eye height regardless of how the player is actually sitting.
const targetEyeHeight = parseFloat(new URLSearchParams(window.location.search).get('eye')) || 1.6;
let heightOffset = 0;
let heightCalibrated = false;

renderer.xr.addEventListener('sessionstart', () => {
    heightCalibrated = false;
    lastInputSignature = '';
});

function calibrateEyeHeight() {
    const xrCamera = renderer.xr.getCamera(camera);
    const headWorld = new THREE.Vector3();
    xrCamera.getWorldPosition(headWorld);
    // Dolly is unrotated-scale at the scene root, so this is the raw pose height.
    const poseHeight = headWorld.y - dolly.position.y;
    if (poseHeight <= 0.1) return; // pose not resolved yet
    heightOffset = targetEyeHeight - poseHeight;
    heightCalibrated = true;
    console.log(`eye height: pose=${poseHeight.toFixed(2)} offset=${heightOffset.toFixed(2)}`);
}

// --- Lighting ---
// A gallery is lit to read the work, not to be atmospheric: high ambient floor
// so nothing falls into black, cool daylight from the clerestory, and warm
// track spots picking out the hanging walls.
const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
scene.add(ambientLight);

const bounceLight = new THREE.HemisphereLight(0xdfeaf7, 0xb9b4ac, 0.7);
scene.add(bounceLight);

// Angled to come down through the clerestory band near the ceiling.
const windowLight = new THREE.DirectionalLight(0xd8e6ff, 1.1);
windowLight.position.set(-10, 9, 4);
windowLight.castShadow = true;
windowLight.shadow.mapSize.set(2048, 2048);
windowLight.shadow.bias = -0.0008;
// Frame the shadow camera on the room; a directional light's default frustum is
// far too small to cover it, and oversizing it just wastes depth resolution.
const shadowExtent = 12;
windowLight.shadow.camera.left = -shadowExtent;
windowLight.shadow.camera.right = shadowExtent;
windowLight.shadow.camera.top = shadowExtent;
windowLight.shadow.camera.bottom = -shadowExtent;
windowLight.shadow.camera.near = 0.5;
windowLight.shadow.camera.far = 40;
scene.add(windowLight);

// --- Gallery ---
const roomGroup = new THREE.Group();
scene.add(roomGroup);

const ROOM = { width: 18, depth: 12, height: 4.2 };
// A band of clerestory glazing runs the length of the west wall, high enough
// that it never competes with the hanging space below it.
const CLERESTORY = { length: 12, height: 0.9, sill: 3.0 };
// Standard museum hang: centre line of the work at 1.52m.
const HANG_HEIGHT = 1.52;

const halfW = ROOM.width / 2;
const halfD = ROOM.depth / 2;

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf1efea, roughness: 0.96, side: THREE.DoubleSide });
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xb9b5ae, roughness: 0.55, metalness: 0.05 });
const ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0xf7f6f3, roughness: 1 });
const trimMaterial = new THREE.MeshStandardMaterial({ color: 0xfbfaf7, roughness: 0.8 });
const fixtureMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.5, metalness: 0.4 });
const plinthMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f3ef, roughness: 0.9 });

// A wall is a flat shape standing on the floor, optionally with a hole punched
// through it for the glazing. ShapeGeometry lays it out in XY at z = 0, facing
// +Z, so each wall just needs a yaw and a position.
function createWall(span, height, hole) {
    const shape = new THREE.Shape();
    shape.moveTo(-span / 2, 0);
    shape.lineTo(span / 2, 0);
    shape.lineTo(span / 2, height);
    shape.lineTo(-span / 2, height);
    shape.closePath();

    if (hole) {
        const cut = new THREE.Path();
        cut.moveTo(hole.x - hole.width / 2, hole.y);
        cut.lineTo(hole.x + hole.width / 2, hole.y);
        cut.lineTo(hole.x + hole.width / 2, hole.y + hole.height);
        cut.lineTo(hole.x - hole.width / 2, hole.y + hole.height);
        cut.closePath();
        shape.holes.push(cut);
    }

    const wall = new THREE.Mesh(new THREE.ShapeGeometry(shape), wallMaterial);
    wall.receiveShadow = true;
    return wall;
}

const northWall = createWall(ROOM.width, ROOM.height);
northWall.position.z = -halfD;
roomGroup.add(northWall);

const southWall = createWall(ROOM.width, ROOM.height);
southWall.position.z = halfD;
southWall.rotation.y = Math.PI;
roomGroup.add(southWall);

const eastWall = createWall(ROOM.depth, ROOM.height);
eastWall.position.x = halfW;
eastWall.rotation.y = -Math.PI / 2;
roomGroup.add(eastWall);

// The west wall carries the clerestory band the daylight comes through.
const westWall = createWall(ROOM.depth, ROOM.height, {
    x: 0, y: CLERESTORY.sill, width: CLERESTORY.length, height: CLERESTORY.height
});
westWall.position.x = -halfW;
westWall.rotation.y = Math.PI / 2;
roomGroup.add(westWall);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.width, ROOM.depth), floorMaterial);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
roomGroup.add(floor);

const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.width, ROOM.depth), ceilingMaterial);
ceiling.rotation.x = Math.PI / 2;
ceiling.position.y = ROOM.height;
roomGroup.add(ceiling);

// Baseboards, so the wall/floor seam reads as a joint rather than a crease.
const baseboardHeight = 0.12;
const baseboardDepth = 0.03;
[
    { size: [ROOM.width, baseboardHeight, baseboardDepth], pos: [0, baseboardHeight / 2, -halfD + baseboardDepth / 2] },
    { size: [ROOM.width, baseboardHeight, baseboardDepth], pos: [0, baseboardHeight / 2, halfD - baseboardDepth / 2] },
    { size: [baseboardDepth, baseboardHeight, ROOM.depth], pos: [-halfW + baseboardDepth / 2, baseboardHeight / 2, 0] },
    { size: [baseboardDepth, baseboardHeight, ROOM.depth], pos: [halfW - baseboardDepth / 2, baseboardHeight / 2, 0] }
].forEach(({ size, pos }) => {
    const board = new THREE.Mesh(new THREE.BoxGeometry(...size), trimMaterial);
    board.position.set(...pos);
    roomGroup.add(board);
});

// Clerestory mullions, plus a plain bright panel outside the glass so the
// opening reads as daylight rather than a hole onto the clear colour.
const clerestoryGroup = new THREE.Group();
const frameThickness = 0.07;
const frameDepth = 0.12;
const bars = [
    { size: [frameDepth, frameThickness, CLERESTORY.length + frameThickness * 2], pos: [0, CLERESTORY.height / 2 + frameThickness / 2, 0] },
    { size: [frameDepth, frameThickness, CLERESTORY.length + frameThickness * 2], pos: [0, -CLERESTORY.height / 2 - frameThickness / 2, 0] }
];
for (let i = -2; i <= 2; i++) {
    bars.push({ size: [frameDepth * 0.6, CLERESTORY.height, frameThickness * 0.6], pos: [0, 0, i * (CLERESTORY.length / 5)] });
}
bars.forEach(({ size, pos }) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(...size), trimMaterial);
    bar.position.set(...pos);
    clerestoryGroup.add(bar);
});

const skyPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(CLERESTORY.length, CLERESTORY.height),
    new THREE.MeshBasicMaterial({ color: 0xd6e6fb })
);
skyPanel.rotation.y = -Math.PI / 2;
skyPanel.position.x = -0.1;
clerestoryGroup.add(skyPanel);

clerestoryGroup.position.set(-halfW, CLERESTORY.sill + CLERESTORY.height / 2, 0);
roomGroup.add(clerestoryGroup);

// --- Freestanding partition ---
// The one piece of architecture that makes a gallery a gallery: it breaks the
// sightline, doubles the hanging surface, and forces a circulation route
// around either end instead of a straight walk from door to door.
const PARTITION = { x: 0, halfLength: 3.6, thickness: 0.3, height: 3.2 };
const partition = new THREE.Mesh(
    new THREE.BoxGeometry(PARTITION.thickness, PARTITION.height, PARTITION.halfLength * 2),
    wallMaterial
);
partition.position.set(PARTITION.x, PARTITION.height / 2, 0);
partition.castShadow = true;
partition.receiveShadow = true;
roomGroup.add(partition);

// --- Wall placement ---
// Every hangable surface, expressed as: where the plane sits, which way it
// faces, and which world axis you slide along to move sideways across it. A
// small epsilon lifts the work clear of the wall so it never z-fights.
const SURFACE_EPS = 0.02;

function wallPlacement(wall, u, height) {
    switch (wall) {
        case 'north': return { pos: new THREE.Vector3(u, height, -halfD + SURFACE_EPS), rotY: 0 };
        case 'south': return { pos: new THREE.Vector3(u, height, halfD - SURFACE_EPS), rotY: Math.PI };
        case 'east': return { pos: new THREE.Vector3(halfW - SURFACE_EPS, height, u), rotY: -Math.PI / 2 };
        case 'west': return { pos: new THREE.Vector3(-halfW + SURFACE_EPS, height, u), rotY: Math.PI / 2 };
        case 'partition-east':
            return { pos: new THREE.Vector3(PARTITION.x + PARTITION.thickness / 2 + SURFACE_EPS, height, u), rotY: Math.PI / 2 };
        case 'partition-west':
            return { pos: new THREE.Vector3(PARTITION.x - PARTITION.thickness / 2 - SURFACE_EPS, height, u), rotY: -Math.PI / 2 };
        default:
            console.error('Unknown wall: ' + wall);
            return { pos: new THREE.Vector3(), rotY: 0 };
    }
}

// --- Procedural artwork ---
// The canvases are generated rather than fetched, so the gallery is hung the
// moment the page parses and stays hung if every remote host is unreachable.
// Swap any entry's generated art for a real image by giving it `src`.
function mulberry32(seed) {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const PALETTES = {
    ochre: ['#e8dcc8', '#d9a441', '#b4552d', '#3f3a35', '#8a7f6d'],
    cobalt: ['#eef1f6', '#2f4b8f', '#6f9bd1', '#12203f', '#c9d6e8'],
    rust: ['#f2e9df', '#a63c22', '#e0762f', '#2b2118', '#7d6a53'],
    sage: ['#eef0e8', '#6d8a63', '#2f4033', '#c3cbb2', '#8f9c78'],
    ink: ['#f4f2ee', '#1b1b1d', '#5c5c60', '#a8a49c', '#d8d4cc'],
    plum: ['#f0e8ef', '#5b2a4d', '#9c4f7a', '#241726', '#d3a9c2']
};

function pick(rnd, list) {
    return list[Math.floor(rnd() * list.length)];
}

const ART_STYLES = {
    // Broad horizontal fields, soft seams — a colour-field abstraction.
    fields(ctx, W, H, rnd, colors) {
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, W, H);
        let y = 0;
        while (y < H) {
            const band = H * (0.08 + rnd() * 0.22);
            ctx.fillStyle = pick(rnd, colors);
            ctx.globalAlpha = 0.55 + rnd() * 0.45;
            ctx.fillRect(0, y, W, band);
            y += band;
        }
        ctx.globalAlpha = 1;
    },

    // Hard-edged circles and bars over a flat ground.
    bauhaus(ctx, W, H, rnd, colors) {
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 7; i++) {
            ctx.fillStyle = pick(rnd, colors.slice(1));
            if (rnd() < 0.5) {
                const r = Math.min(W, H) * (0.08 + rnd() * 0.22);
                ctx.beginPath();
                ctx.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.fillRect(rnd() * W * 0.8, rnd() * H * 0.8, W * (0.1 + rnd() * 0.3), H * (0.05 + rnd() * 0.25));
            }
        }
    },

    // Concentric rings drifting off centre.
    rings(ctx, W, H, rnd, colors) {
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, W, H);
        const cx = W * (0.35 + rnd() * 0.3);
        const cy = H * (0.35 + rnd() * 0.3);
        const max = Math.hypot(W, H) * 0.6;
        for (let r = max; r > 4; r -= max * (0.05 + rnd() * 0.05)) {
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = pick(rnd, colors);
            ctx.globalAlpha = 0.85;
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    },

    // Loose gestural strokes — the closest thing here to a brush.
    gesture(ctx, W, H, rnd, colors) {
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, W, H);
        ctx.lineCap = 'round';
        for (let i = 0; i < 18; i++) {
            ctx.strokeStyle = pick(rnd, colors.slice(1));
            ctx.globalAlpha = 0.25 + rnd() * 0.6;
            ctx.lineWidth = 4 + rnd() * 34;
            ctx.beginPath();
            let x = rnd() * W;
            let y = rnd() * H;
            ctx.moveTo(x, y);
            for (let s = 0; s < 3; s++) {
                x += (rnd() - 0.5) * W * 0.7;
                y += (rnd() - 0.5) * H * 0.7;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },

    // A modular grid, each cell filled or left as ground.
    grid(ctx, W, H, rnd, colors) {
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, W, H);
        const cols = 4 + Math.floor(rnd() * 4);
        const rows = Math.max(2, Math.round(cols * (H / W)));
        const cw = W / cols;
        const ch = H / rows;
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                if (rnd() < 0.35) continue;
                ctx.fillStyle = pick(rnd, colors.slice(1));
                const inset = rnd() * cw * 0.18;
                ctx.fillRect(c * cw + inset, r * ch + inset, cw - inset * 2, ch - inset * 2);
            }
        }
    },

    // Stacked silhouettes reading as a flattened landscape.
    horizon(ctx, W, H, rnd, colors) {
        const sky = ctx.createLinearGradient(0, 0, 0, H);
        sky.addColorStop(0, colors[1]);
        sky.addColorStop(1, colors[0]);
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, H);
        for (let layer = 0; layer < 4; layer++) {
            const base = H * (0.45 + layer * 0.14);
            ctx.fillStyle = colors[2 + (layer % 3)];
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.moveTo(0, H);
            ctx.lineTo(0, base);
            for (let x = 0; x <= W; x += W / 8) {
                ctx.lineTo(x, base - rnd() * H * 0.16);
            }
            ctx.lineTo(W, H);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
};

function makeArtTexture(style, paletteName, seed, aspect) {
    const canvas = document.createElement('canvas');
    // Long edge at 768px: enough to hold up when you walk right into the
    // canvas in VR, cheap enough to generate a dozen of at load.
    const long = 768;
    canvas.width = aspect >= 1 ? long : Math.round(long * aspect);
    canvas.height = aspect >= 1 ? Math.round(long / aspect) : long;

    const ctx = canvas.getContext('2d');
    const rnd = mulberry32(seed);
    const colors = PALETTES[paletteName] || PALETTES.ink;
    (ART_STYLES[style] || ART_STYLES.fields)(ctx, canvas.width, canvas.height, rnd, colors);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
}

// Wall label: title, artist, year, medium, in the flat house style every
// gallery seems to converge on.
function makeLabelTexture(art) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fbfaf7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#1b1b1d';
    ctx.font = 'italic 34px Georgia, serif';
    ctx.fillText(art.title, 28, 70);

    ctx.font = '28px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#3d3d40';
    ctx.fillText(art.artist, 28, 118);

    ctx.font = '24px Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#6b6b70';
    ctx.fillText(art.year, 28, 160);
    ctx.fillText(art.medium, 28, 198);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
}

// The hang. `u` slides along the wall, `width`/`height` are the visible canvas
// in metres; everything else is the caption.
const ARTWORKS = [
    { wall: 'north', u: -6.0, width: 1.5, height: 1.9, style: 'fields', palette: 'ochre', title: 'Long Afternoon', artist: 'M. Verhoeven', year: '2019', medium: 'Oil on linen' },
    { wall: 'north', u: -2.2, width: 2.4, height: 1.5, style: 'horizon', palette: 'sage', title: 'Country Without Weather', artist: 'A. Okonkwo', year: '2021', medium: 'Acrylic on panel' },
    { wall: 'north', u: 2.2, width: 1.6, height: 1.6, style: 'bauhaus', palette: 'cobalt', title: 'Study for a Signal', artist: 'H. Lindqvist', year: '2017', medium: 'Screenprint' },
    { wall: 'north', u: 6.0, width: 1.3, height: 1.8, style: 'rings', palette: 'rust', title: 'Aperture III', artist: 'J. Marchetti', year: '2022', medium: 'Pigment on board' },

    { wall: 'south', u: -5.4, width: 2.0, height: 1.4, style: 'grid', palette: 'ink', title: 'Ledger', artist: 'S. Adeyemi', year: '2020', medium: 'Ink and gesso' },
    { wall: 'south', u: 0, width: 2.8, height: 1.7, style: 'gesture', palette: 'plum', title: 'Nocturne, Unfinished', artist: 'R. Kowalczyk', year: '2018', medium: 'Oil on canvas' },
    { wall: 'south', u: 5.4, width: 1.4, height: 1.8, style: 'fields', palette: 'cobalt', title: 'Six Weathers', artist: 'M. Verhoeven', year: '2023', medium: 'Oil on linen' },

    { wall: 'east', u: -2.6, width: 1.6, height: 2.0, style: 'gesture', palette: 'ink', title: 'The Long Room', artist: 'T. Baraka', year: '2016', medium: 'Charcoal on paper' },
    { wall: 'east', u: 2.6, width: 1.6, height: 1.2, style: 'grid', palette: 'ochre', title: 'Field Notes', artist: 'T. Baraka', year: '2016', medium: 'Mixed media' },

    { wall: 'west', u: -3.4, width: 1.5, height: 1.5, style: 'rings', palette: 'sage', title: 'Slow Circle', artist: 'A. Okonkwo', year: '2015', medium: 'Egg tempera' },
    { wall: 'west', u: 3.4, width: 1.8, height: 1.3, style: 'horizon', palette: 'rust', title: 'Return Journey', artist: 'J. Marchetti', year: '2024', medium: 'Pigment on board' },

    { wall: 'partition-east', u: -1.6, width: 1.4, height: 1.7, style: 'bauhaus', palette: 'plum', title: 'Interval', artist: 'H. Lindqvist', year: '2021', medium: 'Screenprint' },
    { wall: 'partition-east', u: 1.6, width: 1.4, height: 1.7, style: 'bauhaus', palette: 'ochre', title: 'Interval (Reprise)', artist: 'H. Lindqvist', year: '2021', medium: 'Screenprint' },
    { wall: 'partition-west', u: 0, width: 2.6, height: 1.8, style: 'fields', palette: 'ink', title: 'Everything at Once', artist: 'S. Adeyemi', year: '2025', medium: 'Oil and wax on linen' }
];

const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.55 });
const matMaterial = new THREE.MeshStandardMaterial({ color: 0xf7f5f0, roughness: 0.95 });
const artGroup = new THREE.Group();
roomGroup.add(artGroup);

// Each hung work, with its world position cached for the proximity caption.
const hungWorks = [];
const textureLoader = new THREE.TextureLoader();

ARTWORKS.forEach((art, index) => {
    // Hang by centre line, not by the bottom edge: that is what makes a wall of
    // mismatched sizes read as one row.
    const { pos, rotY } = wallPlacement(art.wall, art.u, HANG_HEIGHT);
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = rotY;

    const matWidth = art.width + 0.18;
    const matHeight = art.height + 0.18;
    const frameW = matWidth + 0.09;
    const frameH = matHeight + 0.09;

    const frame = new THREE.Mesh(new THREE.BoxGeometry(frameW, frameH, 0.07), frameMaterial);
    frame.position.z = 0.035;
    frame.castShadow = true;
    group.add(frame);

    const mat = new THREE.Mesh(new THREE.PlaneGeometry(matWidth, matHeight), matMaterial);
    mat.position.z = 0.071;
    group.add(mat);

    const artMaterial = new THREE.MeshStandardMaterial({
        roughness: 0.85,
        // A little self-illumination so the work stays legible from an angle
        // the track spots do not reach. Paintings that go grey in the corner of
        // a room are a rendering artefact, not a curatorial choice.
        emissive: 0xffffff,
        emissiveIntensity: 0.28
    });

    if (art.src) {
        textureLoader.load(art.src, (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
            artMaterial.map = texture;
            artMaterial.emissiveMap = texture;
            artMaterial.needsUpdate = true;
        }, undefined, () => console.error('Artwork failed to load: ' + art.src));
    } else {
        const texture = makeArtTexture(art.style, art.palette, index * 7919 + 13, art.width / art.height);
        artMaterial.map = texture;
        artMaterial.emissiveMap = texture;
    }

    const canvasMesh = new THREE.Mesh(new THREE.PlaneGeometry(art.width, art.height), artMaterial);
    canvasMesh.position.z = 0.073;
    group.add(canvasMesh);

    // Label to the right of the frame, at a fixed 1.25m off the floor rather
    // than relative to the frame — a row of labels stepping up and down with
    // the art is the giveaway of a badly hung wall.
    const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.17),
        new THREE.MeshBasicMaterial({ map: makeLabelTexture(art) })
    );
    label.position.set(frameW / 2 + 0.24, 1.25 - HANG_HEIGHT, 0.02);
    group.add(label);

    artGroup.add(group);

    const worldPos = new THREE.Vector3();
    group.getWorldPosition(worldPos);
    hungWorks.push({ art, group, worldPos });
});

// --- Track lighting ---
// Two rails with fixture housings, plus a small number of real spots. Four
// shadowless SpotLights is the whole budget: one per hanging wall pair. Giving
// every work its own light would be truer to a gallery and would also halve
// the frame rate on a standalone headset.
const trackGroup = new THREE.Group();
roomGroup.add(trackGroup);

[-halfD + 2.2, halfD - 2.2].forEach((z) => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(ROOM.width - 1, 0.06, 0.08), fixtureMaterial);
    rail.position.set(0, ROOM.height - 0.08, z);
    trackGroup.add(rail);

    for (let i = -4; i <= 4; i++) {
        const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.2, 12), fixtureMaterial);
        housing.position.set(i * 2, ROOM.height - 0.22, z);
        housing.rotation.x = z < 0 ? -0.5 : 0.5;
        trackGroup.add(housing);
    }
});

// Wide cone, heavy penumbra, modest intensity: a spot tight enough to see as a
// pool of light on the wall reads as a blown-out white disc once the ambient
// floor is added on top of it.
function addWallSpot(x, y, z, targetPos, intensity = 9) {
    const spot = new THREE.SpotLight(0xfff2e0, intensity, 24, Math.PI / 4, 0.85, 1.2);
    spot.position.set(x, y, z);
    spot.castShadow = false;
    scene.add(spot);
    spot.target.position.copy(targetPos);
    scene.add(spot.target);
    return spot;
}

addWallSpot(-4.5, ROOM.height - 0.3, -halfD + 2.2, new THREE.Vector3(-4.5, HANG_HEIGHT, -halfD));
addWallSpot(4.5, ROOM.height - 0.3, -halfD + 2.2, new THREE.Vector3(4.5, HANG_HEIGHT, -halfD));
addWallSpot(-4.5, ROOM.height - 0.3, halfD - 2.2, new THREE.Vector3(-4.5, HANG_HEIGHT, halfD));
addWallSpot(4.5, ROOM.height - 0.3, halfD - 2.2, new THREE.Vector3(4.5, HANG_HEIGHT, halfD));
// One more washing the partition, which is otherwise lit only by bounce.
addWallSpot(1.8, ROOM.height - 0.3, 0, new THREE.Vector3(PARTITION.x, HANG_HEIGHT, 0), 7);

// --- Plinths and sculpture ---
// Anything the avatar can walk into gets an axis-aligned footprint here, and
// updateAvatar pushes back out of it. Without this you stroll through the
// partition and stand inside the bronze.
const obstacles = [];

function addObstacle(x, z, halfX, halfZ) {
    obstacles.push({ x, z, halfX, halfZ });
}

addObstacle(PARTITION.x, 0, PARTITION.thickness / 2, PARTITION.halfLength);

const bronzeMaterial = new THREE.MeshStandardMaterial({ color: 0x8c6b3f, roughness: 0.35, metalness: 0.85 });
const marbleMaterial = new THREE.MeshStandardMaterial({ color: 0xe9e5dd, roughness: 0.25, metalness: 0.05 });
const slateMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4f52, roughness: 0.6, metalness: 0.2 });

const PLINTHS = [
    {
        x: -6, z: 0, size: 0.55, height: 1.0, material: bronzeMaterial,
        geometry: new THREE.TorusKnotGeometry(0.22, 0.075, 128, 24),
        lift: 0.32,
        art: { title: 'Knot (Cast II)', artist: 'D. Ferreira', year: '2020', medium: 'Cast bronze' }
    },
    {
        x: 6, z: -2.6, size: 0.55, height: 1.05, material: marbleMaterial,
        geometry: new THREE.IcosahedronGeometry(0.3, 0),
        lift: 0.3,
        art: { title: 'Solid, Divided', artist: 'D. Ferreira', year: '2022', medium: 'Carrara marble' }
    },
    {
        x: 6, z: 2.6, size: 0.55, height: 0.9, material: slateMaterial,
        geometry: new THREE.DodecahedronGeometry(0.28, 0),
        lift: 0.3,
        art: { title: 'Quarry Sample', artist: 'L. Nakamura', year: '2019', medium: 'Slate and steel' }
    }
];

PLINTHS.forEach(({ x, z, size, height, material, geometry, lift, art }) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const box = new THREE.Mesh(new THREE.BoxGeometry(size, height, size), plinthMaterial);
    box.position.y = height / 2;
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);

    const piece = new THREE.Mesh(geometry, material);
    piece.position.y = height + lift;
    piece.castShadow = true;
    piece.receiveShadow = true;
    group.add(piece);

    const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.17),
        new THREE.MeshBasicMaterial({ map: makeLabelTexture(art) })
    );
    // Angled up off the plinth face, the way a deck label sits.
    label.position.set(0, height - 0.14, size / 2 + 0.005);
    group.add(label);

    roomGroup.add(group);
    addObstacle(x, z, size / 2, size / 2);

    const worldPos = new THREE.Vector3(x, height + lift, z);
    hungWorks.push({ art, group, worldPos });
});

// --- Benches ---
const benchMaterial = new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.8 });
[
    { x: -2.5, z: 4.2 },
    { x: 2.5, z: -4.2 }
].forEach(({ x, z }) => {
    const bench = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.45), benchMaterial);
    seat.position.y = 0.42;
    seat.castShadow = true;
    seat.receiveShadow = true;
    bench.add(seat);

    [-0.7, 0.7].forEach((offset) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.4), fixtureMaterial);
        leg.position.set(offset, 0.21, 0);
        leg.castShadow = true;
        bench.add(leg);
    });

    bench.position.set(x, 0, z);
    roomGroup.add(bench);
    addObstacle(x, z, 0.9, 0.25);
});

// --- Shadows ---
// Every mesh in the room receives. Fittings and freestanding objects also cast;
// the shell itself does not, because single-sided planes casting onto
// themselves produce acne, and the sky panel is unlit by design.
const shellMeshes = new Set([northWall, southWall, eastWall, westWall, floor, ceiling, skyPanel]);
roomGroup.traverse(obj => {
    if (!obj.isMesh) return;
    obj.receiveShadow = obj !== skyPanel;
    obj.castShadow = !shellMeshes.has(obj);
});
// Labels are unlit basic-material planes; casting from them just produces
// floating rectangles of shadow on the wall behind.
artGroup.traverse(obj => {
    if (obj.isMesh && obj.material.isMeshBasicMaterial) obj.castShadow = false;
});

// --- Avatar Loading ---
// Ready Player Me shut down, so the avatar now comes from a three.js example
// asset that ships its own Idle/Walk clips. One file means one fetch and no
// cross-rig retargeting: the clips bind to the skeleton they were authored for.
const loader = new GLTFLoader();
const avatarUrl = 'https://threejs.org/examples/models/gltf/Soldier.glb';

let avatar = null;
let mixer = null;
let idleAction, walkAction;
const avatarSpeed = 2.0;
const avatarTurnSpeed = 2.0;
// How wide the avatar is for collision purposes.
const AVATAR_RADIUS = 0.4;

// Which way the model's front points along its local Z. Soldier.glb faces -Z,
// confirmed visually. This one constant drives locomotion, the follow-cam, and
// the VR dolly yaw together.
const avatarForwardZ = -1;

// Desktop follow-cam placement, plus scratch vectors reused each frame.
const followDistance = 4;
const followHeight = 2;
const followLookHeight = 1;
const cameraTarget = new THREE.Vector3();
const lookTarget = new THREE.Vector3();

// Enter at the south-west corner looking up the room, off the centre line so
// the partition reads as an object to walk around rather than a blank wall in
// your face. Facing -Z is the model's own forward, hence a yaw of zero.
const START_POSITION = new THREE.Vector3(-3.4, 0, halfD - 1.5);
const START_YAW = 0;

function showLoadError(msg) {
    console.error(msg);
    const info = document.getElementById('info');
    if (info) info.innerHTML = `<p>Could not load the avatar.</p><p>${msg}</p>`;
    useFallbackAvatar();
}

// Without an avatar, updateAvatar bails on its first line and nothing works:
// no locomotion, no camera follow, no dolly. A plain capsule stand-in keeps the
// whole control scheme alive when the model host is unreachable.
function useFallbackAvatar() {
    if (avatar) return;
    const capsule = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.3, 1.1, 8, 16),
        new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.7 })
    );
    capsule.position.y = 0.85;
    capsule.castShadow = true;
    capsule.receiveShadow = true;
    avatar = new THREE.Group();
    avatar.add(capsule);
    avatar.position.copy(START_POSITION);
    avatar.rotation.y = START_YAW;
    scene.add(avatar);
    console.log('Using fallback avatar');
}

loader.load(avatarUrl, (gltf) => {
    avatar = gltf.scene;
    avatar.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });
    avatar.position.copy(START_POSITION);
    avatar.rotation.y = START_YAW;
    scene.add(avatar);
    console.log('Avatar loaded');

    const clips = gltf.animations || [];
    if (clips.length === 0) {
        console.error('No animation clips in ' + avatarUrl);
        return;
    }

    mixer = new THREE.AnimationMixer(avatar);
    const idleClip = clips.find(c => c.name.toLowerCase().includes('idle')) || clips[0];
    const walkClip = clips.find(c => c.name.toLowerCase().includes('walk'))
        || (clips.length > 1 ? clips[1] : null);

    if (idleClip) {
        idleAction = mixer.clipAction(idleClip);
        idleAction.play();
        idleAction.setEffectiveWeight(1);
    }

    if (walkClip) {
        walkAction = mixer.clipAction(walkClip);
        walkAction.play();
        walkAction.setEffectiveWeight(0);
    } else {
        console.error('No walk clip found; available: ' + clips.map(c => c.name).join(', '));
    }

    console.log('Animations loaded: ' + clips.map(c => c.name).join(', '));
}, undefined, (err) => showLoadError('Avatar error: ' + (err && err.message ? err.message : err)));

// --- Input Handling ---
const keyState = {};
window.addEventListener('keydown', (e) => keyState[e.key.toLowerCase()] = true);
window.addEventListener('keyup', (e) => keyState[e.key.toLowerCase()] = false);
// Alt-tabbing away while holding W otherwise leaves the key latched down and
// the avatar walking into a wall until you come back and press it again.
window.addEventListener('blur', () => {
    for (const key in keyState) keyState[key] = false;
});

// --- Joystick ---
const joystickZone = document.getElementById('joystick-zone');
const joystickKnob = document.getElementById('joystick-knob');
const joystickVector = { x: 0, y: 0 };
let joystickTouchId = null;

if (joystickZone) {
    const maxRadius = 35;
    joystickZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        joystickTouchId = touch.identifier;
    }, { passive: false });

    joystickZone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === joystickTouchId) {
                const rect = joystickZone.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                let dx = e.changedTouches[i].clientX - centerX;
                let dy = e.changedTouches[i].clientY - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > maxRadius) {
                    dx *= maxRadius / dist;
                    dy *= maxRadius / dist;
                }
                joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
                joystickVector.x = dx / maxRadius;
                joystickVector.y = dy / maxRadius;
            }
        }
    }, { passive: false });

    const endJoystick = (e) => {
        joystickTouchId = null;
        joystickVector.x = 0;
        joystickVector.y = 0;
        joystickKnob.style.transform = `translate(-50%, -50%)`;
    };
    // touchcancel matters as much as touchend: a system gesture or an incoming
    // call ends the touch without firing touchend, which would otherwise leave
    // the stick deflected and the avatar walking with no way to stop it.
    joystickZone.addEventListener('touchend', endJoystick);
    joystickZone.addEventListener('touchcancel', endJoystick);
}

// The xr-standard mapping puts the thumbstick on axes 2/3 and the touchpad on
// 0/1. Simpler profiles only expose 0/1, so fall back on length rather than on
// a truthiness test — a stick resting at exactly 0 is a valid reading, not a
// missing one.
function readThumbstick(gamepad) {
    const axes = gamepad.axes;
    if (axes.length >= 4) return { x: axes[2], y: axes[3] };
    if (axes.length >= 2) return { x: axes[0], y: axes[1] };
    return { x: 0, y: 0 };
}

// Rescale past the deadzone so motion eases in from a standstill instead of
// jumping straight to the deadzone magnitude.
const STICK_DEADZONE = 0.15;
function applyDeadzone(value) {
    const magnitude = Math.abs(value);
    if (magnitude < STICK_DEADZONE) return 0;
    return Math.sign(value) * (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}

const SNAP_TURN_ANGLE = Math.PI / 6;
const SNAP_TURN_THRESHOLD = 0.7;
const SNAP_TURN_RELEASE = 0.3;
let snapTurnArmed = true;
let lastInputSignature = '';

// Push the avatar out of any footprint it ended up inside, along whichever axis
// it is least deep into — that is the axis it most likely entered through, so
// resolving there slides along the obstacle instead of snapping around it.
function resolveObstacles(position) {
    for (const box of obstacles) {
        const dx = position.x - box.x;
        const dz = position.z - box.z;
        const overlapX = box.halfX + AVATAR_RADIUS - Math.abs(dx);
        const overlapZ = box.halfZ + AVATAR_RADIUS - Math.abs(dz);
        if (overlapX <= 0 || overlapZ <= 0) continue;
        if (overlapX < overlapZ) {
            position.x += Math.sign(dx || 1) * overlapX;
        } else {
            position.z += Math.sign(dz || 1) * overlapZ;
        }
    }
}

// --- Proximity caption ---
// Standing in front of a work puts its details on screen. In VR the wall labels
// do this job already, so the DOM caption is a desktop and handset affordance.
const captionEl = document.getElementById('caption');
const CAPTION_RANGE = 3.2;
let captionKey = '';

function updateCaption() {
    if (!captionEl || !avatar) return;

    let nearest = null;
    let nearestDist = CAPTION_RANGE;
    for (const work of hungWorks) {
        const dist = Math.hypot(work.worldPos.x - avatar.position.x, work.worldPos.z - avatar.position.z);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearest = work.art;
        }
    }

    const key = nearest ? nearest.title : '';
    if (key === captionKey) return;
    captionKey = key;

    if (!nearest) {
        captionEl.classList.remove('visible');
        return;
    }
    captionEl.innerHTML =
        `<span class="title">${nearest.title}</span>` +
        `<span class="artist">${nearest.artist}, ${nearest.year}</span>` +
        `<span class="medium">${nearest.medium}</span>`;
    captionEl.classList.add('visible');
}

function updateAvatar(dt) {
    if (!avatar) return;

    let moveForward = 0;
    let turn = 0;

    if (keyState['w'] || keyState['arrowup']) moveForward += 1;
    if (keyState['s'] || keyState['arrowdown']) moveForward -= 1;
    if (keyState['a'] || keyState['arrowleft']) turn += 1;
    if (keyState['d'] || keyState['arrowright']) turn -= 1;

    if (Math.abs(joystickVector.y) > 0.1) moveForward -= joystickVector.y;
    if (Math.abs(joystickVector.x) > 0.1) turn -= joystickVector.x;

    const session = renderer.xr.getSession();
    if (session) {
        // Log whenever the set of live inputs changes, so a controller that
        // never connects or silently drops shows up in the debug panel.
        const signature = Array.from(session.inputSources)
            .map(s => `${s.handedness}${s.gamepad ? '+pad' : '/NOPAD'}`).join(' ');
        if (signature !== lastInputSignature) {
            lastInputSignature = signature;
            console.log('xr inputs: ' + (signature || 'none'));
        }

        let snapInput = 0;
        for (const source of session.inputSources) {
            if (!source.gamepad) continue;
            const stick = readThumbstick(source.gamepad);
            if (source.handedness === 'left') {
                moveForward -= applyDeadzone(stick.y);
            } else if (source.handedness === 'right') {
                snapInput = stick.x;
            }
        }

        // Snap turn rather than smooth yaw: continuous rotation is one of the
        // most reliable ways to make people sick in VR. Fire once per
        // deflection and re-arm only when the stick returns near centre.
        if (snapTurnArmed && Math.abs(snapInput) > SNAP_TURN_THRESHOLD) {
            avatar.rotation.y -= Math.sign(snapInput) * SNAP_TURN_ANGLE;
            snapTurnArmed = false;
        } else if (Math.abs(snapInput) < SNAP_TURN_RELEASE) {
            snapTurnArmed = true;
        }
    }

    const forward = new THREE.Vector3(0, 0, avatarForwardZ).applyQuaternion(avatar.quaternion);

    if (moveForward !== 0) {
        avatar.position.addScaledVector(forward, moveForward * avatarSpeed * dt);
        // Keep the avatar inside the shell, then out of the furniture.
        const limitX = halfW - AVATAR_RADIUS;
        const limitZ = halfD - AVATAR_RADIUS;
        avatar.position.x = THREE.MathUtils.clamp(avatar.position.x, -limitX, limitX);
        avatar.position.z = THREE.MathUtils.clamp(avatar.position.z, -limitZ, limitZ);
        resolveObstacles(avatar.position);
        if (walkAction) walkAction.setEffectiveWeight(THREE.MathUtils.lerp(walkAction.getEffectiveWeight(), 1, 0.1));
        if (idleAction) idleAction.setEffectiveWeight(THREE.MathUtils.lerp(idleAction.getEffectiveWeight(), 0, 0.1));
    } else {
        if (walkAction) walkAction.setEffectiveWeight(THREE.MathUtils.lerp(walkAction.getEffectiveWeight(), 0, 0.1));
        if (idleAction) idleAction.setEffectiveWeight(THREE.MathUtils.lerp(idleAction.getEffectiveWeight(), 1, 0.1));
    }

    if (turn !== 0) {
        avatar.rotation.y += turn * avatarTurnSpeed * dt;
    }

    if (mixer) mixer.update(dt);

    if (renderer.xr.isPresenting) {
        // Sync dolly to avatar. The camera looks down its own -Z, so a model
        // facing +Z needs a half turn to point the view the same way it walks.
        dolly.position.copy(avatar.position);
        dolly.rotation.y = avatar.rotation.y + (avatarForwardZ > 0 ? Math.PI : 0);
        if (!heightCalibrated) calibrateEyeHeight();
        dolly.position.y = avatar.position.y + heightOffset;
    } else {
        // Desktop follow cam: sit behind the avatar's back and above it, so the
        // camera swings around as the avatar turns instead of staring it down.
        // Skip the reposition while the user is dragging, so orbiting still works.
        if (!userIsOrbiting) {
            cameraTarget.copy(avatar.position).addScaledVector(forward, -followDistance);
            cameraTarget.y += followHeight;
            camera.position.lerp(cameraTarget, 0.1);
            // Backing into a wall would otherwise put the camera outside the
            // gallery, looking at the blank side of the shell.
            camera.position.x = THREE.MathUtils.clamp(camera.position.x, -halfW + 0.3, halfW - 0.3);
            camera.position.z = THREE.MathUtils.clamp(camera.position.z, -halfD + 0.3, halfD - 0.3);
            camera.position.y = Math.min(camera.position.y, ROOM.height - 0.3);
        }
        lookTarget.copy(avatar.position);
        lookTarget.y += followLookHeight;
        controls.target.lerp(lookTarget, 0.1);
        controls.update();
    }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    // A backgrounded tab or a sleeping headset can hand back a delta measured
    // in seconds, which would teleport the avatar across the room on the first
    // frame after it wakes. Cap it at roughly three frames' worth.
    const dt = Math.min(clock.getDelta(), 0.05);
    updateAvatar(dt);
    updateCaption();
    updateDebugPanel();
    renderer.render(scene, camera);
});

// Under ?debug, hand the scene graph to the console so a headless page can be
// inspected — and rendered off-screen — without a visible canvas.
if (DEBUG) {
    window.gallery = { scene, camera, renderer, hungWorks, ROOM };
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
