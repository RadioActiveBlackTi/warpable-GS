import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HoloPortal } from './holoPortal.js';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';

async function initHoloPortal() {
    const app = document.getElementById('app');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    app.appendChild(renderer.domElement);

    const mainScene = new THREE.Scene();
    mainScene.background = new THREE.Color(0x333344);

    const mainCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    mainCamera.position.set(0, 150, 150);
    mainCamera.lookAt(0, 50, 0);

    const controls = new OrbitControls(mainCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const holoPortal = new HoloPortal(mainScene, mainCamera, renderer, '/darkrai.ply', {
        cylinderRadius: 50,
        cylinderHeight: 100,
    });

    // Ripple amplitude control.
    const ui = document.createElement('div');
    ui.style.cssText = 'position:fixed;right:16px;top:16px;z-index:9999;width:220px;padding:12px;border-radius:12px;background:rgba(0,0,0,0.65);color:#fff;font:13px/1.4 system-ui,sans-serif;';

    const ampLabel = document.createElement('div');
    ampLabel.textContent = '물방울 Z 진폭';
    ampLabel.style.marginBottom = '6px';

    const ampValue = document.createElement('div');
    ampValue.textContent = '2.0';
    ampValue.style.marginTop = '6px';
    ampValue.style.opacity = '0.85';

    const ampSlider = document.createElement('input');
    ampSlider.type = 'range';
    ampSlider.min = '0';
    ampSlider.max = '20';
    ampSlider.step = '0.1';
    ampSlider.value = '2.0';
    ampSlider.style.width = '100%';
    ampSlider.addEventListener('input', () => {
        const v = parseFloat(ampSlider.value);
        holoPortal.setBendAmount(v);
        ampValue.textContent = v.toFixed(1);
    });

    ui.appendChild(ampLabel);
    ui.appendChild(ampSlider);
    ui.appendChild(ampValue);
    document.body.appendChild(ui);

    holoPortal.setBendAmount(2.0);

    // Create the DropInViewer instance.
    const viewer = new DropInViewer();

    try {
        await holoPortal.loadSplat(viewer);
        console.log('Portal initialized and splat loaded successfully!');
    } catch (e) {
        console.error(e);
    }

    const light1 = new THREE.DirectionalLight(0xffffff, 3.0);
    light1.position.set(50, 100, 50);
    mainScene.add(light1);

    const light2 = new THREE.DirectionalLight(0xffffff, 4.0);
    light2.position.set(-50, 100, -50);
    mainScene.add(light2);

    mainScene.add(new THREE.AmbientLight(0xffffff, 0.5));

    window.addEventListener('resize', () => {
        mainCamera.aspect = window.innerWidth / window.innerHeight;
        mainCamera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        holoPortal.handleResize();
    });

    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        controls.update();

        holoPortal.update(delta);

        // Rendering is handled inside HoloPortal.
        holoPortal.render();
    }

    animate();
}

initHoloPortal();
