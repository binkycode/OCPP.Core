// 3D scene for the overview page: the charge point on its parking spot and, while a
// connector is occupied, a hologram of the car that is plugged in, with energy flowing
// through the cable and the "battery" filling up inside the hologram. Driven by data attributes on #charger-scene (see Views/Home/Index.cshtml).
// Preview other states with ?scene=charging|available|faulted|unavailable|offline.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const HOLO = 0x38bdf8;
const HOLO_FILL = 0x34d399;

// Hologram skin: fresnel rim, scan lines, a fill level (battery), a sweep of energy along the car
// and a reveal from the floor up. World-space so the effects line up across all parts.
const HOLO_VS = `
varying vec3 vN;
varying vec3 vW;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
}`;
const HOLO_FS = `
uniform vec3 uColor;
uniform vec3 uFillColor;
uniform float uTime;
uniform float uFill;
uniform float uSweep;
uniform float uOpacity;
uniform float uReveal;
varying vec3 vN;
varying vec3 vW;
void main() {
    if (vW.y > uReveal) discard;
    vec3 v = normalize(cameraPosition - vW);
    float fres = pow(1.0 - abs(dot(normalize(vN), v)), 2.5);
    float scan = smoothstep(0.6, 1.0, sin(vW.y * 120.0 - uTime * 4.0));
    float filled = step(vW.y, uFill);
    float level = exp(-pow((vW.y - uFill) * 35.0, 2.0));
    float sweep = exp(-pow((vW.x - uSweep) * 2.5, 2.0));
    float edge = exp(-pow((vW.y - uReveal) * 25.0, 2.0));
    float a = 0.04 + fres * 0.7 + scan * 0.05 + filled * 0.1 + level * 0.5 + sweep * 0.2 + edge * 0.8;
    vec3 col = mix(uColor, uFillColor, filled * 0.6);
    col = mix(col, vec3(0.8, 0.97, 1.0), clamp(level + sweep * 0.5 + edge, 0.0, 1.0));
    gl_FragColor = vec4(col, a * uOpacity);
}`;

const STATE_COLORS = {
    charging: 0x3b82f6,
    available: 0x22c55e,
    faulted: 0xef4444,
    unavailable: 0xf59e0b,
    offline: 0x6b7280,
    unknown: 0x6b7280,
};

