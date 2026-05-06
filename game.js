import * as THREE from 'three';

// ============================================================================
// Constants
// ============================================================================
const CAR = {
    L: 4.4, W: 1.85, H: 1.5,
    WHEELBASE: 2.55,
    WHEEL_R: 0.32, WHEEL_W: 0.22,
};

const SPOT_W = 2.6;
const SPOT_L = 5.6;

const PHYSICS = {
    ACCEL: 7,
    REVERSE_ACCEL: 5,
    BRAKE: 14,
    HANDBRAKE: 26,
    DRAG: 1.4,
    MAX_SPEED: 8.5,
    MAX_REVERSE: -4.5,
    MAX_STEER: 0.55,
    STEER_SPEED: 3.4,
    STEER_RETURN: 4.5,
    PARK_SPEED_MAX: 0.35,
    PARK_HOLD_TIME: 1.2,
    CONTACT_COOLDOWN: 0.18,
};

const COLORS = {
    PLAYER: 0xfbbf24,
    STATIC: [0x4a5568, 0x2c4a6e, 0x6b1d24, 0x2e3947, 0x6c7280, 0x44514a, 0x404a5c, 0x603a40, 0xa6b3c0, 0x3a4a5c],
    ASPHALT: 0x2a2d33,
    GRASS: 0x4a6440,
    SPOT_LINE: 0xeef2f7,
    LANE_LINE: 0xf1c454,
    TARGET: 0x22d3ee,
    CURB: 0x9aa3ad,
};

// ============================================================================
// Supabase config
// ============================================================================
const SUPABASE_URL = 'https://yfrtgfvxhlzkuprmoluw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_caxGpS3lEkK_XCo6aqG6eA_RVw_GSBS';
const GAME_ID = 'parkit';
const LEADERBOARD_TABLE = 'leaderboards';

async function fetchTopScores(limit = 5) {
    try {
        const url = `${SUPABASE_URL}/rest/v1/${LEADERBOARD_TABLE}?game_id=eq.${GAME_ID}&select=player_name,score,created_at&order=score.desc&limit=${limit}`;
        const res = await fetch(url, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error('fetch failed: ' + res.status + ' ' + body);
        }
        const rows = await res.json();
        return rows.map(r => ({ name: r.player_name, score: r.score, created_at: r.created_at }));
    } catch (e) {
        console.warn('leaderboard fetch failed', e);
        return null;
    }
}

