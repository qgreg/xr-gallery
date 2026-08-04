import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

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

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0x404040, 1.5);
scene.add(ambientLight);

// Cool light down from the ceiling, warm bounce up off the floor. Cheap stand-in
// for the indirect light a real interior would have.
const bounceLight = new THREE.HemisphereLight(0xbcd8f5, 0x8a6b4f, 0.6);
scene.add(bounceLight);

const lampLight = new THREE.PointLight(0xffaa55, 10, 10);
lampLight.position.set(1.2, 1.5, -1.2);
lampLight.castShadow = true;
lampLight.shadow.mapSize.set(1024, 1024);
lampLight.shadow.bias = -0.0015;
lampLight.shadow.camera.near = 0.1;
lampLight.shadow.camera.far = 12;
scene.add(lampLight);

// Angled so it reads as sun coming through the west window.
const windowLight = new THREE.DirectionalLight(0xaaccff, 1.4);
windowLight.position.set(-8, 3.5, 1.5);
windowLight.castShadow = true;
windowLight.shadow.mapSize.set(2048, 2048);
windowLight.shadow.bias = -0.0008;
// Frame the shadow camera on the room; a directional light's default frustum is
// far too small to cover it, and oversizing it just wastes depth resolution.
const shadowExtent = 8;
windowLight.shadow.camera.left = -shadowExtent;
windowLight.shadow.camera.right = shadowExtent;
windowLight.shadow.camera.top = shadowExtent;
windowLight.shadow.camera.bottom = -shadowExtent;
windowLight.shadow.camera.near = 0.5;
windowLight.shadow.camera.far = 30;
scene.add(windowLight);

// --- Cozy Room Content ---
const roomGroup = new THREE.Group();
scene.add(roomGroup);

// 0. Room shell
const ROOM = { width: 12, depth: 12, height: 3 };
const WINDOW = { width: 2.4, height: 1.5, sill: 1 };

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xd9d0c5, roughness: 0.95, side: THREE.DoubleSide });
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 0.75 });
const ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0xeae6e0, roughness: 1 });
const trimMaterial = new THREE.MeshStandardMaterial({ color: 0xf2ede6, roughness: 0.8 });

// A wall is a flat shape standing on the floor, optionally with a hole punched
// through it for the window. ShapeGeometry lays it out in XY at z = 0, facing
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

const halfW = ROOM.width / 2;
const halfD = ROOM.depth / 2;

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

// The west wall carries the window the directional light shines through.
const westWall = createWall(ROOM.depth, ROOM.height, {
    x: 0, y: WINDOW.sill, width: WINDOW.width, height: WINDOW.height
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
const baseboardHeight = 0.14;
const baseboardDepth = 0.04;
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

// Window frame and mullions, sitting just inside the opening.
const windowGroup = new THREE.Group();
const frameThickness = 0.08;
const frameDepth = 0.12;
[
    { size: [frameDepth, frameThickness, WINDOW.width + frameThickness * 2], pos: [0, WINDOW.height / 2 + frameThickness / 2, 0] },
    { size: [frameDepth, frameThickness, WINDOW.width + frameThickness * 2], pos: [0, -WINDOW.height / 2 - frameThickness / 2, 0] },
    { size: [frameDepth, WINDOW.height, frameThickness], pos: [0, 0, WINDOW.width / 2 + frameThickness / 2] },
    { size: [frameDepth, WINDOW.height, frameThickness], pos: [0, 0, -WINDOW.width / 2 - frameThickness / 2] },
    { size: [frameDepth * 0.6, WINDOW.height, frameThickness * 0.5], pos: [0, 0, 0] }
].forEach(({ size, pos }) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(...size), trimMaterial);
    bar.position.set(...pos);
    windowGroup.add(bar);
});

// A plain bright panel outside the glass, so the opening reads as daylight
// rather than a hole onto the clear colour.
const skyPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(WINDOW.width, WINDOW.height),
    new THREE.MeshBasicMaterial({ color: 0xbcd8f5 })
);
skyPanel.rotation.y = -Math.PI / 2;
skyPanel.position.x = -0.1;
windowGroup.add(skyPanel);

windowGroup.position.set(-halfW, WINDOW.sill + WINDOW.height / 2, 0);
roomGroup.add(windowGroup);

// 1. Rug — lifted clear of the floor plane to avoid z-fighting.
const rugGeometry = new THREE.CircleGeometry(4, 32);
const rugMaterial = new THREE.MeshStandardMaterial({ color: 0x885544, roughness: 0.9 });
const rug = new THREE.Mesh(rugGeometry, rugMaterial);
rug.rotation.x = -Math.PI / 2;
rug.position.y = 0.005;
rug.receiveShadow = true;
roomGroup.add(rug);

// 2. Armchair
const chairMaterial = new THREE.MeshStandardMaterial({ color: 0xccaa88 });
const chairGroup = new THREE.Group();
roomGroup.add(chairGroup);

const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.8), chairMaterial);
seat.position.set(0, 0.4, 0);
chairGroup.add(seat);