function init(host) {
    const override = new URLSearchParams(location.search).get('scene');
    const state = (override && override in STATE_COLORS) ? override : (host.dataset.state || 'unknown');
    const charging = state === 'charging';
    const powerKw = parseFloat(((host.dataset.power || '').match(/([\d.,]+)\s*kW/i) || [, ''])[1].replace(',', '.'));
    const flowing = charging && !(powerKw === 0); // unknown power while occupied: assume charging
    const socMatch = (host.dataset.power || '').match(/(\d+)\s*%/);
    const soc = socMatch ? Math.min(100, parseInt(socMatch[1], 10)) / 100 : null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ledColor = new THREE.Color(STATE_COLORS[state]);

    // ---------- renderer, scene, camera ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true; // reveal of the hologram outlines
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    // With a car: frame car and charge point; without: closer to the charge point and the empty spot.
    const target = charging ? new THREE.Vector3(0.9, 0.6, 0.4) : new THREE.Vector3(2.2, 0.8, 1.2);
    const home = charging ? new THREE.Vector3(-4.6, 2.4, 7.4) : new THREE.Vector3(-1.4, 2.0, 5.6);
    camera.position.copy(reducedMotion ? home : home.clone().sub(target).multiplyScalar(1.35).add(target));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = charging ? 5 : 2.5;
    controls.maxDistance = 14;
    controls.minPolarAngle = 0.55;
    controls.maxPolarAngle = 1.45;
    controls.autoRotateSpeed = 0.35;

    // ---------- lights ----------
    scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x14181f, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 20 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fb2ff, 1.6);
    rim.position.set(6, 3, -6);
    scene.add(rim);

    // ---------- materials ----------
    const housing = new THREE.MeshPhysicalMaterial({ color: 0xeef0f3, roughness: 0.35, clearcoat: 0.6 });
    const alu = new THREE.MeshStandardMaterial({ color: 0xb9bec5, metalness: 0.7, roughness: 0.35 });
    const darkPanel = new THREE.MeshPhysicalMaterial({ color: 0x15191f, roughness: 0.15, clearcoat: 1 });
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.55 });
    const glow = (color, intensity = 2.5) => new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: color, emissiveIntensity: intensity,
    });

    // ---------- floor ----------
    const floorTex = radialTexture();
    const floor = new THREE.Mesh(
        new THREE.CircleGeometry(11, 64),
        new THREE.MeshStandardMaterial({ color: 0x1a2029, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.25, alphaMap: floorTex, transparent: true }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // parking spot markings
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.9, transparent: true, opacity: 0.55 });
    for (const z of [-1.4, 1.4]) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 0.07), lineMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(0.3, 0.003, z);
        line.receiveShadow = true;
        scene.add(line);
    }
    const endLine = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 2.87), lineMat);
    endLine.rotation.x = -Math.PI / 2;
    endLine.position.set(3.4, 0.003, 0);
    scene.add(endLine);

    // ---------- charge point ----------
    const charger = buildCharger();
    charger.position.set(3.0, 0, 1.75);
    charger.rotation.y = -1.25; // front faces the car / camera
    scene.add(charger);

    const ledLight = new THREE.PointLight(ledColor, 0.8, 2.5, 2);
    ledLight.position.set(0, 1.35, 0.35);
    charger.add(ledLight);

    // ---------- car + cable ----------
    let car = null, holo = null, flow = null, portGlow = null, portLight = null, underGlow = null, dashes = null, sparks = null;
    if (charging) {
        holo = buildHoloCar();
        car = holo.group;
        car.rotation.y = Math.PI; // nose to -x, rear (with the charge port) towards the charge point
        scene.add(car);
        scene.updateMatrixWorld(true);

        const portLocal = new THREE.Vector3(-2.2, 0.76, -0.99);
        const port = car.localToWorld(portLocal.clone());
        const portOut = car.localToWorld(portLocal.clone().add(new THREE.Vector3(-0.05, -0.04, -0.22)));
        const socket = charger.localToWorld(new THREE.Vector3(0, 1.12, 0.14));
        const socketOut = charger.localToWorld(new THREE.Vector3(0, 1.04, 0.32));
        const sag = socket.clone().lerp(port, 0.5);
        sag.y = 0.42;
        const curve = new THREE.CatmullRomCurve3([socket, socketOut, sag, portOut, port], false, 'catmullrom', 0.5);

        const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.017, 12), cableMat);
        cable.castShadow = true;
        scene.add(cable);

        // plug handle at the car
        const dir = port.clone().sub(portOut).normalize();
        const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.16, 20), new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.4, metalness: 0.3 }));
        handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        handle.position.copy(port).addScaledVector(dir, -0.07);
        handle.castShadow = true;
        scene.add(handle);

        if (flowing) {
            flow = new THREE.Mesh(
                new THREE.TubeGeometry(curve, 120, 0.028, 12),
                new THREE.ShaderMaterial({
                    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x4fc3ff) } },
                    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
                    fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
                        void main(){
                            float x = fract(vUv.x * 5.0 - uTime * 0.9);
                            float p = smoothstep(0.0, 0.12, x) * smoothstep(0.42, 0.12, x);
                            gl_FragColor = vec4(uColor * p * 1.8, p * 0.9);
                        }`,
                    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
                }),
            );
            scene.add(flow);
        }

        // charge port light (green while charging, blue when plugged in but idle)
        const portColor = flowing ? 0x3dff7a : 0x3b82f6;
        portGlow = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.05, 32), glow(portColor, 3));
        portGlow.position.copy(car.localToWorld(portLocal.clone().add(new THREE.Vector3(0, 0, -0.006))));
        portGlow.quaternion.copy(car.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
        scene.add(portGlow);
        portLight = new THREE.PointLight(portColor, 0.6, 1.4, 2);
        portLight.position.copy(portOut);
        scene.add(portLight);

        // soft glow on the floor under the car
        underGlow = new THREE.Mesh(
            new THREE.PlaneGeometry(5.6, 2.6),
            new THREE.MeshBasicMaterial({ map: radialTexture(HOLO), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5 }),
        );
        underGlow.rotation.x = -Math.PI / 2;
        underGlow.position.y = 0.006;
        scene.add(underGlow);

        // projector on the floor: a thin ellipse and a slowly turning dashed ring
        const ringMat = new THREE.MeshBasicMaterial({ color: HOLO, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const ellipse = new THREE.Group();
        ellipse.rotation.x = -Math.PI / 2;
        ellipse.scale.set(2.75, 1.3, 1);
        ellipse.position.y = 0.008;
        ellipse.add(new THREE.Mesh(new THREE.RingGeometry(1, 1.012, 128), ringMat));
        dashes = new THREE.Group();
        for (let i = 0; i < 48; i++) {
            const a = (i / 48) * Math.PI * 2;
            dashes.add(new THREE.Mesh(new THREE.RingGeometry(1.04, 1.055, 4, 1, a, (Math.PI * 2 / 48) * 0.45), ringMat));
        }
        ellipse.add(dashes);
        scene.add(ellipse);

        // energy particles rising through the hologram
        if (!reducedMotion) {
            const n = 140, pos = new Float32Array(n * 3), speed = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                pos.set([(Math.random() * 2 - 1) * 2.2, Math.random() * 1.3, (Math.random() * 2 - 1) * 0.85], i * 3);
                speed[i] = 0.12 + Math.random() * 0.3;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            sparks = new THREE.Points(geo, new THREE.PointsMaterial({
                color: 0x9be7ff, size: 0.035, map: radialTexture(0xffffff), transparent: true, opacity: 0.8,
                blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            sparks.userData.speed = speed;
            scene.add(sparks);
        }
    }

    // ---------- display on the charge point ----------
    drawDisplay(charger.userData.display, (host.dataset.label || state).toUpperCase(), host.dataset.value || '', ledColor);

    // ---------- loop ----------
    const clock = new THREE.Clock();
    let userActive = false, swayDir = 1, introDone = reducedMotion;
    const baseAz = Math.atan2(home.x - target.x, home.z - target.z);
    controls.addEventListener('start', () => { userActive = true; introDone = true; });
    controls.addEventListener('end', () => { setTimeout(() => { userActive = false; }, 4000); });

    let visible = true;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(host);

    function resize() {
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // Keep the scene clear of the text: shift it right on wide screens, down and wider on narrow ones.
        camera.fov = w / h < 1 ? 52 : 32;
        if (w > 700) camera.setViewOffset(w, h, -w * 0.12, 0, w, h);
        else camera.setViewOffset(w, h, 0, -h * 0.14, w, h);
        camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(host);
    resize();

    renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), 0.1);
        const t = clock.elapsedTime;
        if (!visible) return;

        if (!introDone) {
            camera.position.lerp(home, 1 - Math.pow(0.02, dt));
            if (camera.position.distanceTo(home) < 0.02) introDone = true;
        }
        // gentle back-and-forth sway when the user is not interacting
        if (!reducedMotion && introDone && !userActive) {
            const az = controls.getAzimuthalAngle();
            if (az > baseAz + 0.6) swayDir = -1;
            if (az < baseAz - 0.75) swayDir = 1;
            controls.autoRotate = true;
            controls.autoRotateSpeed = 0.35 * swayDir;
        } else {
            controls.autoRotate = false;
        }

        const pulse = 0.5 + 0.5 * Math.sin(t * (charging ? 2.6 : 1.2));
        charger.userData.led.material.emissiveIntensity = state === 'available' ? 2.2 : 1.2 + 2.2 * pulse;
        charger.userData.ring.material.emissiveIntensity = charging ? 1.0 + 2.0 * pulse : 0.6;
        ledLight.intensity = charging ? 0.4 + 0.8 * pulse : 0.6;
        if (flow) flow.material.uniforms.uTime.value = t;
        if (portGlow) portGlow.material.emissiveIntensity = flowing ? 1.5 + 2.5 * pulse : 2.5;
        if (portLight) portLight.intensity = flowing ? 0.2 + 0.6 * pulse : 0.4;
        if (underGlow) underGlow.material.opacity = flowing ? 0.25 + 0.25 * pulse : 0.2;
        if (holo) {
            const u = holo.uniforms;
            const reveal = reducedMotion ? 3 : Math.min(3, t * 1.3 - 0.2);
            u.uTime.value = t;
            u.uReveal.value = reveal;
            holo.clip.constant = reveal;
            // battery level: real state of charge if known, else a looping fill while charging
            const level = soc !== null ? soc : (flowing && !reducedMotion ? (t / 8) % 1 : 0.5);
            u.uFill.value = 0.28 + level * 1.05;
            // energy sweeps from the charge port (rear, +x) to the nose
            u.uSweep.value = flowing && !reducedMotion ? 2.6 - ((t * 0.5) % 1) * 5.4 : 99;
            u.uOpacity.value = 0.92 + 0.08 * Math.sin(t * 37) * Math.sin(t * 11);
            if (dashes && !reducedMotion) dashes.rotation.z = t * 0.12;
        }
        if (sparks) {
            const a = sparks.geometry.attributes.position, sp = sparks.userData.speed;
            for (let i = 0; i < sp.length; i++) {
                let y = a.getY(i) + sp[i] * dt;
                if (y > 1.4) y = 0.05;
                a.setY(i, y);
            }
            a.needsUpdate = true;
        }

        controls.update(dt);
        renderer.render(scene, camera);
    });

    // ===================================================================
    function buildCharger() {
        const g = new THREE.Group();
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.03, 40), alu);
        base.position.y = 0.015;
        const pole = new THREE.Mesh(new RoundedBoxGeometry(0.14, 1.04, 0.1, 4, 0.025), alu);
        pole.position.y = 0.55;
        const body = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.5, 0.17, 6, 0.06), housing);
        body.position.set(0, 1.24, 0.02);
        const panel = new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.4, 0.014, 4, 0.006), darkPanel);
        panel.position.set(0, 1.26, 0.108);
        for (const m of [base, pole, body, panel]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }

        const led = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.016, 0.01, 2, 0.004), glow(ledColor));
        led.position.set(0, 1.44, 0.117);
        g.add(led);

        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 256;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const display = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
        display.position.set(0, 1.34, 0.1155);
        display.userData = { canvas, tex };
        g.add(display);

        // Type 2 socket with light ring
        const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.048, 0.05, 32), new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.5 }));
        socket.rotation.x = Math.PI / 2;
        socket.position.set(0, 1.12, 0.12);
        g.add(socket);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.005, 12, 48), glow(ledColor, 1));
        ring.position.set(0, 1.12, 0.146);
        g.add(ring);
        if (!charging) {
            // socket pins
            for (let i = 0; i < 7; i++) {
                const a = (i / 6) * Math.PI * 2;
                const pin = new THREE.Mesh(new THREE.CircleGeometry(i === 6 ? 0.007 : 0.006, 12), new THREE.MeshStandardMaterial({ color: 0x3a3d42 }));
                pin.position.set(i === 6 ? 0 : Math.cos(a) * 0.024, 1.12 + (i === 6 ? 0 : Math.sin(a) * 0.024), 0.1455);
                g.add(pin);
            }
        }
        g.userData = { led, ring, display };
        return g;
    }

    function buildHoloCar() {
        // Built with the nose at +x and the car's left side at -z, then rotated into place.
        const group = new THREE.Group();
        const uniforms = {
            uColor: { value: new THREE.Color(HOLO) },
            uFillColor: { value: new THREE.Color(HOLO_FILL) },
            uTime: { value: 0 },
            uFill: { value: 0.3 },
            uSweep: { value: 99 },
            uOpacity: { value: 1 },
            uReveal: { value: reducedMotion ? 3 : 0 },
        };
        const skin = new THREE.ShaderMaterial({
            uniforms, vertexShader: HOLO_VS, fragmentShader: HOLO_FS,
            transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), uniforms.uReveal.value);
        const lineMat = new THREE.LineBasicMaterial({
            color: 0x9be7ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, clippingPlanes: [clip],
        });
        const add = (geo, edgeAngle = 20) => {
            group.add(new THREE.Mesh(geo, skin));
            if (edgeAngle) group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, edgeAngle), lineMat));
        };
        const line = (points, loop = false) => {
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            group.add(loop ? new THREE.LineLoop(geo, lineMat) : new THREE.Line(geo, lineMat));
        };

        // Sporty fastback: low roof (~1.33 m), long hood, cabin set back, short overhangs, ducktail.
        const body = new THREE.Shape();
        body.moveTo(-2.15, 0.3);
        body.lineTo(-1.97, 0.3);
        body.absarc(-1.5, 0.36, 0.47, Math.PI, 0, true);
        body.lineTo(0.93, 0.3);
        body.absarc(1.4, 0.36, 0.47, Math.PI, 0, true);
        body.lineTo(2.08, 0.27);
        body.lineTo(2.28, 0.33);
        body.quadraticCurveTo(2.31, 0.42, 2.26, 0.5);
        body.lineTo(2.18, 0.6);
        body.quadraticCurveTo(1.6, 0.76, 0.75, 0.86);
        body.lineTo(-1.35, 0.9);
        body.quadraticCurveTo(-2.0, 0.93, -2.3, 0.96);
        body.lineTo(-2.34, 0.9);
        body.quadraticCurveTo(-2.38, 0.7, -2.33, 0.5);
        body.lineTo(-2.28, 0.34);
        body.quadraticCurveTo(-2.24, 0.3, -2.15, 0.3);
        const bodyHalf = 0.98;
        add(extrudeGeo(body, bodyHalf, 0.2, 0.07));

        const cabin = new THREE.Shape();
        cabin.moveTo(0.85, 0.85);
        cabin.quadraticCurveTo(0.45, 1.12, -0.05, 1.26);
        cabin.quadraticCurveTo(-0.5, 1.32, -0.95, 1.24);
        cabin.quadraticCurveTo(-1.7, 1.06, -2.22, 0.93);
        cabin.lineTo(-2.2, 0.85);
        cabin.lineTo(0.85, 0.85);
        const cabinHalf = 0.8;
        add(extrudeGeo(cabin, cabinHalf, 0.16, 0.06));

        // side window, B-pillar, door line, side skirt and mirrors on both sides (coupe: one door)
        const win = new THREE.Shape();
        win.moveTo(0.72, 0.92);
        win.quadraticCurveTo(0.38, 1.13, -0.05, 1.21);
        win.quadraticCurveTo(-0.5, 1.27, -0.95, 1.19);
        win.quadraticCurveTo(-1.45, 1.07, -1.75, 0.94);
        win.lineTo(0.72, 0.92);
        const winPts = win.getPoints(24);
        const V = (x, y, z) => new THREE.Vector3(x, y, z);
        for (const side of [-1, 1]) {
            const zc = side * (cabinHalf + 0.004), zb = side * (bodyHalf + 0.005);
            line(winPts.map((p) => V(p.x, p.y, zc)), true);
            line([V(-0.35, 0.92, zc), V(-0.42, 1.24, zc)]);
            line([V(0.78, 0.36, zb), V(0.74, 0.84, zb)]);
            line([V(-0.95, 0.38, zb), V(-0.9, 0.86, zb)]);
            line([V(-0.98, 0.33, zb), V(0.88, 0.33, zb)]);
            // shoulder line from the front wheel to the tail
            line([V(1.9, 0.66, zb), V(0.4, 0.72, zb), V(-1.6, 0.76, zb), V(-2.3, 0.8, zb)]);
            const mirror = new RoundedBoxGeometry(0.18, 0.08, 0.15, 3, 0.03);
            mirror.translate(0.7, 0.95, side * 1.0);
            add(mirror, 30);
        }
        // front splitter and rear diffuser fins
        line([V(2.35, 0.3, -0.88), V(2.35, 0.3, 0.88)]);
        line([V(2.37, 0.37, -0.32), V(2.37, 0.37, 0.32)]);
        line([V(2.37, 0.43, -0.28), V(2.37, 0.43, 0.28)]);
        for (const side of [-1, 1]) {
            // angular side intakes
            line([V(2.36, 0.34, side * 0.42), V(2.34, 0.46, side * 0.56), V(2.24, 0.44, side * 0.84), V(2.26, 0.33, side * 0.84)], true);
            line([V(2.35, 0.38, side * 0.6), V(2.29, 0.38, side * 0.78)]);
            // hood creases following the hood curve (+ bevel offset)
            const crease = [];
            for (let k = 0; k <= 12; k++) {
                const t = k / 12, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
                crease.push(V(a * 2.18 + b * 1.6 + c * 0.75, a * 0.6 + b * 0.76 + c * 0.86 + 0.075, side * (0.32 + 0.12 * t)));
            }
            line(crease);
        }
        for (const z of [-0.45, -0.15, 0.15, 0.45]) line([V(-2.3, 0.3, z), V(-2.05, 0.3, z)]);

        // headlights: angular LED "boomerang", two projector lenses, a halo and beams on the floor
        const headMat = glow(0xe6f7ff, 5);
        const barMat = glow(0x9be7ff, 3);
        const tube = (pts, r, mat) => {
            const path = new THREE.CurvePath();
            for (let k = 1; k < pts.length; k++) path.add(new THREE.LineCurve3(pts[k - 1], pts[k]));
            group.add(new THREE.Mesh(new THREE.TubeGeometry(path, 16 * pts.length, r, 8), mat));
        };
        const halo = (color, size, opacity) => {
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({
                map: radialTexture(color), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            sp.scale.setScalar(size);
            return sp;
        };
        for (const side of [-1, 1]) {
            tube([V(2.3, 0.53, side * 0.4), V(2.24, 0.59, side * 0.7), V(2.04, 0.635, side * 0.9)], 0.011, headMat);
            tube([V(2.24, 0.59, side * 0.7), V(2.27, 0.49, side * 0.8)], 0.011, headMat);
            for (const z of [0.52, 0.61]) {
                const lens = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), headMat);
                lens.position.set(2.26, 0.555, side * z);
                group.add(lens);
            }
            const h = halo(0xcfefff, 0.55, 0.85);
            h.position.set(2.32, 0.56, side * 0.6);
            group.add(h);
            const beam = new THREE.Mesh(
                new THREE.PlaneGeometry(1, 1),
                new THREE.MeshBasicMaterial({ map: radialTexture(0xbfe9ff), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }),
            );
            beam.rotation.x = -Math.PI / 2;
            beam.scale.set(2.2, 0.8, 1);
            beam.position.set(3.2, 0.012, side * 0.55);
            group.add(beam);
        }
        tube([V(2.32, 0.555, -0.4), V(2.32, 0.555, 0.4)], 0.006, barMat);

        // tail: full-width bar with vertical blades at the ends
        const tailMat = glow(0xff1a1a, 2.6);
        tube([V(-2.42, 0.86, -0.8), V(-2.42, 0.86, 0.8)], 0.014, tailMat);
        for (const side of [-1, 1]) {
            tube([V(-2.4, 0.92, side * 0.82), V(-2.38, 0.74, side * 0.84)], 0.014, tailMat);
            const h = halo(0xff3030, 0.4, 0.6);
            h.position.set(-2.45, 0.84, side * 0.8);
            group.add(h);
        }

        // wheels: low-profile tyres, large multi-spoke rims
        for (const [x, z] of [[1.4, -0.83], [1.4, 0.83], [-1.5, -0.83], [-1.5, 0.83]]) {
            const out = Math.sign(z);
            const tyre = new THREE.CylinderGeometry(0.36, 0.36, 0.27, 48, 1, true);
            tyre.rotateX(Math.PI / 2);
            tyre.translate(x, 0.36, z);
            add(tyre, 30);
            const rim = new THREE.RingGeometry(0.27, 0.29, 48);
            rim.translate(x, 0.36, z + out * 0.14);
            add(rim, 30);
            const hub = new THREE.RingGeometry(0.04, 0.06, 24);
            hub.translate(x, 0.36, z + out * 0.142);
            add(hub, 30);
            for (let k = 0; k < 10; k++) {
                const a = (k / 10) * Math.PI * 2 + (k % 2 ? 0.12 : 0);
                line([
                    V(x + Math.sin(a) * 0.06, 0.36 + Math.cos(a) * 0.06, z + out * 0.145),
                    V(x + Math.sin(a) * 0.27, 0.36 + Math.cos(a) * 0.27, z + out * 0.145),
                ]);
            }
        }
        return { group, uniforms, clip };
    }

    function extrudeGeo(shape, halfWidth, bevelThickness, bevelSize) {
        const depth = (halfWidth - bevelThickness) * 2;
        const geo = new THREE.ExtrudeGeometry(shape, {
            depth, bevelEnabled: true, bevelThickness, bevelSize, bevelSegments: 8, curveSegments: 32,
        });
        geo.translate(0, 0, -depth / 2);
        geo.computeVertexNormals();
        return geo;
    }
}

// Without a color: an opaque white-to-black disc for use as alphaMap (three.js reads the green channel).
// With a color: that color fading to transparent, for additive glows.
function radialTexture(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    if (color === undefined) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 256, 256);
        g.addColorStop(0, '#fff');
        g.addColorStop(0.3, '#ccc');
        g.addColorStop(0.75, '#000');
    } else {
        const rgb = [(color >> 16) & 255, (color >> 8) & 255, color & 255].join(',');
        g.addColorStop(0, `rgba(${rgb},1)`);
        g.addColorStop(0.2, `rgba(${rgb},0.6)`);
        g.addColorStop(1, `rgba(${rgb},0)`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    if (color !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function drawDisplay(display, label, value, color) {
    const { canvas, tex } = display.userData;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#' + color.getHexString();
    ctx.font = '600 44px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, 256, 80);
    ctx.fillStyle = '#e8eef5';
    ctx.font = '700 84px system-ui, sans-serif';
    ctx.fillText(value || '—', 256, 200, 480);
    tex.needsUpdate = true;
}

// Start after all module-level constants are initialised.
const host = document.getElementById('charger-scene');
if (host) {
    try {
        init(host);
    } catch (e) {
        console.warn('3D scene not available', e);
        host.classList.add('no-webgl');
    }
}