async function submitScore(name, score) {
    try {
        const url = `${SUPABASE_URL}/rest/v1/${LEADERBOARD_TABLE}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify({ game_id: GAME_ID, player_name: name, score }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error('submit failed: ' + res.status + ' ' + body);
        }
        return true;
    } catch (e) {
        console.warn('leaderboard submit failed', e);
        return false;
    }
}

// ============================================================================
// State
// ============================================================================
const state = {
    mode: 'title',
    levelIdx: 0,
    time: 0,
    bumps: 0,
    cameraMode: 0,
    parkProgress: 0,
    parkHoldTime: 0,
    target: null,
    targetMesh: null,
    staticCars: [],
    walls: [],
    lotMeshes: [],
    levelStars: [],
    totalTime: 0,
    totalBumps: 0,
    fadeIn: 0,
    submittedScore: -1,
};

const keys = {};

// Touch state for mobile controls
const touch = {
    steer: 0,        // -1..+1
    throttle: 0,     // 0 or 1
    brake: 0,        // 0 or 1
    handbrake: false,
    wheelTouchId: null,
    wheelStartAngle: 0,
    wheelStartX: 0,
    wheelLogicalAngle: 0, // -90..+90 deg
};

// ============================================================================
// Math helpers
// ============================================================================
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function shortAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

function obbCorners(o) {
    const fx = Math.sin(o.heading), fz = Math.cos(o.heading);
    const sx = Math.cos(o.heading), sz = -Math.sin(o.heading);
    const hl = o.l / 2, hw = o.w / 2;
    return [
        { x: o.x + fx * hl + sx * hw, z: o.z + fz * hl + sz * hw },
        { x: o.x + fx * hl - sx * hw, z: o.z + fz * hl - sz * hw },
        { x: o.x - fx * hl - sx * hw, z: o.z - fz * hl - sz * hw },
        { x: o.x - fx * hl + sx * hw, z: o.z - fz * hl + sz * hw },
    ];
}
function obbAxes(o) {
    return [
        { x: Math.sin(o.heading), z: Math.cos(o.heading) },
        { x: Math.cos(o.heading), z: -Math.sin(o.heading) },
    ];
}
function projectCorners(corners, axis) {
    let mn = Infinity, mx = -Infinity;
    for (const c of corners) {
        const d = c.x * axis.x + c.z * axis.z;
        if (d < mn) mn = d;
        if (d > mx) mx = d;
    }
    return [mn, mx];
}
function obbCollide(a, b) {
    const ca = obbCorners(a), cb = obbCorners(b);
    const axes = [...obbAxes(a), ...obbAxes(b)];
    let bestAxis = null, bestDepth = Infinity;
    for (const ax of axes) {
        const [aMin, aMax] = projectCorners(ca, ax);
        const [bMin, bMax] = projectCorners(cb, ax);
        if (aMax < bMin || bMax < aMin) return null;
        const overlap = Math.min(aMax - bMin, bMax - aMin);
        if (overlap < bestDepth) { bestDepth = overlap; bestAxis = ax; }
    }
    const dx = a.x - b.x, dz = a.z - b.z;
    const sign = (dx * bestAxis.x + dz * bestAxis.z) < 0 ? -1 : 1;
    return { mtv: { x: bestAxis.x * bestDepth * sign, z: bestAxis.z * bestDepth * sign }, depth: bestDepth };
}
function pointToObbDist(px, pz, o) {
    const dx = px - o.x, dz = pz - o.z;
    const fx = Math.sin(o.heading), fz = Math.cos(o.heading);
    const sx = Math.cos(o.heading), sz = -Math.sin(o.heading);
    const lf = dx * fx + dz * fz;
    const ls = dx * sx + dz * sz;
    const hl = o.l / 2, hw = o.w / 2;
    const cf = clamp(lf, -hl, hl), cs = clamp(ls, -hw, hw);
    const ddx = lf - cf, ddz = ls - cs;
    return Math.hypot(ddx, ddz);
}

// ============================================================================
// Three.js scene
// ============================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8d8ee);
scene.fog = new THREE.Fog(0xb8d8ee, 90, 260);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.insertBefore(renderer.domElement, document.body.firstChild);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
const cameraPos = new THREE.Vector3(0, 25, 12);
const cameraLook = new THREE.Vector3(0, 0, 0);
camera.position.copy(cameraPos);
camera.lookAt(cameraLook);

scene.add(new THREE.HemisphereLight(0xc8e0ff, 0x4a5460, 0.65));
const sun = new THREE.DirectionalLight(0xfff4dc, 1.25);
sun.position.set(40, 80, -25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0005;
scene.add(sun);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// Audio
// ============================================================================
let audioCtx = null, masterGain, engineOsc, engineFilter, engineGain;
let audioReady = false;
let lastBeepTime = 0;

function ensureAudio() {
    if (audioReady) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.3;
        masterGain.connect(audioCtx.destination);
        engineOsc = audioCtx.createOscillator();
        engineOsc.type = 'sawtooth';
        engineOsc.frequency.value = 60;
        engineFilter = audioCtx.createBiquadFilter();
        engineFilter.type = 'lowpass';
        engineFilter.frequency.value = 600;
        engineFilter.Q.value = 1.2;
        engineGain = audioCtx.createGain();
        engineGain.gain.value = 0;
        engineOsc.connect(engineFilter);
        engineFilter.connect(engineGain);
        engineGain.connect(masterGain);
        engineOsc.start();
        audioReady = true;
    } catch (e) {}
}
function setEngine(speed) {
    if (!audioReady) return;
    const ratio = Math.min(1, Math.abs(speed) / PHYSICS.MAX_SPEED);
    const target = state.mode === 'playing' ? (0.04 + 0.06 * ratio) : 0;
    engineGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.08);
    engineOsc.frequency.setTargetAtTime(58 + 130 * ratio, audioCtx.currentTime, 0.08);
}
function playBeep(pitch = 800, dur = 0.06, vol = 0.12) {
    if (!audioReady) return;
    const osc = audioCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = pitch;
    const g = audioCtx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.005);
    g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + dur);
    osc.connect(g); g.connect(masterGain);
    osc.start(); osc.stop(audioCtx.currentTime + dur + 0.02);
}
function playThud() {
    if (!audioReady) return;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.3, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.18));
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const filt = audioCtx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 220;
    const g = audioCtx.createGain(); g.gain.value = 0.45;
    src.connect(filt); filt.connect(g); g.connect(masterGain);
    src.start();
}
function playChime() {
    if (!audioReady) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
        setTimeout(() => {
            const osc = audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = f;
            const g = audioCtx.createGain();
            g.gain.value = 0;
            const t = audioCtx.currentTime;
            g.gain.linearRampToValueAtTime(0.18, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
            osc.connect(g); g.connect(masterGain);
            osc.start(); osc.stop(t + 0.5);
        }, i * 90);
    });
}
function updateProximityAudio(minDist) {
    if (state.mode !== 'playing' || !audioReady) return;
    if (minDist > 1.5) return;
    const t = audioCtx.currentTime;
    const interval = 0.08 + 0.55 * (minDist / 1.5);
    if (t - lastBeepTime > interval) {
        const pitch = minDist < 0.5 ? 1200 : minDist < 1.0 ? 950 : 780;
        playBeep(pitch, 0.05, 0.08);
        lastBeepTime = t;
    }
}

// ============================================================================
// Car mesh builder
// ============================================================================
function buildCarMesh(color, isPlayer = false) {
    const group = new THREE.Group();
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0x1d2129, roughness: 0.9 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(CAR.W * 1.02, 0.14, CAR.L * 0.96), chassisMat);
    chassis.position.y = 0.32;
    chassis.receiveShadow = true;
    group.add(chassis);

    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.55 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(CAR.W, 0.55, CAR.L * 0.96), bodyMat);
    body.position.y = 0.66;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const hoodMat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.55 });
    const hood = new THREE.Mesh(new THREE.BoxGeometry(CAR.W * 0.96, 0.42, CAR.L * 0.32), hoodMat);
    hood.position.set(0, 0.84, CAR.L * 0.31);
    hood.castShadow = true;
    group.add(hood);

    const trunk = new THREE.Mesh(new THREE.BoxGeometry(CAR.W * 0.96, 0.42, CAR.L * 0.28), hoodMat);
    trunk.position.set(0, 0.84, -CAR.L * 0.33);
    trunk.castShadow = true;
    group.add(trunk);

    const cabinMat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.5 });
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(CAR.W * 0.92, 0.55, CAR.L * 0.5), cabinMat);
    cabin.position.set(0, 1.16, -0.05);
    cabin.castShadow = true;
    group.add(cabin);

    const winMat = new THREE.MeshStandardMaterial({ color: 0x0e151f, roughness: 0.15, metalness: 0.85, transparent: true, opacity: 0.78 });
    const wins = new THREE.Mesh(new THREE.BoxGeometry(CAR.W * 0.93, 0.46, CAR.L * 0.5 * 0.95), winMat);
    wins.position.set(0, 1.16, -0.05);
    group.add(wins);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(CAR.W * 0.9, 0.05, CAR.L * 0.46), bodyMat);
    roof.position.set(0, 1.46, -0.05);
    roof.castShadow = true;
    group.add(roof);

    const hlMat = new THREE.MeshStandardMaterial({ color: 0xfff8d8, emissive: 0xfff5b8, emissiveIntensity: 0.35 });
    for (const x of [-0.6, 0.6]) {
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.08), hlMat);
        hl.position.set(x, 0.74, CAR.L * 0.477);
        group.add(hl);
    }
    const tlMat = new THREE.MeshStandardMaterial({ color: 0xff3344, emissive: 0xaa1122, emissiveIntensity: 0.55 });
    const tlMeshes = [];
    for (const x of [-0.62, 0.62]) {
        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.15, 0.07), tlMat);
        tl.position.set(x, 0.74, -CAR.L * 0.477);
        group.add(tl); tlMeshes.push(tl);
    }
    const revMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0 });
    const reverseLight = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.05), revMat);
    reverseLight.position.set(0, 0.6, -CAR.L * 0.477);
    group.add(reverseLight);

    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.95 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.7 });
    const wheelGeom = new THREE.CylinderGeometry(CAR.WHEEL_R, CAR.WHEEL_R, CAR.WHEEL_W, 16);
    wheelGeom.rotateZ(Math.PI / 2);
    const rimGeom = new THREE.CylinderGeometry(CAR.WHEEL_R * 0.55, CAR.WHEEL_R * 0.55, CAR.WHEEL_W * 1.02, 12);
    rimGeom.rotateZ(Math.PI / 2);
    const wheels = {};
    const wbHalf = CAR.WHEELBASE / 2;
    for (const [name, x, z] of [['fl', -CAR.W/2, wbHalf], ['fr', CAR.W/2, wbHalf], ['rl', -CAR.W/2, -wbHalf], ['rr', CAR.W/2, -wbHalf]]) {
        const wg = new THREE.Group();
        const tire = new THREE.Mesh(wheelGeom, wheelMat); tire.castShadow = true;
        const rim = new THREE.Mesh(rimGeom, rimMat);
        wg.add(tire); wg.add(rim);
        wg.position.set(x, CAR.WHEEL_R, z);
        group.add(wg); wheels[name] = wg;
    }

    if (isPlayer) {
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0x0d121e, roughness: 0.5 });
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, CAR.L * 0.95), stripeMat);
        stripe.position.set(0, 0.95, 0);
        group.add(stripe);
    }

    return { group, wheels, tlMeshes, reverseLight };
}

// ============================================================================
// Player car
// ============================================================================
class PlayerCar {
    constructor() {
        const built = buildCarMesh(COLORS.PLAYER, true);
        this.mesh = built.group;
        this.wheels = built.wheels;
        this.tlMeshes = built.tlMeshes;
        this.reverseLight = built.reverseLight;
        scene.add(this.mesh);
        this.x = 0; this.z = 0;
        this.heading = 0;
        this.speed = 0;
        this.steerAngle = 0;
        this.wheelRot = 0;
        this.brakeOn = false;
        this.contactCooldown = 0;
        this.lastSafePosition = { x: 0, z: 0, heading: 0 };
    }
    reset(x, z, heading) {
        this.x = x; this.z = z;
        this.heading = heading;
        this.speed = 0;
        this.steerAngle = 0;
        this.lastSafePosition = { x, z, heading };
        this.syncMesh();
    }
    update(dt, throttle, brakeReverse, steerInput, handbrake) {
        const targetSteer = steerInput * PHYSICS.MAX_STEER;
        if (Math.abs(steerInput) < 0.02) {
            const ret = PHYSICS.STEER_RETURN * dt;
            if (Math.abs(this.steerAngle) <= ret) this.steerAngle = 0;
            else this.steerAngle -= Math.sign(this.steerAngle) * ret;
        } else {
            const maxDelta = PHYSICS.STEER_SPEED * dt;
            this.steerAngle += clamp(targetSteer - this.steerAngle, -maxDelta, maxDelta);
        }

        const speedFrac = Math.min(1, Math.abs(this.speed) / PHYSICS.MAX_SPEED);
        const effSteer = this.steerAngle * (1 - 0.4 * speedFrac);

        let isBraking = false;
        if (throttle > 0) {
            this.speed += PHYSICS.ACCEL * throttle * dt;
        } else if (brakeReverse > 0) {
            if (this.speed > 0.05) { this.speed -= PHYSICS.BRAKE * brakeReverse * dt; isBraking = true; }
            else this.speed -= PHYSICS.REVERSE_ACCEL * brakeReverse * dt;
        } else {
            const sg = Math.sign(this.speed);
            this.speed -= sg * PHYSICS.DRAG * dt;
            if (Math.abs(this.speed) < PHYSICS.DRAG * dt) this.speed = 0;
        }
        if (handbrake) {
            const sg = Math.sign(this.speed);
            this.speed -= sg * PHYSICS.HANDBRAKE * dt;
            if (Math.abs(this.speed) < 0.15) this.speed = 0;
            isBraking = true;
        }
        this.speed = clamp(this.speed, PHYSICS.MAX_REVERSE, PHYSICS.MAX_SPEED);
        this.brakeOn = isBraking;

        const dh = (this.speed / CAR.WHEELBASE) * Math.tan(effSteer);
        this.heading += dh * dt;

        const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
        this.x += this.speed * fx * dt;
        this.z += this.speed * fz * dt;

        this.wheelRot += this.speed * dt / CAR.WHEEL_R;
        for (const name of ['fl', 'fr', 'rl', 'rr']) {
            for (const child of this.wheels[name].children) child.rotation.x = this.wheelRot;
        }
        this.wheels.fl.rotation.y = this.steerAngle;
        this.wheels.fr.rotation.y = this.steerAngle;

        const brakeI = isBraking ? 1.4 : 0.55;
        for (const tl of this.tlMeshes) tl.material.emissiveIntensity = brakeI;
        this.reverseLight.material.emissiveIntensity = this.speed < -0.15 ? 0.9 : 0;

        if (this.contactCooldown > 0) this.contactCooldown -= dt;

        this.syncMesh();
    }
    syncMesh() {
        this.mesh.position.set(this.x, 0, this.z);
        this.mesh.rotation.y = this.heading;
    }
    get obb() { return { x: this.x, z: this.z, w: CAR.W, l: CAR.L, heading: this.heading }; }
    get speedKmh() { return Math.abs(this.speed) * 3.6; }
}

// ============================================================================
// Static car
// ============================================================================
class StaticCar {
    constructor(x, z, heading, color) {
        this.x = x; this.z = z; this.heading = heading;
        const built = buildCarMesh(color);
        this.mesh = built.group;
        this.mesh.position.set(x, 0, z);
        this.mesh.rotation.y = heading;
        scene.add(this.mesh);
    }
    get obb() { return { x: this.x, z: this.z, w: CAR.W, l: CAR.L, heading: this.heading }; }
    dispose() {
        scene.remove(this.mesh);
        this.mesh.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
    }
}

// ============================================================================
// Lot helpers
// ============================================================================
function makeSpotOutline(x, z, heading, w, l, color = COLORS.SPOT_LINE, lineW = 0.12, openSide = 'front') {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color });
    const segs = [];
    if (openSide !== 'back') segs.push({ ox: 0, oz: -l/2, sw: w + lineW, sl: lineW });
    if (openSide !== 'front') segs.push({ ox: 0, oz: l/2, sw: w + lineW, sl: lineW });
    segs.push({ ox: -w/2, oz: 0, sw: lineW, sl: l });
    segs.push({ ox: w/2, oz: 0, sw: lineW, sl: l });
    for (const s of segs) {
        const g = new THREE.PlaneGeometry(s.sw, s.sl);
        const m = new THREE.Mesh(g, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(s.ox, 0.005, s.oz);
        m.receiveShadow = true;
        group.add(m);
    }
    group.position.set(x, 0, z);
    group.rotation.y = heading;
    return group;
}

function makeTargetMarker(target) {
    const group = new THREE.Group();
    const w = target.w || SPOT_W;
    const l = target.l || SPOT_L;
    const fillMat = new THREE.MeshBasicMaterial({ color: COLORS.TARGET, transparent: true, opacity: 0.18, depthWrite: false });
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, l), fillMat);
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.012;
    group.add(fill);
    const edgeMat = new THREE.MeshBasicMaterial({ color: COLORS.TARGET });
    const edgeW = 0.18;
    const segs = [
        { ox: 0, oz: -l/2, sw: w + edgeW * 2, sl: edgeW },
        { ox: 0, oz: l/2, sw: w + edgeW * 2, sl: edgeW },
        { ox: -w/2, oz: 0, sw: edgeW, sl: l },
        { ox: w/2, oz: 0, sw: edgeW, sl: l },
    ];
    for (const s of segs) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(s.sw, s.sl), edgeMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(s.ox, 0.018, s.oz);
        group.add(m);
    }
    const arrowMat = new THREE.MeshBasicMaterial({ color: COLORS.TARGET });
    for (let i = 0; i < 2; i++) {
        const g = new THREE.BufferGeometry();
        const z0 = l/2 + 0.7 + i * 0.55;
        const verts = new Float32Array([
            -0.55, 0, z0,
            0.55, 0, z0,
            0, 0, z0 - 0.45,
        ]);
        g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        g.setIndex([0, 1, 2]);
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, arrowMat);
        m.position.y = 0.02;
        group.add(m);
    }
    group.userData.fillMat = fillMat;
    group.userData.edgeMat = edgeMat;
    group.userData.arrowMat = arrowMat;
    group.position.set(target.x, 0, target.z);
    group.rotation.y = target.heading;
    return group;
}

function makeWall(x, z, heading, w, l) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.CURB, roughness: 0.85 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, l), mat);
    m.position.set(0, 0.2, 0);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * 1.005, 0.04, l * 1.005), new THREE.MeshStandardMaterial({ color: COLORS.LANE_LINE, roughness: 0.6 }));
    stripe.position.y = 0.41;
    group.add(stripe);
    group.position.set(x, 0, z);
    group.rotation.y = heading;
    return { mesh: group, obb: { x, z, w, l, heading } };
}

function clearLot() {
    for (const m of state.lotMeshes) {
        scene.remove(m);
        m.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => mt.dispose());
        });
    }
    state.lotMeshes.length = 0;
    for (const sc of state.staticCars) sc.dispose();
    state.staticCars.length = 0;
    state.walls.length = 0;
    state.target = null;
    state.targetMesh = null;
}

function buildLot(level) {
    clearLot();
    const lot = level.lot;
    const asphalt = new THREE.Mesh(
        new THREE.PlaneGeometry(lot.w, lot.l, 1, 1),
        new THREE.MeshStandardMaterial({ color: COLORS.ASPHALT, roughness: 0.92 })
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.set(lot.x, 0, lot.z);
    asphalt.receiveShadow = true;
    scene.add(asphalt);
    state.lotMeshes.push(asphalt);

    const grass = new THREE.Mesh(
        new THREE.PlaneGeometry(420, 420),
        new THREE.MeshStandardMaterial({ color: COLORS.GRASS, roughness: 1 })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    grass.receiveShadow = true;
    scene.add(grass);
    state.lotMeshes.push(grass);

    const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.LANE_LINE });
    for (const e of [
        { x: lot.x, z: lot.z - lot.l/2, w: lot.w, l: 0.18 },
        { x: lot.x, z: lot.z + lot.l/2, w: lot.w, l: 0.18 },
        { x: lot.x - lot.w/2, z: lot.z, w: 0.18, l: lot.l },
        { x: lot.x + lot.w/2, z: lot.z, w: 0.18, l: lot.l },
    ]) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(e.w, e.l), lineMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(e.x, 0.004, e.z);
        scene.add(m);
        state.lotMeshes.push(m);
    }

    if (level.spots) {
        for (const spot of level.spots) {
            const outline = makeSpotOutline(spot.x, spot.z, spot.heading, spot.w || SPOT_W, spot.l || SPOT_L, COLORS.SPOT_LINE, 0.1, spot.open || 'front');
            scene.add(outline);
            state.lotMeshes.push(outline);
        }
    }

    for (let i = 0; i < level.cars.length; i++) {
        const c = level.cars[i];
        const color = COLORS.STATIC[i % COLORS.STATIC.length];
        const sc = new StaticCar(c.x, c.z, c.heading, color);
        state.staticCars.push(sc);
    }

    if (level.walls) {
        for (const w of level.walls) {
            const wo = makeWall(w.x, w.z, w.heading || 0, w.w, w.l);
            scene.add(wo.mesh);
            state.lotMeshes.push(wo.mesh);
            state.walls.push(wo.obb);
        }
    }

    state.target = level.target;
    state.targetMesh = makeTargetMarker(level.target);
    scene.add(state.targetMesh);
    state.lotMeshes.push(state.targetMesh);

    player.reset(level.player.x, level.player.z, level.player.heading);
}

// ============================================================================
// Levels
// ============================================================================
const PI = Math.PI;
const LEVELS = [
    {
        name: 'First Steps',
        hint: 'Drive forward into the highlighted spot. Stop with the car centered.',
        timeGold: 22, timeSilver: 40,
        lot: { x: 0, z: -2, w: 60, l: 36 },
        player: { x: 0, z: 11, heading: PI },
        target: { x: 0, z: -3, heading: PI, w: SPOT_W, l: SPOT_L },
        cars: [
            { x: -7.8, z: -3, heading: PI }, { x: -5.2, z: -3, heading: PI },
            { x: -2.6, z: -3, heading: PI }, { x: 2.6, z: -3, heading: PI },
            { x: 5.2, z: -3, heading: PI }, { x: 7.8, z: -3, heading: PI },
        ],
        spots: [
            { x: -7.8, z: -3, heading: PI }, { x: -5.2, z: -3, heading: PI },
            { x: -2.6, z: -3, heading: PI }, { x: 0, z: -3, heading: PI },
            { x: 2.6, z: -3, heading: PI }, { x: 5.2, z: -3, heading: PI },
            { x: 7.8, z: -3, heading: PI },
        ],
    },
    {
        name: 'Mind the Gap',
        hint: 'Slot in straight. Watch the proximity sensors on the sides.',
        timeGold: 28, timeSilver: 50,
        lot: { x: 0, z: -2, w: 60, l: 36 },
        player: { x: -16, z: 7, heading: PI / 2 },
        target: { x: 4, z: -3, heading: PI, w: 2.45, l: SPOT_L },
        cars: [
            { x: -10.4, z: -3, heading: PI }, { x: -7.8, z: -3, heading: PI },
            { x: -5.2, z: -3, heading: PI }, { x: -2.6, z: -3, heading: PI },
            { x: 0, z: -3, heading: PI },
            // narrow painted bay at x=1.5 stays empty (too small for a car)
            { x: 6.55, z: -3, heading: PI }, { x: 9.15, z: -3, heading: PI },
        ],
        spots: [
            { x: -10.4, z: -3, heading: PI }, { x: -7.8, z: -3, heading: PI },
            { x: -5.2, z: -3, heading: PI }, { x: -2.6, z: -3, heading: PI },
            { x: 0, z: -3, heading: PI }, { x: 1.5, z: -3, heading: PI, w: 1.5 },
            { x: 4, z: -3, heading: PI, w: 2.45 },
            { x: 6.55, z: -3, heading: PI, w: 2.45 }, { x: 9.15, z: -3, heading: PI },
        ],
    },
    {
        name: 'Back It In',
        hint: 'Drive past the spot, then reverse in. Use S/↓ or BRAKE pedal to back up.',
        timeGold: 42, timeSilver: 70,
        lot: { x: 0, z: 0, w: 64, l: 40 },
        player: { x: -22, z: 6, heading: PI / 2 },
        target: { x: 0, z: -3, heading: 0, w: SPOT_W, l: SPOT_L },
        cars: [
            { x: -10.4, z: -3, heading: 0 }, { x: -7.8, z: -3, heading: 0 },
            { x: -5.2, z: -3, heading: 0 }, { x: -2.6, z: -3, heading: 0 },
            { x: 2.6, z: -3, heading: 0 }, { x: 5.2, z: -3, heading: 0 },
            { x: 7.8, z: -3, heading: 0 }, { x: 10.4, z: -3, heading: 0 },
        ],
        spots: [
            { x: -10.4, z: -3, heading: 0 }, { x: -7.8, z: -3, heading: 0 },
            { x: -5.2, z: -3, heading: 0 }, { x: -2.6, z: -3, heading: 0 },
            { x: 0, z: -3, heading: 0 },
            { x: 2.6, z: -3, heading: 0 }, { x: 5.2, z: -3, heading: 0 },
            { x: 7.8, z: -3, heading: 0 }, { x: 10.4, z: -3, heading: 0 },
        ],
        walls: [{ x: 0, z: -7, w: 60, l: 0.4 }],
    },
    {
        name: 'Parallel Parking',
        hint: 'Pull alongside, then S-curve in. Aim for the center of the gap.',
        timeGold: 50, timeSilver: 85,
        lot: { x: 0, z: -2, w: 64, l: 30 },
        player: { x: -18, z: 4.5, heading: PI / 2 },
        target: { x: 0, z: 1, heading: PI / 2, w: 2.4, l: 6.6 },
        cars: [
            { x: -7.5, z: 1, heading: PI / 2 },
            { x: 7.5, z: 1, heading: PI / 2 },
            { x: -14.5, z: 1, heading: PI / 2 },
            { x: 14.5, z: 1, heading: PI / 2 },
        ],
        spots: [
            { x: 0, z: 1, heading: PI / 2, w: 2.4, l: 6.6 },
        ],
        walls: [{ x: 0, z: 2.7, w: 60, l: 0.4 }],
    },
    {
        name: 'Crowded Lot',
        hint: 'Navigate the lanes carefully. The target is in the back row.',
        timeGold: 65, timeSilver: 110,
        lot: { x: 0, z: -2, w: 70, l: 50 },
        player: { x: -28, z: 18, heading: PI / 2 },
        target: { x: 5.2, z: -16, heading: 0, w: SPOT_W, l: SPOT_L },
        cars: (() => {
            const cars = [];
            for (const x of [-13, -10.4, -7.8, -5.2, -2.6, 0, 5.2, 7.8, 10.4, 13]) {
                cars.push({ x, z: -3, heading: PI });
            }
            for (const x of [-13, -10.4, -7.8, -5.2, -2.6, 0, 2.6, 7.8, 10.4, 13]) {
                cars.push({ x, z: -16, heading: 0 });
            }
            return cars;
        })(),
        spots: (() => {
            const spots = [];
            for (const x of [-13, -10.4, -7.8, -5.2, -2.6, 0, 2.6, 5.2, 7.8, 10.4, 13]) {
                spots.push({ x, z: -3, heading: PI });
                spots.push({ x, z: -16, heading: 0 });
            }
            return spots;
        })(),
        walls: [
            { x: 0, z: -20, w: 64, l: 0.4 },
        ],
    },
    // ========================================================================
    // L6: Diagonal Parking — angled spots at 45°
    // ========================================================================
    {
        name: 'Diagonal Park',
        hint: 'Approach the angled spot head-on along the diagonal. Heading matters!',
        timeGold: 35, timeSilver: 60,
        lot: { x: 0, z: 0, w: 70, l: 40 },
        player: { x: -22, z: 12, heading: PI / 2 },
        target: { x: 1, z: -2, heading: PI - PI / 4, w: SPOT_W, l: SPOT_L },
        cars: (() => {
            const cars = [];
            const angle = PI - PI / 4;
            const spacing = 3.6;
            for (let i = -3; i <= 3; i++) {
                if (i === 0) continue;
                cars.push({ x: 1 + i * spacing, z: -2 + i * 0.0, heading: angle });
            }
            return cars;
        })(),
        spots: (() => {
            const spots = [];
            const angle = PI - PI / 4;
            const spacing = 3.6;
            for (let i = -3; i <= 3; i++) {
                spots.push({ x: 1 + i * spacing, z: -2, heading: angle });
            }
            return spots;
        })(),
        walls: [{ x: 0, z: -8, w: 64, l: 0.4 }],
    },
    // ========================================================================
    // L7: Tight Squeeze — extremely narrow gap, both sides cars very close
    // ========================================================================
    {
        name: 'Tight Squeeze',
        hint: 'Centimeters to spare. Approach slowly and keep dead straight.',
        timeGold: 40, timeSilver: 75,
        lot: { x: 0, z: -2, w: 60, l: 36 },
        player: { x: 0, z: 11, heading: PI },
        target: { x: 0, z: -3, heading: PI, w: 2.15, l: SPOT_L },
        cars: [
            { x: -10.4, z: -3, heading: PI }, { x: -7.8, z: -3, heading: PI },
            { x: -5.2, z: -3, heading: PI },
            { x: -2.25, z: -3, heading: PI },
            { x: 2.25, z: -3, heading: PI },
            { x: 5.2, z: -3, heading: PI }, { x: 7.8, z: -3, heading: PI },
            { x: 10.4, z: -3, heading: PI },
        ],
        spots: [
            { x: -10.4, z: -3, heading: PI }, { x: -7.8, z: -3, heading: PI },
            { x: -5.2, z: -3, heading: PI },
            { x: -2.25, z: -3, heading: PI }, { x: 0, z: -3, heading: PI, w: 2.15 },
            { x: 2.25, z: -3, heading: PI },
            { x: 5.2, z: -3, heading: PI }, { x: 7.8, z: -3, heading: PI },
            { x: 10.4, z: -3, heading: PI },
        ],
    },
    // ========================================================================
    // L8: Reverse Parallel — parallel parking with cars on both sides + curb
    // ========================================================================
    {
        name: 'Reverse Parallel',
        hint: 'Pull past, reverse in at an angle, then straighten. Curb on your right!',
        timeGold: 55, timeSilver: 95,
        lot: { x: 0, z: -2, w: 70, l: 30 },
        player: { x: -22, z: 4.5, heading: PI / 2 },
        target: { x: 0, z: 1, heading: PI / 2, w: 2.35, l: 6.4 },
        cars: [
            { x: -7.4, z: 1, heading: PI / 2 },
            { x: 7.4, z: 1, heading: PI / 2 },
            { x: -14.5, z: 1, heading: PI / 2 },
            { x: 14.5, z: 1, heading: PI / 2 },
            { x: -21.5, z: 1, heading: PI / 2 },
        ],
        spots: [{ x: 0, z: 1, heading: PI / 2, w: 2.35, l: 6.4 }],
        walls: [
            { x: 0, z: 2.7, w: 64, l: 0.4 },
            { x: 0, z: -8, w: 64, l: 0.4 },
        ],
    },
    // ========================================================================
    // L9: The Maze — winding path through staggered rows
    // ========================================================================
    {
        name: 'The Maze',
        hint: 'Wind between the staggered rows. The target is deep in the back.',
        timeGold: 80, timeSilver: 130,
        lot: { x: 0, z: -4, w: 76, l: 60 },
        player: { x: -32, z: 22, heading: PI / 2 },
        target: { x: 12, z: -22, heading: 0, w: SPOT_W, l: SPOT_L },
        cars: (() => {
            const cars = [];
            // Row 1 at z=10 (front), gap at x=-15
            for (const x of [-25, -20, -10, -5, 0, 5, 10, 15, 20, 25]) {
                cars.push({ x, z: 10, heading: PI });
            }
            // Row 2 at z=2 (mid), gap at x=8
            for (const x of [-25, -20, -15, -10, -5, 0, 12, 18, 23]) {
                cars.push({ x, z: 2, heading: 0 });
            }
            // Row 3 at z=-10 (back front), gap at x=-3
            for (const x of [-25, -20, -15, -10, 3, 8, 14, 20, 25]) {
                cars.push({ x, z: -10, heading: PI });
            }
            // Back row at z=-22 surrounds target
            for (const x of [-25, -20, -15, -10, -5, 0, 5, 9.4, 14.6, 20, 25]) {
                cars.push({ x, z: -22, heading: 0 });
            }
            return cars;
        })(),
        spots: (() => {
            const spots = [];
            for (const x of [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25]) {
                spots.push({ x, z: 10, heading: PI });
                spots.push({ x, z: -10, heading: PI });
            }
            for (const x of [-25, -20, -15, -10, -5, 0, 6, 12, 18, 23]) {
                spots.push({ x, z: 2, heading: 0 });
            }
            for (const x of [-25, -20, -15, -10, -5, 0, 5, 9.4, 12, 14.6, 20, 25]) {
                spots.push({ x, z: -22, heading: 0 });
            }
            return spots;
        })(),
        walls: [{ x: 0, z: -27, w: 70, l: 0.4 }],
    },
    // ========================================================================
    // L10: Final Test — narrow reverse parallel in a very tight lot
    // ========================================================================
    {
        name: 'Final Test',
        hint: 'No room for error. Reverse parallel, narrow gap, perfect line.',
        timeGold: 100, timeSilver: 160,
        lot: { x: 0, z: -2, w: 64, l: 38 },
        player: { x: -18, z: 8, heading: PI / 2 },
        target: { x: 0, z: 1, heading: PI / 2, w: 2.25, l: 6.0 },
        cars: [
            // Parallel row in front of curb
            { x: -7.0, z: 1, heading: PI / 2 },
            { x: 7.0, z: 1, heading: PI / 2 },
            { x: -13.5, z: 1, heading: PI / 2 },
            { x: 13.5, z: 1, heading: PI / 2 },
            // Cars behind on the lane to constrain backing path
            { x: -7.8, z: -7, heading: 0 }, { x: -2.6, z: -7, heading: 0 },
            { x: 2.6, z: -7, heading: 0 }, { x: 7.8, z: -7, heading: 0 },
            { x: -13.0, z: -7, heading: 0 }, { x: 13.0, z: -7, heading: 0 },
            // Cars in front of target lane to make entry tight
            { x: -16, z: 8, heading: PI / 2 },
        ],
        spots: [
            { x: 0, z: 1, heading: PI / 2, w: 2.25, l: 6.0 },
        ],
        walls: [
            { x: 0, z: 2.7, w: 60, l: 0.4 },
            { x: 0, z: -11, w: 60, l: 0.4 },
        ],
    },
];

// ============================================================================
// Path preview
// ============================================================================
const PATH_POINTS = 36;
const pathGeom = new THREE.BufferGeometry();
const pathPositions = new Float32Array(PATH_POINTS * 3);
pathGeom.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3));
const pathMat = new THREE.LineBasicMaterial({ color: COLORS.TARGET, transparent: true, opacity: 0.7 });
const pathLine = new THREE.Line(pathGeom, pathMat);
scene.add(pathLine);

function updatePathPreview() {
    const baseSpeed = Math.abs(player.speed) > 0.5 ? player.speed : (Math.sign(player.speed) || 1) * 1.5;
    let x = player.x, z = player.z, h = player.heading;
    const dt = 0.06;
    const speedFrac = Math.min(1, Math.abs(player.speed) / PHYSICS.MAX_SPEED);
    const effSteer = player.steerAngle * (1 - 0.4 * speedFrac);
    for (let i = 0; i < PATH_POINTS; i++) {
        pathPositions[i*3] = x;
        pathPositions[i*3+1] = 0.025;
        pathPositions[i*3+2] = z;
        const dh = (baseSpeed / CAR.WHEELBASE) * Math.tan(effSteer);
        h += dh * dt;
        x += baseSpeed * Math.sin(h) * dt;
        z += baseSpeed * Math.cos(h) * dt;
    }
    pathGeom.attributes.position.needsUpdate = true;
    pathMat.color.setHex(player.speed < -0.3 ? COLORS.LANE_LINE : COLORS.TARGET);
    pathMat.opacity = state.mode === 'playing' ? (Math.abs(player.speed) > 0.2 || Math.abs(player.steerAngle) > 0.05 ? 0.75 : 0.25) : 0;
}

// ============================================================================
// Park detection
// ============================================================================
function computeParkScore() {
    if (!state.target) return { progress: 0, aligned: false, parked: false, alignment: 0 };
    const t = state.target;
    const tw = t.w || SPOT_W;
    const tl = t.l || SPOT_L;
    const dx = player.x - t.x, dz = player.z - t.z;
    const dist = Math.hypot(dx, dz);
    const angleDelta = Math.abs(shortAngle(player.heading - t.heading));
    const angleFlipped = Math.abs(shortAngle(player.heading - t.heading - PI));
    const angleErr = Math.min(angleDelta, angleFlipped);
    const corners = obbCorners(player.obb);
    let inside = 0;
    for (const c of corners) {
        const ddx = c.x - t.x, ddz = c.z - t.z;
        const fx = Math.sin(t.heading), fz = Math.cos(t.heading);
        const sx = Math.cos(t.heading), sz = -Math.sin(t.heading);
        const lf = ddx * fx + ddz * fz;
        const ls = ddx * sx + ddz * sz;
        if (Math.abs(lf) <= tl/2 + 0.05 && Math.abs(ls) <= tw/2 + 0.05) inside++;
    }
    const insideFrac = inside / 4;

    const ddx = (player.x - t.x);
    const ddz = (player.z - t.z);
    const fx = Math.sin(t.heading), fz = Math.cos(t.heading);
    const sx = Math.cos(t.heading), sz = -Math.sin(t.heading);
    const localF = ddx * fx + ddz * fz;
    const localS = ddx * sx + ddz * sz;
    const centerScore = clamp(1 - Math.hypot(localF / (tl/2), localS / (tw/2)), 0, 1);

    const angleScore = clamp(1 - angleErr / (PI / 6), 0, 1);
    const alignment = (insideFrac * 0.5 + centerScore * 0.3 + angleScore * 0.2);

    const aligned = insideFrac >= 1 && angleErr < PI / 12 && centerScore > 0.45;
    const stoppedEnough = Math.abs(player.speed) < PHYSICS.PARK_SPEED_MAX;
    const parked = aligned && stoppedEnough;
    return { progress: alignment, aligned, parked, alignment, dist, angleErr };
}

// ============================================================================
// Camera
// ============================================================================
const camDesired = new THREE.Vector3();
const camLookDesired = new THREE.Vector3();
let camShake = 0;
function shake(amt) { camShake = Math.max(camShake, amt); }
function updateCamera(dt) {
    if (state.cameraMode === 0) {
        camDesired.set(player.x, 24, player.z + 11);
        camLookDesired.set(player.x, 0, player.z);
    } else {
        const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
        camDesired.set(player.x - fx * 8, 4.5, player.z - fz * 8);
        camLookDesired.set(player.x + fx * 4, 1.2, player.z + fz * 4);
    }
    cameraPos.lerp(camDesired, 1 - Math.exp(-dt * 4.5));
    cameraLook.lerp(camLookDesired, 1 - Math.exp(-dt * 5));
    camera.position.copy(cameraPos);
    if (camShake > 0.005) {
        camera.position.x += (Math.random() - 0.5) * camShake;
        camera.position.y += (Math.random() - 0.5) * camShake * 0.6;
        camera.position.z += (Math.random() - 0.5) * camShake;
        camShake *= Math.exp(-dt * 5);
    }
    camera.lookAt(cameraLook);
}

// ============================================================================
// Collisions
// ============================================================================
function resolveCollisions() {
    const obstacles = [];
    for (const sc of state.staticCars) obstacles.push({ obb: sc.obb, kind: 'car' });
    for (const w of state.walls) obstacles.push({ obb: w, kind: 'wall' });
    for (const o of obstacles) {
        const res = obbCollide(player.obb, o.obb);
        if (!res) continue;
        player.x += res.mtv.x;
        player.z += res.mtv.z;
        const nLen = Math.hypot(res.mtv.x, res.mtv.z);
        if (nLen > 0) {
            const nx = res.mtv.x / nLen, nz = res.mtv.z / nLen;
            const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
            const fwdAlongN = fx * nx + fz * nz;
            if (Math.sign(player.speed) === Math.sign(fwdAlongN) && fwdAlongN !== 0) {
                player.speed *= 0.1;
            } else {
                player.speed *= 0.45;
            }
        }
        if (player.contactCooldown <= 0 && Math.abs(player.speed) > 0.4) {
            state.bumps++;
            shake(0.18);
            playThud();
            showHint('Bump! −1 star possible', 'warn', 1200);
        }
        player.contactCooldown = PHYSICS.CONTACT_COOLDOWN;
    }
    player.syncMesh();
}

// ============================================================================
// Proximity sensors
// ============================================================================
function getProximityDistances() {
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    const sx = Math.cos(player.heading), sz = -Math.sin(player.heading);
    const sensors = {
        front: { x: player.x + fx * (CAR.L/2 + 0.05), z: player.z + fz * (CAR.L/2 + 0.05) },
        back:  { x: player.x - fx * (CAR.L/2 + 0.05), z: player.z - fz * (CAR.L/2 + 0.05) },
        left:  { x: player.x - sx * (CAR.W/2 + 0.05), z: player.z - sz * (CAR.W/2 + 0.05) },
        right: { x: player.x + sx * (CAR.W/2 + 0.05), z: player.z + sz * (CAR.W/2 + 0.05) },
    };
    const out = {};
    for (const dir in sensors) {
        const s = sensors[dir];
        let m = Infinity;
        for (const sc of state.staticCars) m = Math.min(m, pointToObbDist(s.x, s.z, sc.obb));
        for (const w of state.walls) m = Math.min(m, pointToObbDist(s.x, s.z, w));
        out[dir] = m;
    }
    return out;
}

// ============================================================================
// HUD elements
// ============================================================================
const $ = id => document.getElementById(id);
const els = {
    hud: $('hud'),
    title: $('title-screen'),
    pause: $('pause-screen'),
    complete: $('complete-screen'),
    gameComplete: $('game-complete-screen'),
    leaderboardScreen: $('leaderboard-screen'),
    objective: $('objective-text'),
    levelNum: $('level-num'),
    levelTotal: $('level-total'),
    timeVal: $('time-val'),
    distanceVal: $('distance-val'),
    distanceCard: $('distance-card'),
    speedVal: $('speed-val'),
    gearVal: $('gear-val'),
    proxFront: $('prox-front'),
    proxBack: $('prox-back'),
    proxLeft: $('prox-left'),
    proxRight: $('prox-right'),
    targetArrow: $('target-arrow'),
    hintBanner: $('hint-banner'),
    parkMeter: $('park-meter'),
    parkBarFill: $('park-bar-fill'),
    meterPercent: $('meter-percent'),
    parkInstructions: $('park-instructions'),
    steerRotor: $('steer-rotor'),
    starsDisplay: $('stars-display'),
    finalTime: $('final-time'),
    finalBumps: $('final-bumps'),
    finalAlign: $('final-align'),
    completeTitle: $('complete-title'),
    toast: $('toast'),
    totalStarsDisplay: $('total-stars-display'),
    totalTime: $('total-time'),
    totalBumps: $('total-bumps'),
    totalStars: $('total-stars'),
    totalScore: $('total-score'),
    playerName: $('player-name'),
    titlePlayerName: $('title-player-name'),
    submitScoreBtn: $('submit-score-btn'),
    nameEntrySection: $('name-entry-section'),
    submittedAs: $('submitted-as'),
    submittedAsText: $('submitted-as-text'),
    editNameBtn: $('edit-name-btn'),
    completeLeaderboard: $('game-complete-leaderboard'),
    standaloneLeaderboard: $('standalone-leaderboard'),
    rotatePrompt: $('rotate-prompt'),
    touchWheel: $('touch-wheel'),
    touchWheelRotor: $('touch-wheel-rotor'),
    pedalAccel: $('pedal-accel'),
    pedalBrake: $('pedal-brake'),
    touchHandbrake: $('touch-handbrake'),
    touchCam: $('touch-cam'),
};

let toastTimer = null;
function showToast(text, kind = '', duration = 1400) {
    els.toast.textContent = text;
    els.toast.className = '';
    if (kind) els.toast.classList.add(kind);
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
}

let hintTimer = null;
function showHint(text, kind = '', duration = 2200) {
    els.hintBanner.innerHTML = text;
    els.hintBanner.classList.toggle('warn', kind === 'warn');
    els.hintBanner.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    if (duration) hintTimer = setTimeout(() => els.hintBanner.classList.remove('show'), duration);
}

function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function updateHUD(prox, parkScore) {
    els.timeVal.textContent = fmtTime(state.time);
    const tx = state.target.x, tz = state.target.z;
    const dist = Math.hypot(player.x - tx, player.z - tz);
    els.distanceVal.textContent = dist.toFixed(1);
    els.distanceCard.classList.toggle('close', dist < 4);
    els.speedVal.textContent = Math.round(player.speedKmh);
    if (parkScore.parked) {
        els.gearVal.textContent = 'P'; els.gearVal.className = 'gear park';
    } else if (player.speed < -0.15) {
        els.gearVal.textContent = 'R'; els.gearVal.className = 'gear reverse';
    } else if (Math.abs(player.speed) < 0.15) {
        els.gearVal.textContent = 'N'; els.gearVal.className = 'gear';
    } else {
        els.gearVal.textContent = 'D'; els.gearVal.className = 'gear';
    }
    function setArc(el, d) {
        el.classList.remove('warn', 'danger');
        if (d < 0.35) el.classList.add('danger');
        else if (d < 0.95) el.classList.add('warn');
    }
    setArc(els.proxFront, prox.front);
    setArc(els.proxBack, prox.back);
    setArc(els.proxLeft, prox.left);
    setArc(els.proxRight, prox.right);
    const steerDeg = (player.steerAngle / PHYSICS.MAX_STEER) * 90;
    els.steerRotor.setAttribute('transform', `rotate(${-steerDeg})`);

    // Touch wheel rotor follows actual steering angle (visual feedback even if user releases)
    if (els.touchWheelRotor) {
        els.touchWheelRotor.style.transform = `rotate(${-steerDeg}deg)`;
    }

    const tVec = new THREE.Vector3(tx, 0, tz).project(camera);
    const onScreen = tVec.x > -0.92 && tVec.x < 0.92 && tVec.y > -0.92 && tVec.y < 0.92 && tVec.z < 1;
    if (onScreen) {
        els.targetArrow.classList.remove('show');
    } else {
        els.targetArrow.classList.add('show');
        let nx = tVec.x, ny = tVec.y;
        if (tVec.z >= 1) { nx = -nx; ny = -ny; }
        const mag = Math.hypot(nx, ny);
        if (mag > 0) { nx /= mag; ny /= mag; }
        const margin = 90;
        const maxX = window.innerWidth / 2 - margin;
        const maxY = window.innerHeight / 2 - margin;
        const tx_ = Math.abs(nx) > 0.001 ? maxX / Math.abs(nx) : Infinity;
        const ty_ = Math.abs(ny) > 0.001 ? maxY / Math.abs(ny) : Infinity;
        const tt = Math.min(tx_, ty_);
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const ax = cx + nx * tt;
        const ay = cy - ny * tt;
        const ang = Math.atan2(-ny, nx) + Math.PI / 2;
        els.targetArrow.style.left = ax + 'px';
        els.targetArrow.style.top = ay + 'px';
        els.targetArrow.style.transform = `translate(-50%, -50%) rotate(${ang}rad)`;
    }

    if (dist < 7) {
        els.parkMeter.classList.add('show');
        const pct = Math.round(parkScore.alignment * 100);
        els.parkBarFill.style.width = pct + '%';
        els.meterPercent.textContent = pct + '%';
        let inst = 'Approach the spot';
        let ready = false;
        if (parkScore.aligned && Math.abs(player.speed) > PHYSICS.PARK_SPEED_MAX) {
            inst = 'Stop the car to lock it in';
        } else if (parkScore.aligned) {
            inst = `Holding park… ${(PHYSICS.PARK_HOLD_TIME - state.parkHoldTime).toFixed(1)}s`;
            ready = true;
        } else if (parkScore.alignment > 0.7) {
            inst = 'Almost there — straighten up';
        } else if (dist < 4) {
            inst = 'Center the car in the spot';
        }
        els.parkInstructions.textContent = inst;
        els.parkInstructions.classList.toggle('ready', ready);
    } else {
        els.parkMeter.classList.remove('show');
    }
}

function updateTargetPulse(time) {
    if (!state.targetMesh) return;
    const t = (Math.sin(time * 0.0035) + 1) * 0.5;
    state.targetMesh.userData.fillMat.opacity = 0.13 + 0.18 * t;
}

// ============================================================================
// State machine
// ============================================================================
function startGame() {
    state.levelStars = [];
    state.totalTime = 0;
    state.totalBumps = 0;
    state.levelIdx = 0;
    state.submittedScore = -1;
    loadLevel(0);
}
function loadLevel(idx) {
    state.levelIdx = idx;
    state.time = 0;
    state.bumps = 0;
    state.parkProgress = 0;
    state.parkHoldTime = 0;
    state.fadeIn = 1;
    const lv = LEVELS[idx];
    buildLot(lv);
    els.levelNum.textContent = (idx + 1).toString();
    els.levelTotal.textContent = LEVELS.length.toString();
    els.objective.textContent = lv.name;
    state.mode = 'playing';
    document.body.classList.add('playing');
    els.title.classList.add('hidden');
    els.pause.classList.add('hidden');
    els.complete.classList.add('hidden');
    els.gameComplete.classList.add('hidden');
    els.leaderboardScreen.classList.add('hidden');
    els.hud.classList.remove('hidden');
    showHint(lv.hint, '', 4500);
    showToast(`Level ${idx + 1}: ${lv.name}`, '', 1500);
}
function pauseGame() {
    if (state.mode !== 'playing') return;
    state.mode = 'paused';
    document.body.classList.remove('playing');
    els.pause.classList.remove('hidden');
}
function resumeGame() {
    if (state.mode !== 'paused') return;
    state.mode = 'playing';
    document.body.classList.add('playing');
    els.pause.classList.add('hidden');
}
function restartLevel() {
    els.pause.classList.add('hidden');
    els.complete.classList.add('hidden');
    loadLevel(state.levelIdx);
}
function backToMenu() {
    state.mode = 'title';
    document.body.classList.remove('playing');
    els.pause.classList.add('hidden');
    els.complete.classList.add('hidden');
    els.gameComplete.classList.add('hidden');
    els.hud.classList.add('hidden');
    els.title.classList.remove('hidden');
}
function completeLevel(parkScore) {
    state.mode = 'complete';
    document.body.classList.remove('playing');
    const lv = LEVELS[state.levelIdx];
    let stars = 1;
    const align = parkScore.alignment;
    const fastEnough = state.time <= lv.timeGold;
    const okTime = state.time <= lv.timeSilver;
    if (state.bumps === 0 && align >= 0.85 && fastEnough) stars = 3;
    else if (state.bumps <= 1 && align >= 0.7 && okTime) stars = 2;
    state.levelStars[state.levelIdx] = stars;
    state.totalTime += state.time;
    state.totalBumps += state.bumps;

    const starEls = els.starsDisplay.querySelectorAll('.star');
    starEls.forEach(s => s.classList.remove('filled'));
    let i = 0;
    const fillInterval = setInterval(() => {
        if (i < stars) starEls[i].classList.add('filled');
        i++;
        if (i >= stars) clearInterval(fillInterval);
    }, 250);

    els.completeTitle.textContent = stars === 3 ? 'Perfect Park!' : 'Parked!';
    els.finalTime.textContent = fmtTime(state.time);
    els.finalBumps.textContent = state.bumps.toString();
    els.finalAlign.textContent = Math.round(align * 100) + '%';
    els.complete.classList.remove('hidden');
    playChime();
}
function nextLevel() {
    els.complete.classList.add('hidden');
    if (state.levelIdx + 1 < LEVELS.length) {
        loadLevel(state.levelIdx + 1);
    } else {
        showGameComplete();
    }
}

function computeFinalScore() {
    const totalStars = state.levelStars.reduce((a, b) => a + (b || 0), 0);
    const timeBonus = Math.max(0, 800 - Math.floor(state.totalTime));
    const bumpPenalty = state.totalBumps * 25;
    return Math.max(0, totalStars * 100 + timeBonus - bumpPenalty);
}

async function showGameComplete() {
    state.mode = 'gameComplete';
    document.body.classList.remove('playing');
    els.hud.classList.add('hidden');
    const totalStars = state.levelStars.reduce((a, b) => a + (b || 0), 0);
    const max = LEVELS.length * 3;
    let starHtml = '';
    for (let i = 0; i < max; i++) {
        starHtml += `<span class="star ${i < totalStars ? 'filled' : ''}">★</span>`;
    }
    els.totalStarsDisplay.innerHTML = starHtml;
    els.totalTime.textContent = fmtTime(state.totalTime);
    els.totalBumps.textContent = state.totalBumps.toString();
    els.totalStars.textContent = `${totalStars} / ${max}`;
    const score = computeFinalScore();
    els.totalScore.textContent = score.toString();
    state.pendingScore = score;
    state.submittedScore = -1;
    els.completeLeaderboard.innerHTML = '<div class="lb-loading">Loading leaderboard…</div>';
    els.gameComplete.classList.remove('hidden');
    playChime();

    // Auto-submit using saved name
    const savedName = (localStorage.getItem('parkit_name') || '').trim() || 'Anonymous';
    els.playerName.value = savedName;
    els.nameEntrySection.style.display = 'none';
    els.submitScoreBtn.style.display = 'none';
    showSubmittedAs(savedName, 'Submitting');
    const ok = await submitScore(savedName, score);
    if (ok) {
        state.submittedScore = score;
        showSubmittedAs(savedName, 'Submitted as');
        await refreshLeaderboard(els.completeLeaderboard, savedName);
    } else {
        showSubmittedAs(savedName, 'Submit failed —');
        els.submitScoreBtn.style.display = '';
        els.submitScoreBtn.textContent = 'Retry submit';
        els.submitScoreBtn.disabled = false;
        await refreshLeaderboard(els.completeLeaderboard, savedName);
    }
}

function showSubmittedAs(name, prefix) {
    const safe = name.replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
    els.submittedAsText.innerHTML = `${prefix} <strong>${safe}</strong>`;
    els.submittedAs.style.display = '';
}

async function refreshLeaderboard(container, highlightName = '') {
    container.innerHTML = '<div class="lb-loading">Loading leaderboard…</div>';
    const rows = await fetchTopScores(5);
    if (rows === null) {
        container.innerHTML = '<div class="lb-empty">Could not load leaderboard.<br/>Check connection.</div>';
        return;
    }
    if (rows.length === 0) {
        container.innerHTML = '<div class="lb-title">Top 5</div><div class="lb-empty">No scores yet — be the first!</div>';
        return;
    }
    let html = '<div class="leaderboard-title">Top 5 <span>game: ' + GAME_ID + '</span></div><ol>';
    rows.forEach((r, i) => {
        const isMe = highlightName && r.name === highlightName;
        const safeName = (r.name || 'Anonymous').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
        html += `<li class="lb-row${isMe ? ' me' : ''}">
            <span class="lb-rank">${i + 1}</span>
            <span class="lb-name">${safeName}</span>
            <span class="lb-score">${r.score}</span>
        </li>`;
    });
    html += '</ol>';
    container.innerHTML = html;
}

async function handleSubmitScore() {
    const rawName = els.playerName.value.trim();
    const name = rawName ? rawName.slice(0, 20) : 'Anonymous';
    const score = state.pendingScore;
    els.submitScoreBtn.disabled = true;
    els.submitScoreBtn.textContent = 'Submitting…';
    localStorage.setItem('parkit_name', name);
    showSubmittedAs(name, 'Submitting');
    const ok = await submitScore(name, score);
    if (ok) {
        state.submittedScore = score;
        els.submitScoreBtn.style.display = 'none';
        els.nameEntrySection.style.display = 'none';
        showSubmittedAs(name, 'Submitted as');
        showToast('Score submitted!', 'success', 1400);
        await refreshLeaderboard(els.completeLeaderboard, name);
    } else {
        els.submitScoreBtn.textContent = 'Retry submit';
        els.submitScoreBtn.disabled = false;
        showSubmittedAs(name, 'Submit failed —');
        showToast('Submit failed — try again', 'warn', 1800);
    }
}

function showLeaderboardModal() {
    els.leaderboardScreen.classList.remove('hidden');
    refreshLeaderboard(els.standaloneLeaderboard);
}

// ============================================================================
// Input
// ============================================================================
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    keys[e.key.toLowerCase()] = true;
    if (e.code === 'KeyP' || e.code === 'Escape') {
        if (state.mode === 'playing') pauseGame();
        else if (state.mode === 'paused') resumeGame();
    }
    if (e.code === 'KeyC' && state.mode === 'playing') {
        state.cameraMode = (state.cameraMode + 1) % 2;
        showToast(state.cameraMode === 0 ? 'Top-down' : 'Chase cam', '', 900);
    }
    if (e.code === 'KeyR' && state.mode === 'playing') {
        const lv = LEVELS[state.levelIdx];
        player.reset(lv.player.x, lv.player.z, lv.player.heading);
        showToast('Car reset', '', 800);
    }
});
window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
    keys[e.key.toLowerCase()] = false;
});

function getInput() {
    let throttle = (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0;
    let brakeReverse = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
    let steer = 0;
    if (keys['KeyA'] || keys['ArrowLeft']) steer += 1;
    if (keys['KeyD'] || keys['ArrowRight']) steer -= 1;
    let handbrake = !!keys['Space'];

    // Merge touch input
    if (touch.throttle) throttle = 1;
    if (touch.brake) brakeReverse = 1;
    if (Math.abs(touch.steer) > 0.02) steer = touch.steer;
    if (touch.handbrake) handbrake = true;

    return { throttle, brakeReverse, steer, handbrake };
}

// ============================================================================
// Mobile detection + touch handlers
// ============================================================================
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
if (isTouchDevice) document.body.classList.add('touch-device');

// Steering wheel: track touch, compute angle from center → set touch.steer in -1..+1
function setupTouchWheel() {
    const wheel = els.touchWheel;
    if (!wheel) return;

    function getCenter() {
        const r = wheel.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }

    let activeId = null;
    let initialAngle = 0;     // angle at touch start (radians)
    let initialLogical = 0;   // logical wheel angle at start (radians)

    function angleFrom(center, x, y) {
        return Math.atan2(y - center.cy, x - center.cx);
    }

    function onStart(id, x, y) {
        if (activeId !== null) return;
        activeId = id;
        const c = getCenter();
        initialAngle = angleFrom(c, x, y);
        initialLogical = touch.wheelLogicalAngle;
    }
    function onMove(id, x, y) {
        if (id !== activeId) return;
        const c = getCenter();
        const a = angleFrom(c, x, y);
        let delta = a - initialAngle;
        // wrap
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        // logical angle: clamp to ±90°
        const newLogical = clamp(initialLogical + delta, -Math.PI / 2, Math.PI / 2);
        touch.wheelLogicalAngle = newLogical;
        // steer is opposite of wheel rotation: rotating wheel clockwise (positive screen angle) → turn right → steer = -1 in our convention (matches D key)
        touch.steer = clamp(-newLogical / (Math.PI / 2), -1, 1);
    }
    function onEnd(id) {
        if (id !== activeId) return;
        activeId = null;
        // Auto-return to center
        // We don't snap immediately; let getInput return current touch.steer = 0 after fade
        touch.wheelLogicalAngle = 0;
        touch.steer = 0;
    }

    wheel.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.changedTouches[0];
        onStart(t.identifier, t.clientX, t.clientY);
    }, { passive: false });
    wheel.addEventListener('touchmove', e => {
        e.preventDefault();
        for (const t of e.changedTouches) onMove(t.identifier, t.clientX, t.clientY);
    }, { passive: false });
    wheel.addEventListener('touchend', e => {
        for (const t of e.changedTouches) onEnd(t.identifier);
    });
    wheel.addEventListener('touchcancel', e => {
        for (const t of e.changedTouches) onEnd(t.identifier);
    });

    // Mouse fallback for desktop testing
    let mouseDown = false;
    wheel.addEventListener('mousedown', e => {
        e.preventDefault();
        mouseDown = true;
        onStart(-1, e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', e => {
        if (mouseDown) onMove(-1, e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', e => {
        if (mouseDown) { mouseDown = false; onEnd(-1); }
    });
}

function setupPedal(el, onPress, onRelease) {
    if (!el) return;
    const press = e => {
        if (e.cancelable) e.preventDefault();
        el.classList.add('pressed');
        onPress();
    };
    const release = e => {
        el.classList.remove('pressed');
        onRelease();
    };
    el.addEventListener('touchstart', press, { passive: false });
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    el.addEventListener('mousedown', press);
    el.addEventListener('mouseup', release);
    el.addEventListener('mouseleave', e => { if (el.classList.contains('pressed')) release(e); });
}

setupTouchWheel();
setupPedal(els.pedalAccel, () => { touch.throttle = 1; }, () => { touch.throttle = 0; });
setupPedal(els.pedalBrake, () => { touch.brake = 1; }, () => { touch.brake = 0; });
setupPedal(els.touchHandbrake, () => { touch.handbrake = true; }, () => { touch.handbrake = false; });
els.touchCam.addEventListener('click', () => {
    if (state.mode === 'playing') {
        state.cameraMode = (state.cameraMode + 1) % 2;
        showToast(state.cameraMode === 0 ? 'Top-down' : 'Chase cam', '', 900);
    }
});

// ============================================================================
// Wire up UI buttons
// ============================================================================
// Pre-fill title name field from localStorage
els.titlePlayerName.value = (localStorage.getItem('parkit_name') || '').trim();

$('start-btn').addEventListener('click', () => {
    ensureAudio();
    // Save name from title screen (if blank, fall back to existing or Anonymous later)
    const titleName = els.titlePlayerName.value.trim().slice(0, 20);
    if (titleName) localStorage.setItem('parkit_name', titleName);
    // Try to lock to landscape on supported devices
    tryLockLandscape();
    startGame();
});

els.editNameBtn.addEventListener('click', () => {
    const isOpen = els.nameEntrySection.style.display !== 'none';
    if (isOpen) {
        els.nameEntrySection.style.display = 'none';
        els.submitScoreBtn.style.display = 'none';
    } else {
        els.nameEntrySection.style.display = '';
        els.playerName.value = (localStorage.getItem('parkit_name') || '').trim();
        els.submitScoreBtn.style.display = '';
        els.submitScoreBtn.textContent = 'Submit Score';
        els.submitScoreBtn.disabled = false;
        els.playerName.focus();
    }
});

// ============================================================================
// Orientation handling
// ============================================================================
async function tryLockLandscape() {
    if (!isTouchDevice) return;
    try {
        if (screen.orientation && screen.orientation.lock) {
            // Most browsers require fullscreen first
            if (document.documentElement.requestFullscreen) {
                try { await document.documentElement.requestFullscreen(); } catch (e) {}
            }
            await screen.orientation.lock('landscape');
        }
    } catch (e) { /* lock not supported / denied — rotation prompt handles it */ }
}

function isPortrait() {
    return window.matchMedia('(orientation: portrait)').matches;
}

function checkOrientation() {
    if (!isTouchDevice) return;
    if (isPortrait() && state.mode === 'playing') {
        // auto-pause
        pauseGame();
    }
}
window.addEventListener('orientationchange', checkOrientation);
window.addEventListener('resize', checkOrientation);

$('leaderboard-btn').addEventListener('click', showLeaderboardModal);
$('leaderboard-close-btn').addEventListener('click', () => {
    els.leaderboardScreen.classList.add('hidden');
});
$('controls-btn').addEventListener('click', () => {
    document.getElementById('controls-screen').classList.remove('hidden');
});
$('controls-close-btn').addEventListener('click', () => {
    document.getElementById('controls-screen').classList.add('hidden');
});
$('resume-btn').addEventListener('click', resumeGame);
$('restart-btn').addEventListener('click', restartLevel);
$('menu-btn').addEventListener('click', backToMenu);
$('retry-btn').addEventListener('click', () => { els.complete.classList.add('hidden'); loadLevel(state.levelIdx); });
$('next-btn').addEventListener('click', nextLevel);
$('play-again-btn').addEventListener('click', () => { els.gameComplete.classList.add('hidden'); startGame(); });
$('pause-btn').addEventListener('click', () => {
    if (state.mode === 'playing') pauseGame();
});
$('reset-btn').addEventListener('click', () => {
    if (state.mode === 'playing') {
        const lv = LEVELS[state.levelIdx];
        player.reset(lv.player.x, lv.player.z, lv.player.heading);
        showToast('Car reset', '', 800);
    }
});
els.submitScoreBtn.addEventListener('click', handleSubmitScore);
// Submit on Enter in name field
els.playerName.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleSubmitScore(); }
});

// ============================================================================
// Bootstrap
// ============================================================================
const player = new PlayerCar();
buildLot(LEVELS[0]);

let lastTime = 0;
function tick(time) {
    const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
    lastTime = time;

    if (state.mode === 'playing') {
        const { throttle, brakeReverse, steer, handbrake } = getInput();
        player.update(dt, throttle, brakeReverse, steer, handbrake);
        resolveCollisions();
        state.time += dt;

        const prox = getProximityDistances();
        const minProx = Math.min(prox.front, prox.back, prox.left, prox.right);
        updateProximityAudio(minProx);

        const parkScore = computeParkScore();
        if (parkScore.parked) {
            state.parkHoldTime += dt;
            if (state.parkHoldTime >= PHYSICS.PARK_HOLD_TIME) {
                completeLevel(parkScore);
            }
        } else {
            state.parkHoldTime = Math.max(0, state.parkHoldTime - dt * 2);
        }

        updatePathPreview();
        updateHUD(prox, parkScore);
        updateTargetPulse(time);
        setEngine(player.speed);
    } else {
        setEngine(0);
        updateTargetPulse(time);
        updatePathPreview();
    }

    updateCamera(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