const back = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.1), chairMaterial);
back.position.set(0, 0.9, -0.35);
chairGroup.add(back);

const armGeo = new THREE.BoxGeometry(0.1, 0.4, 0.8);
const armL = new THREE.Mesh(armGeo, chairMaterial);
armL.position.set(-0.35, 0.6, 0);
chairGroup.add(armL);

const armR = new THREE.Mesh(armGeo, chairMaterial);
armR.position.set(0.35, 0.6, 0);
chairGroup.add(armR);

const legGeo = new THREE.CylinderGeometry(0.04, 0.02, 0.3);
const legMat = new THREE.MeshStandardMaterial({ color: 0x553322 });
const positions = [
    [-0.35, 0.15, 0.35], [0.35, 0.15, 0.35],
    [-0.35, 0.15, -0.35], [0.35, 0.15, -0.35]
];
positions.forEach(pos => {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(...pos);
    chairGroup.add(leg);
});

chairGroup.position.set(-1, 0, 1);
chairGroup.rotation.y = 0.5;

// 3. Side Table
const tableGroup = new THREE.Group();
const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 32), legMat);
tableTop.position.set(0, 0.6, 0);
tableGroup.add(tableTop);
const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6), legMat);
tableLeg.position.set(0, 0.3, 0);
tableGroup.add(tableLeg);

tableGroup.position.set(1.2, 0, -0.5);
roomGroup.add(tableGroup);

// 4. Lamp
const lampGroup = new THREE.Group();
const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.5), new THREE.MeshStandardMaterial({ color: 0x222222 }));
lampPole.position.set(0, 0.75, 0);
lampGroup.add(lampPole);
const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.3, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xffffee, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
lampShade.position.set(0, 1.5, 0);
lampGroup.add(lampShade);

lampGroup.position.copy(lampLight.position);
lampGroup.position.y = 0;
roomGroup.add(lampGroup);

// 5. Plant
const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.1, 0.25), new THREE.MeshStandardMaterial({ color: 0xcc5522 }));
pot.position.set(0, 0.75, 0);
tableGroup.add(pot);

const plantGeo = new THREE.DodecahedronGeometry(0.15);
const plantMat = new THREE.MeshStandardMaterial({ color: 0x44aa44 });
const plant = new THREE.Mesh(plantGeo, plantMat);
plant.position.set(0, 0.95, 0);
tableGroup.add(plant);

// --- Shadows ---
// Every mesh in the room receives. Furniture also casts; the shell itself does
// not, because single-sided planes casting onto themselves produce acne, and
// the sky panel is unlit by design.
const shellMeshes = new Set([northWall, southWall, eastWall, westWall, floor, ceiling, skyPanel]);
roomGroup.traverse(obj => {
    if (!obj.isMesh) return;
    obj.receiveShadow = obj !== skyPanel;
    obj.castShadow = !shellMeshes.has(obj);
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

function showLoadError(msg) {
    console.error(msg);
    const info = document.getElementById('info');
    if (info) info.innerHTML = `<p>Could not load the avatar.</p><p>${msg}</p>`;
}

loader.load(avatarUrl, (gltf) => {
    avatar = gltf.scene;
    avatar.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });
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
        for (const source of session.inputSources) {
            if (source.gamepad) {
                const axes = source.gamepad.axes;
                // Standard mapping: 0,1 for thumbstick
                if (source.handedness === 'left') {
                    if (Math.abs(axes[3] || axes[1]) > 0.1) moveForward -= (axes[3] || axes[1]);
                }
                if (source.handedness === 'right') {
                    if (Math.abs(axes[2] || axes[0]) > 0.1) turn -= (axes[2] || axes[0]);
                }
            }
        }
    }

    const forward = new THREE.Vector3(0, 0, avatarForwardZ).applyQuaternion(avatar.quaternion);

    if (moveForward !== 0) {
        avatar.position.addScaledVector(forward, moveForward * avatarSpeed * dt);
        // Keep the avatar inside the shell now that there are walls to hit.
        const limitX = ROOM.width / 2 - 0.5;
        const limitZ = ROOM.depth / 2 - 0.5;
        avatar.position.x = THREE.MathUtils.clamp(avatar.position.x, -limitX, limitX);
        avatar.position.z = THREE.MathUtils.clamp(avatar.position.z, -limitZ, limitZ);
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
    } else {
        // Desktop follow cam: sit behind the avatar's back and above it, so the
        // camera swings around as the avatar turns instead of staring it down.
        // Skip the reposition while the user is dragging, so orbiting still works.
        if (!userIsOrbiting) {
            cameraTarget.copy(avatar.position).addScaledVector(forward, -followDistance);
            cameraTarget.y += followHeight;
            camera.position.lerp(cameraTarget, 0.1);
        }
        lookTarget.copy(avatar.position);
        lookTarget.y += followLookHeight;
        controls.target.lerp(lookTarget, 0.1);
        controls.update();
    }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    updateAvatar(clock.getDelta());
    updateDebugPanel();
    renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
