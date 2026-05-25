/**
 * Skinning Demo - Gaussian Splat Manipulation and Rigging Controls
 * - Gaussian splat scale and alpha manipulation
 * - Global rigid body transformation (rotation and translation) controls
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';
import { extractRotation3D, outerProduct3 } from './mathUtils.js';
import { getGaussianSplatLBSInjection } from './shaders.js';

const state = {
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    viewer: null,
    contentGroup: null,
    skinningPoints: [],
    boneMeshes: [],
    selectedBoneIndices: [],
    activeBoneIndex: -1,
    fixedBoneIndices: new Set(),
    arap: null,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    dragPlane: new THREE.Plane(),
    dragStartPoint: new THREE.Vector3(),
    dragOffset: new THREE.Vector3(),
    dragStartPositions: new Map(),
    dragActiveLocalStart: new THREE.Vector3(),
    isDraggingBone: false,
    globalTransform: new THREE.Matrix4(),
    boneTexture: null,
    boneTextureWidth: 0,
    boneTextureHeight: 0,
    splatSkinningReady: false,
    activeDataPath: '',
    keyframes: [],
    selectedKeyframeIndex: -1,
    keyframeArapIterations: 20,
    splineAnimationPlaying: false,
    splineAnimationTime: 0,
    splineAnimationSpeed: 1.0,
    splineAnimationIterations: 10,
    splineAnimationCurveCache: null,
    splineAnimationHandleIndices: [],
    splineAnimationPhaseOffset: 0,
    frameClock: new THREE.Clock(),
};
window.appState = state;

window.addEventListener('DOMContentLoaded', initDemo);

function initDemo() {
    console.log('Initializing demo environment');
    
    const container = document.getElementById('app') || document.body;
    
    const existingCanvas = document.getElementById('canvas');
    if (existingCanvas) {
        state.renderer = new THREE.WebGLRenderer({ canvas: existingCanvas, antialias: true, alpha: false });
    } else {
        state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        state.renderer.domElement.id = 'canvas';
        container.appendChild(state.renderer.domElement);
    }
    
    state.renderer.setPixelRatio(window.devicePixelRatio || 1);
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    state.renderer.sortObjects = true;

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x222227);

    state.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    state.camera.position.set(0, 20, 40);
    state.camera.lookAt(0, 0, 0);

    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.05;

    const dir1 = new THREE.DirectionalLight(0xffffff, 3.0); dir1.position.set(50, 100, 50);
    const dir2 = new THREE.DirectionalLight(0xffffff, 2.0); dir2.position.set(-50, 100, -50);
    const amb = new THREE.AmbientLight(0xffffff, 0.8);
    state.scene.add(dir1, dir2, amb);

    state.contentGroup = new THREE.Group();
    state.scene.add(state.contentGroup);

    window.addEventListener('resize', onWindowResize);
    setupEventListeners();
    setupPickingEvents();

    animate();
}

function setupEventListeners() {
    document.getElementById('loadBtn')?.addEventListener('click', () => loadData());
    document.getElementById('gsScale')?.addEventListener('input', setGSScale);
    document.getElementById('gsAlpha')?.addEventListener('input', setGSAlpha);
    document.getElementById('rotX')?.addEventListener('input', updateBoneRotation);
    document.getElementById('rotY')?.addEventListener('input', updateBoneRotation);
    document.getElementById('rotZ')?.addEventListener('input', updateBoneRotation);
    document.getElementById('selectedBone')?.addEventListener('input', updateSelectedBone);
    document.getElementById('cameraDist')?.addEventListener('input', updateCameraDistance);
    document.getElementById('splineAnimSpeed')?.addEventListener('input', setSplineAnimationSpeed);
    document.getElementById('keyframeSelect')?.addEventListener('change', updateSelectedKeyframe);
    document.getElementById('showSplats')?.addEventListener('change', (e) => {
        if (state.viewer) state.viewer.visible = e.target.checked;
    });
    document.getElementById('showNodes')?.addEventListener('change', (e) => {
        if (state.boneMeshes) state.boneMeshes.forEach((m) => (m.visible = e.target.checked));
    });
}

function setupPickingEvents() {
    const dom = state.renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointerleave', onPointerUp);
    dom.addEventListener('dblclick', onDoubleClick);
    dom.addEventListener('contextmenu', onContextMenu);
}

async function loadData() {
    const dataPath = document.getElementById('dataPath')?.value;
    if (!dataPath) {
        console.error('Data path is required');
        return;
    }

    console.log('Starting data loading from:', dataPath);
    state.activeDataPath = dataPath;

    try {
        const nodesResp = await fetch(`${dataPath}/proxy_nodes.json`);
        if (!nodesResp.ok) throw new Error(`Failed to fetch proxy_nodes.json: ${nodesResp.status}`);

        const nodesData = await nodesResp.json();
        state.skinningPoints = nodesData.map((p) => new THREE.Vector3(p.x, p.y, p.z));
        state.arap = buildArapSystem(state.skinningPoints, 6);
        visualizeSkinningPoints();
        if (document.getElementById('selectedBone')) {
            document.getElementById('selectedBone').max = String(Math.max(0, state.skinningPoints.length - 1));
        }
        console.log(`Skinning points loaded: ${state.skinningPoints.length} vertices`);

        let gsPath = dataPath.replace(/_nodes\d+_sigma[\d.]+$/, '') + '.ply';
        if (gsPath.startsWith('public/')) gsPath = gsPath.replace('public/', '/');
        else if (!gsPath.startsWith('.') && !gsPath.startsWith('/')) gsPath = '/' + gsPath;

        console.log('Gaussian splat path:', gsPath);

        if (state.viewer) {
            state.contentGroup.remove(state.viewer);
            state.viewer = null;
        }

        state.viewer = new DropInViewer({
            gpuAcceleratedSort: false,
            sharedMemoryForWorkers: false,
            sphericalHarmonicsDegree: 2,
        });
        state.contentGroup.add(state.viewer);

        const scaleVal = parseFloat(document.getElementById('gsScale')?.value || 1.0);
        await state.viewer.addSplatScene(gsPath, {
            progressiveLoad: true,
            position: [0, 0, 0],
            scale: [scaleVal, scaleVal, scaleVal],
        });

        const splatCount = state.viewer.splatMesh?.getSplatCount() || 0;
        console.log(`Gaussian splats loaded: ${splatCount} splats`);

        setupGaussianSkinning();
        loadPersistedKeyframes();
        renderKeyframeList();
        setSplineAnimationSpeed();
        syncSplineAnimationUI();

        if (state.skinningPoints.length > 0) {
            const bbox = new THREE.Box3().setFromPoints(state.skinningPoints);
            const center = bbox.getCenter(new THREE.Vector3());
            const maxDim = Math.max(bbox.getSize(new THREE.Vector3()).x, 15);

            state.controls.target.copy(center);
            state.camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 1, 1).normalize(), maxDim * 2.5);
            state.camera.lookAt(center);
            state.camera.updateProjectionMatrix();
        }

        console.log('Data loading completed successfully');
    } catch (error) {
        console.error('Error during data loading:', error);
    }
}

function getKeyframeStorageKey() {
    return `skinning_demo:keyframes:${state.activeDataPath || 'default'}`;
}

function cloneVectorArrayToJSON(vectors) {
    return vectors.map((v) => [v.x, v.y, v.z]);
}

function makeKeyframeSnapshot(name) {
    if (!state.arap) return null;

    const selected = state.selectedBoneIndices.length > 0
        ? [...state.selectedBoneIndices]
        : (state.activeBoneIndex >= 0 ? [state.activeBoneIndex] : []);
    const fixed = [...state.fixedBoneIndices];
    const handleIndices = [...new Set([...selected, ...fixed])];

    if (!handleIndices.length) {
        return null;
    }

    return {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: name?.trim() || `Keyframe ${state.keyframes.length + 1}`,
        createdAt: new Date().toISOString(),
        selectedBoneIndices: selected,
        fixedBoneIndices: fixed,
        activeBoneIndex: state.activeBoneIndex,
        handleIndices,
        handlePositions: handleIndices.map((index) => ({
            index,
            position: state.arap.currentPositions[index]?.toArray?.() ?? [0, 0, 0],
        })),
        restPositions: cloneVectorArrayToJSON(state.arap.restPositions),
        currentPositions: cloneVectorArrayToJSON(state.arap.currentPositions),
        rotations: state.arap.rotations.map((m) => (m?.toArray?.() ?? new THREE.Matrix3().identity().toArray())),
        globalTransform: state.globalTransform?.toArray?.() ?? new THREE.Matrix4().identity().toArray(),
    };
}

function persistKeyframes() {
    try {
        localStorage.setItem(getKeyframeStorageKey(), JSON.stringify(state.keyframes));
    } catch (error) {
        console.warn('Failed to persist keyframes:', error);
    }
}

function loadPersistedKeyframes() {
    try {
        const raw = localStorage.getItem(getKeyframeStorageKey());
        state.keyframes = raw ? JSON.parse(raw) : [];
        state.selectedKeyframeIndex = state.keyframes.length > 0 ? 0 : -1;
    } catch (error) {
        console.warn('Failed to load persisted keyframes:', error);
        state.keyframes = [];
        state.selectedKeyframeIndex = -1;
    }
}

function updateSelectedKeyframe() {
    const select = document.getElementById('keyframeSelect');
    if (!select) return;
    const idx = parseInt(select.value, 10);
    state.selectedKeyframeIndex = Number.isFinite(idx) ? idx : -1;
    syncKeyframeUI();
}

function renderKeyframeList() {
    const select = document.getElementById('keyframeSelect');
    const countEl = document.getElementById('keyframeCount');
    if (!select) return;

    select.innerHTML = '';
    state.keyframes.forEach((kf, idx) => {
        const option = document.createElement('option');
        option.value = String(idx);
        const selectedCount = kf.selectedBoneIndices?.length ?? 0;
        const fixedCount = kf.fixedBoneIndices?.length ?? 0;
        const label = kf.name || `Keyframe ${idx + 1}`;
        option.textContent = `${String(idx + 1).padStart(2, '0')} | ${label} | M:${selectedCount} S:${fixedCount}`;
        select.appendChild(option);
    });

    if (state.selectedKeyframeIndex >= 0 && state.selectedKeyframeIndex < state.keyframes.length) {
        select.value = String(state.selectedKeyframeIndex);
    } else if (state.keyframes.length > 0) {
        state.selectedKeyframeIndex = 0;
        select.value = '0';
    } else {
        state.selectedKeyframeIndex = -1;
    }

    if (countEl) countEl.textContent = String(state.keyframes.length);
    syncKeyframeUI();
}

function syncKeyframeUI() {
    const info = document.getElementById('keyframeInfo');
    const applyBtn = document.getElementById('applyKeyframeBtn');
    const deleteBtn = document.getElementById('deleteKeyframeBtn');
    const exportBtn = document.getElementById('exportKeyframesBtn');
    const hasKeyframes = state.keyframes.length > 0 && state.selectedKeyframeIndex >= 0;

    if (applyBtn) applyBtn.disabled = !hasKeyframes;
    if (deleteBtn) deleteBtn.disabled = !hasKeyframes;
    if (exportBtn) exportBtn.disabled = state.keyframes.length === 0;

    if (info) {
        if (!hasKeyframes) {
            info.textContent = '등록된 키프레임이 없습니다.';
        } else {
            const kf = state.keyframes[state.selectedKeyframeIndex];
            info.textContent = `${kf.name} · selected ${kf.selectedBoneIndices?.length ?? 0} / static ${kf.fixedBoneIndices?.length ?? 0}`;
        }
    }
}

function registerKeyframe() {
    const nameInput = document.getElementById('keyframeName');
    const snapshot = makeKeyframeSnapshot(nameInput?.value);
    if (!snapshot) {
        console.warn('키프레임을 등록하려면 최소 하나의 본을 선택하거나 고정해야 합니다.');
        return;
    }

    state.keyframes.push(snapshot);
    state.selectedKeyframeIndex = state.keyframes.length - 1;
    if (nameInput) nameInput.value = '';
    persistKeyframes();
    renderKeyframeList();
    rebuildAndRefreshSplineAnimation();
    console.log(`Keyframe registered: ${snapshot.name}`);
}

function applyKeyframe(index = state.selectedKeyframeIndex) {
    if (!state.arap || index < 0 || index >= state.keyframes.length) return;

    const kf = state.keyframes[index];
    const selected = [...new Set((kf.selectedBoneIndices || []).filter((i) => Number.isInteger(i)))];
    const fixed = [...new Set((kf.fixedBoneIndices || []).filter((i) => Number.isInteger(i)))];
    const handles = new Map();

    for (const item of kf.handlePositions || []) {
        if (!Number.isInteger(item.index)) continue;
        const pos = Array.isArray(item.position) ? new THREE.Vector3().fromArray(item.position) : null;
        if (!pos) continue;
        handles.set(item.index, pos);
    }

    state.fixedBoneIndices = new Set(fixed);
    state.selectedBoneIndices = selected.filter((i) => !state.fixedBoneIndices.has(i));
    state.activeBoneIndex = state.selectedBoneIndices[0] ?? state.fixedBoneIndices.values().next().value ?? -1;

    for (const [idx, pos] of handles.entries()) {
        if (state.arap.currentPositions[idx]) {
            state.arap.currentPositions[idx].copy(pos);
        }
    }

    if (handles.size > 0) {
        solveArap(handles, state.keyframeArapIterations);
    } else {
        syncArapToMeshes();
        refreshGaussianBoneTexture();
    }

    state.selectedKeyframeIndex = index;
    const select = document.getElementById('keyframeSelect');
    if (select) select.value = String(index);
    syncSelectionToUI();
    syncKeyframeUI();
    rebuildAndRefreshSplineAnimation();
    console.log(`Keyframe applied: ${kf.name}`);
}

function deleteKeyframe(index = state.selectedKeyframeIndex) {
    if (index < 0 || index >= state.keyframes.length) return;
    const [removed] = state.keyframes.splice(index, 1);
    state.selectedKeyframeIndex = Math.min(index, state.keyframes.length - 1);
    persistKeyframes();
    renderKeyframeList();
    rebuildAndRefreshSplineAnimation();
    console.log(`Keyframe deleted: ${removed?.name ?? index}`);
}

function clearKeyframes() {
    state.keyframes = [];
    state.selectedKeyframeIndex = -1;
    stopSplineAnimation();
    state.splineAnimationCurveCache = null;
    state.splineAnimationHandleIndices = [];
    persistKeyframes();
    renderKeyframeList();
}

function normalizeImportedKeyframes(payload) {
    const rawKeyframes = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.keyframes)
            ? payload.keyframes
            : [];

    return rawKeyframes.map((kf, idx) => ({
        id: kf?.id || `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
        name: kf?.name || `Keyframe ${idx + 1}`,
        createdAt: kf?.createdAt || new Date().toISOString(),
        selectedBoneIndices: Array.isArray(kf?.selectedBoneIndices) ? kf.selectedBoneIndices : [],
        fixedBoneIndices: Array.isArray(kf?.fixedBoneIndices) ? kf.fixedBoneIndices : [],
        activeBoneIndex: Number.isInteger(kf?.activeBoneIndex) ? kf.activeBoneIndex : -1,
        handleIndices: Array.isArray(kf?.handleIndices) ? kf.handleIndices : [],
        handlePositions: Array.isArray(kf?.handlePositions) ? kf.handlePositions : [],
        restPositions: Array.isArray(kf?.restPositions) ? kf.restPositions : [],
        currentPositions: Array.isArray(kf?.currentPositions) ? kf.currentPositions : [],
        rotations: Array.isArray(kf?.rotations) ? kf.rotations : [],
        globalTransform: Array.isArray(kf?.globalTransform) ? kf.globalTransform : new THREE.Matrix4().identity().toArray(),
    }));
}

function exportKeyframesToFile() {
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        sourceDataPath: state.activeDataPath || '',
        keyframes: state.keyframes,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `skinning_keyframes_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    console.log(`Keyframes exported: ${state.keyframes.length}`);
}

function triggerKeyframeImport() {
    const input = document.getElementById('keyframeFileInput');
    if (!input) return;
    input.value = '';
    input.click();
}

async function handleKeyframeFileImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const imported = normalizeImportedKeyframes(parsed);

        if (!imported.length) {
            throw new Error('키프레임 데이터가 없습니다.');
        }

        state.keyframes = imported;
        state.selectedKeyframeIndex = 0;
        stopSplineAnimation();
        persistKeyframes();
        renderKeyframeList();
        rebuildAndRefreshSplineAnimation();
        syncSplineAnimationUI();
        console.log(`Keyframes imported: ${imported.length} from ${file.name}`);
    } catch (error) {
        console.error('Failed to import keyframes:', error);
        alert(`키프레임 파일을 불러오지 못했습니다.\n${error?.message || error}`);
    }
}

function getKeyframePositionMap(keyframe) {
    const map = new Map();
    if (!keyframe) return map;

    for (const item of keyframe.handlePositions || []) {
        if (Number.isInteger(item.index) && Array.isArray(item.position) && item.position.length >= 3) {
            map.set(item.index, new THREE.Vector3().fromArray(item.position));
        }
    }

    if (map.size === 0 && Array.isArray(keyframe.currentPositions)) {
        for (const idx of keyframe.handleIndices || []) {
            const pos = keyframe.currentPositions[idx];
            if (Array.isArray(pos) && pos.length >= 3) {
                map.set(idx, new THREE.Vector3().fromArray(pos));
            }
        }
    }

    return map;
}

function getTrackPointForKeyframe(keyframe, boneIndex) {
    const positionMap = getKeyframePositionMap(keyframe);
    const direct = positionMap.get(boneIndex);
    if (direct) return direct.clone();

    const fallback = Array.isArray(keyframe?.currentPositions) ? keyframe.currentPositions[boneIndex] : null;
    if (Array.isArray(fallback) && fallback.length >= 3) return new THREE.Vector3().fromArray(fallback);

    return state.arap?.restPositions?.[boneIndex]?.clone?.() ?? new THREE.Vector3();
}

function rebuildSplineAnimationCache() {
    const keyframes = state.keyframes;
    if (!keyframes || keyframes.length < 2 || !state.arap) {
        state.splineAnimationCurveCache = null;
        state.splineAnimationHandleIndices = [];
        return null;
    }

    const handleSet = new Set();
    for (const kf of keyframes) {
        for (const idx of (kf.handleIndices || [])) {
            if (Number.isInteger(idx)) handleSet.add(idx);
        }
    }

    const handleIndices = [...handleSet].sort((a, b) => a - b);
    const tracks = new Map();

    for (const boneIndex of handleIndices) {
        const points = keyframes.map((kf) => getTrackPointForKeyframe(kf, boneIndex));
        if (points.length >= 3) {
            tracks.set(boneIndex, new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.5));
        } else if (points.length === 2) {
            tracks.set(boneIndex, {
                getPoint: (t, target = new THREE.Vector3()) => target.lerpVectors(points[0], points[1], t),
            });
        }
    }

    state.splineAnimationCurveCache = tracks;
    state.splineAnimationHandleIndices = handleIndices;
    return tracks;
}

function applySplineAnimationPhase(phase) {
    if (!state.arap || !state.splineAnimationCurveCache || state.splineAnimationHandleIndices.length === 0) return;

    const handles = new Map();
    const normalized = ((phase % 1) + 1) % 1;

    for (const boneIndex of state.splineAnimationHandleIndices) {
        const curve = state.splineAnimationCurveCache.get(boneIndex);
        if (!curve) continue;
        const target = new THREE.Vector3();
        curve.getPoint(normalized, target);
        handles.set(boneIndex, target);
        if (state.arap.currentPositions[boneIndex]) {
            state.arap.currentPositions[boneIndex].copy(target);
        }
    }

    if (handles.size > 0) {
        solveArap(handles, state.splineAnimationIterations);
    }
}

function startSplineAnimation() {
    if (!state.keyframes || state.keyframes.length < 2) {
        console.warn('키프레임이 최소 2개는 있어야 Catmull-Rom 애니메이션을 재생할 수 있습니다.');
        return;
    }

    rebuildSplineAnimationCache();
    if (!state.splineAnimationCurveCache || state.splineAnimationHandleIndices.length === 0) {
        console.warn('애니메이션용 handle을 만들 수 없습니다.');
        return;
    }

    const startIdx = state.selectedKeyframeIndex >= 0 ? state.selectedKeyframeIndex : 0;
    state.splineAnimationPhaseOffset = startIdx / Math.max(1, state.keyframes.length);
    state.splineAnimationTime = 0;
    state.splineAnimationPlaying = true;
    syncSplineAnimationUI();
}

function stopSplineAnimation() {
    state.splineAnimationPlaying = false;
    syncSplineAnimationUI();
}

function toggleSplineAnimation() {
    if (state.splineAnimationPlaying) stopSplineAnimation();
    else startSplineAnimation();
}

function updateSplineAnimation(delta) {
    if (!state.splineAnimationPlaying) return;
    if (!state.splineAnimationCurveCache || state.splineAnimationHandleIndices.length === 0) {
        rebuildSplineAnimationCache();
        if (!state.splineAnimationCurveCache || state.splineAnimationHandleIndices.length === 0) {
            stopSplineAnimation();
            return;
        }
    }

    const speed = Math.max(0.01, state.splineAnimationSpeed || 1.0);
    state.splineAnimationTime += delta * speed;
    const phase = (state.splineAnimationPhaseOffset + state.splineAnimationTime) % 1;
    applySplineAnimationPhase(phase);
}

function syncSplineAnimationUI() {
    const status = document.getElementById('splineAnimStatus');
    const startBtn = document.getElementById('startSplineAnimBtn');
    const stopBtn = document.getElementById('stopSplineAnimBtn');
    const rebuildBtn = document.getElementById('rebuildSplineAnimBtn');
    const ready = !!state.splineAnimationCurveCache && state.splineAnimationHandleIndices.length > 0;

    if (status) {
        status.textContent = state.splineAnimationPlaying
            ? `재생 중 · handles ${state.splineAnimationHandleIndices.length}`
            : ready ? `대기 중 · handles ${state.splineAnimationHandleIndices.length}` : '준비되지 않음';
    }
    if (startBtn) startBtn.disabled = !ready && state.keyframes.length < 2;
    if (stopBtn) stopBtn.disabled = !state.splineAnimationPlaying;
    if (rebuildBtn) rebuildBtn.disabled = state.keyframes.length < 2;
}

function rebuildAndRefreshSplineAnimation() {
    rebuildSplineAnimationCache();
    syncSplineAnimationUI();
}

function setSplineAnimationSpeed() {
    const value = parseFloat(document.getElementById('splineAnimSpeed')?.value || '1');
    state.splineAnimationSpeed = Number.isFinite(value) ? value : 1.0;
    const label = document.getElementById('splineAnimSpeedValue');
    if (label) label.textContent = state.splineAnimationSpeed.toFixed(2) + '×';
}

window.setSplineAnimationSpeed = setSplineAnimationSpeed;
window.startSplineAnimation = startSplineAnimation;
window.stopSplineAnimation = stopSplineAnimation;
window.toggleSplineAnimation = toggleSplineAnimation;
window.rebuildSplineAnimation = rebuildAndRefreshSplineAnimation;
window.exportKeyframesToFile = exportKeyframesToFile;
window.importKeyframesFromFile = triggerKeyframeImport;
window.handleKeyframeFileImport = handleKeyframeFileImport;

window.registerKeyframe = registerKeyframe;
window.applySelectedKeyframe = () => applyKeyframe();
window.deleteSelectedKeyframe = () => deleteKeyframe();
window.clearKeyframes = clearKeyframes;

function visualizeSkinningPoints() {
    // Clear previous bone visualizations
    if (state.boneMeshes.length > 0) {
        state.boneMeshes.forEach(m => state.contentGroup.remove(m));
    }
    state.boneMeshes = [];

    const sphereGeo = new THREE.SphereGeometry(0.02, 16, 16);
    const positions = state.arap?.currentPositions ?? state.skinningPoints;
    
    positions.forEach((point) => {
        const material = new THREE.MeshStandardMaterial({
            color: 0x4488ff,
            emissive: 0x2244ff,
            emissiveIntensity: 0.5,
            depthTest: false,
        });
        
        const sphere = new THREE.Mesh(sphereGeo, material);
        sphere.position.copy(point);
        sphere.renderOrder = 999;
        state.contentGroup.add(sphere);
        state.boneMeshes.push(sphere);
    });

    syncSelectionToUI();
}

function getSplatCountAndCenters(splatMesh) {
    const splatCount = splatMesh?.getSplatCount?.() ?? 0;
    const centers = [];

    if (!splatMesh || splatCount <= 0) {
        return { splatCount: 0, centers };
    }

    if (typeof splatMesh.getSplatCenter === 'function') {
        const tmp = new THREE.Vector3();
        for (let i = 0; i < splatCount; i++) {
            splatMesh.getSplatCenter(i, tmp);
            centers.push(tmp.clone());
        }
        return { splatCount, centers };
    }

    const buffer = splatMesh.scenes?.[0]?.splatBuffer ?? splatMesh.splatBuffers?.[0];
    const rawCenters = buffer?.centers || buffer?.getCenters?.();
    if (rawCenters) {
        for (let i = 0; i < splatCount; i++) {
            centers.push(new THREE.Vector3(rawCenters[i * 3], rawCenters[i * 3 + 1], rawCenters[i * 3 + 2]));
        }
    }
    return { splatCount, centers };
}

function setupGaussianSkinning() {
    const splatMesh = state.viewer?.splatMesh;
    if (!splatMesh || !state.arap) return;

    const mat = splatMesh.material;
    const texSize = mat?.uniforms?.centersColorsTextureSize?.value;
    if (!mat || !texSize) return;

    const texW = Math.max(1, texSize.x | 0);
    const texH = Math.max(1, texSize.y | 0);
    const splatCount = splatMesh.getSplatCount?.() ?? (texW * texH);
    const { centers } = getSplatCountAndCenters(splatMesh);

    // Create and initialize bone transformation texture
    state.boneTextureWidth = state.arap.currentPositions.length * 4;
    state.boneTextureHeight = 1;
    const boneData = new Float32Array(state.boneTextureWidth * state.boneTextureHeight * 4);
    updateBoneTextureData(boneData);
    state.boneTexture = new THREE.DataTexture(boneData, state.boneTextureWidth, state.boneTextureHeight, THREE.RGBAFormat, THREE.FloatType);
    state.boneTexture.internalFormat = 'RGBA32F';
    state.boneTexture.minFilter = THREE.NearestFilter;
    state.boneTexture.magFilter = THREE.NearestFilter;
    state.boneTexture.needsUpdate = true;

    // Compute per-splat bone influence indices and weights
    const skinIndices = new Float32Array(texW * texH * 4);
    const skinWeights = new Float32Array(texW * texH * 4);
    const sigma = 5.0;
    for (let i = 0; i < Math.min(centers.length, splatCount); i++) {
        const center = centers[i];
        const allWeights = state.arap.restPositions.map((bonePos, idx) => {
            const dist = center.distanceTo(bonePos);
            const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
            return { index: idx, weight: w };
        }).sort((a, b) => b.weight - a.weight).slice(0, 4);

        const sum = Math.max(allWeights.reduce((acc, item) => acc + item.weight, 0), 1e-5);
        for (let j = 0; j < 4; j++) {
            const item = allWeights[j] || { index: 0, weight: 0 };
            skinIndices[i * 4 + j] = item.index;
            skinWeights[i * 4 + j] = item.weight / sum;
        }
    }

    state.skinIndicesTexture = new THREE.DataTexture(skinIndices, texW, texH, THREE.RGBAFormat, THREE.FloatType);
    state.skinIndicesTexture.internalFormat = 'RGBA32F';
    state.skinIndicesTexture.minFilter = THREE.NearestFilter;
    state.skinIndicesTexture.magFilter = THREE.NearestFilter;
    state.skinIndicesTexture.needsUpdate = true;

    state.skinWeightsTexture = new THREE.DataTexture(skinWeights, texW, texH, THREE.RGBAFormat, THREE.FloatType);
    state.skinWeightsTexture.internalFormat = 'RGBA32F';
    state.skinWeightsTexture.minFilter = THREE.NearestFilter;
    state.skinWeightsTexture.magFilter = THREE.NearestFilter;
    state.skinWeightsTexture.needsUpdate = true;

    mat.uniforms.boneTexture = { value: state.boneTexture };
    mat.uniforms.boneTextureWidth = { value: state.boneTextureWidth };
    mat.uniforms.boneTextureHeight = { value: state.boneTextureHeight };
    mat.uniforms.skinIndicesTexture = { value: state.skinIndicesTexture };
    mat.uniforms.skinWeightsTexture = { value: state.skinWeightsTexture };

    const injection = getGaussianSplatLBSInjection();
    if (!mat.vertexShader?.includes('skinIndicesTexture') && mat.vertexShader) {
        let vs = mat.vertexShader;
        vs = vs.replace(/void\s+main\s*\(\s*\)\s*\{/, injection.mainFunctionPrefix);
        vs = vs.replace(
            /vec3\s+splatCenter\s*=\s*uintBitsToFloat\s*\(\s*uvec3\s*\(\s*sampledCenterColor\s*\.\s*gba\s*\)\s*\)\s*;/,
            `vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));\n            ${injection.splatCenterModification}`
        );
        mat.vertexShader = vs;
        mat.needsUpdate = true;
    }

    state.splatSkinningReady = true;
    console.log('Gaussian splat Linear Blend Skinning initialized successfully');
}

function updateBoneTextureData(boneData) {
    if (!state.arap) return;
    const { currentPositions, restPositions, rotations } = state.arap;
    const count = Math.min(currentPositions.length, restPositions.length, rotations.length);

    for (let i = 0; i < count; i++) {
        const p = currentPositions[i];
        const rest = restPositions[i];
        const R = rotations[i];

        const mCurrent = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
        const mRot = new THREE.Matrix4().setFromMatrix3(R);
        const mRestInv = new THREE.Matrix4().makeTranslation(-rest.x, -rest.y, -rest.z);
        mCurrent.multiply(mRot).multiply(mRestInv);

        const arr = mCurrent.toArray();
        const offset = i * 16;
        for (let k = 0; k < 16; k++) {
            boneData[offset + k] = arr[k];
        }
    }
}

function refreshGaussianBoneTexture() {
    if (!state.splatSkinningReady || !state.boneTexture || !state.arap) return;
    const data = state.boneTexture.image.data;
    updateBoneTextureData(data);
    state.boneTexture.needsUpdate = true;
}

window.setGSScale = function() {
    const scale = parseFloat(document.getElementById('gsScale').value);
    document.getElementById('gsScaleValue').textContent = scale.toFixed(1);
    if (state.contentGroup) state.contentGroup.scale.setScalar(scale);
};

window.setGSAlpha = function() {
    const alpha = parseFloat(document.getElementById('gsAlpha').value);
    document.getElementById('gsAlphaValue').textContent = alpha.toFixed(2);
    if (state.viewer?.splatMesh?.material?.uniforms?.opacity) {
        state.viewer.splatMesh.material.uniforms.opacity.value = alpha;
        if (state.viewer.splatMesh.material.needsUpdate !== undefined) {
            state.viewer.splatMesh.material.needsUpdate = true;
        }
    }
};

window.updateBoneRotation = function() {
    const rotX = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotX').value || 0));
    const rotY = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotY').value || 0));
    const rotZ = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotZ').value || 0));

    document.getElementById('rotXValue').textContent = `${document.getElementById('rotX').value}°`;
    document.getElementById('rotYValue').textContent = `${document.getElementById('rotY').value}°`;
    document.getElementById('rotZValue').textContent = `${document.getElementById('rotZ').value}°`;

    const euler = new THREE.Euler(rotX, rotY, rotZ, 'XYZ');
    state.globalTransform = new THREE.Matrix4().makeRotationFromEuler(euler);
    if (state.contentGroup) state.contentGroup.quaternion.setFromEuler(euler);
};

window.updateSelectedBone = function() {
    const boneIdx = parseInt(document.getElementById('selectedBone').value);
    setBoneSelection([boneIdx], boneIdx, true);
};

window.updateCameraDistance = function() {
    const dist = parseFloat(document.getElementById('cameraDist').value);
    document.getElementById('cameraDistValue').textContent = dist;
    const dir = state.camera.position.clone().sub(state.controls.target).normalize();
    state.camera.position.copy(state.controls.target).addScaledVector(dir, dist);
};

window.resetRig = function() {
    if (!state.arap) {
        console.warn('resetRig: ARAP deformation system has not been initialized');
        return;
    }

    state.controls.enabled = true;
    state.isDraggingBone = false;
    state.dragStartPositions.clear();

    // Restore ARAP deformation system to rest pose
    state.arap.clearHandles?.();
    for (let i = 0; i < state.arap.restPositions.length; i++) {
        state.arap.currentPositions[i].copy(state.arap.restPositions[i]);
        if (state.arap.rotations[i]) state.arap.rotations[i].identity();
    }

    // Clear bone selection state
    state.selectedBoneIndices = [];
    state.activeBoneIndex = -1;
    state.fixedBoneIndices.clear();
    stopSplineAnimation();
    if (document.getElementById('selectedBone')) document.getElementById('selectedBone').value = '0';
    if (document.getElementById('selectedBoneValue')) document.getElementById('selectedBoneValue').textContent = 'none';

    // Synchronize deformation system state to visual representations
    syncArapToMeshes();
    syncSelectionToUI();
    refreshGaussianBoneTexture();
    syncSplineAnimationUI();

    console.log('Rig reset to rest pose');
};

function onWindowResize() {
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(window.innerWidth, window.innerHeight);
}

function setSelectedBone(index, updateSlider = true) {
    setBoneSelection([index], index, updateSlider);
}

function clearBoneSelection() {
    state.selectedBoneIndices = [];
    state.activeBoneIndex = -1;
    if (document.getElementById('selectedBoneValue')) {
        document.getElementById('selectedBoneValue').textContent = 'none';
    }
    if (document.getElementById('selectedBone')) {
        document.getElementById('selectedBone').value = '0';
    }
    syncSelectionToUI();
}

function syncSelectionToUI() {
    const selectedSet = new Set(state.selectedBoneIndices);
    state.boneMeshes.forEach((mesh, i) => {
        const selected = selectedSet.has(i);
        const active = i === state.activeBoneIndex;
        const fixed = state.fixedBoneIndices.has(i);
        const material = mesh.material;
        if (material) {
            // Fixed/static bones are green, moving bones are red/orange, normal is blue
            if (fixed) {
                material.color.set(0x00dd66);
                material.emissive.set(0x009944);
                material.emissiveIntensity = 0.8;
            } else if (selected) {
                material.color.set(active ? 0xff5544 : 0xff3333);
                material.emissive.set(active ? 0x884433 : 0x661111);
                material.emissiveIntensity = active ? 1.0 : 0.9;
            } else {
                material.color.set(0x4488ff);
                material.emissive.set(0x2244ff);
                material.emissiveIntensity = 0.5;
            }
        }
        mesh.scale.setScalar(fixed ? 2.0 : active ? 1.8 : selected ? 1.5 : 1.0);
    });

    if (document.getElementById('selectedBoneValue')) {
        document.getElementById('selectedBoneValue').textContent =
            state.selectedBoneIndices.length > 0 ? state.selectedBoneIndices.join(',') : 'none';
    }
}

function setBoneSelection(indices, activeIndex = indices?.[0] ?? -1, updateSlider = true) {
    const maxIdx = Math.max(0, state.boneMeshes.length - 1);
    // Filter out fixed bones - they cannot be selected
    const filtered = [...new Set((indices || [])
        .filter((i) => Number.isFinite(i) && !state.fixedBoneIndices.has(i))
        .map((i) => THREE.MathUtils.clamp(i, 0, maxIdx)))];
    state.selectedBoneIndices = filtered;
    state.activeBoneIndex = filtered.includes(activeIndex) ? activeIndex : (filtered[0] ?? -1);

    if (updateSlider && document.getElementById('selectedBone')) {
        document.getElementById('selectedBone').value = state.activeBoneIndex >= 0 ? String(state.activeBoneIndex) : '0';
    }

    syncSelectionToUI();
}

function toggleBoneSelection(index) {
    // Cannot select fixed bones
    if (state.fixedBoneIndices.has(index)) {
        return;
    }
    const next = new Set(state.selectedBoneIndices);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setBoneSelection([...next], index, true);
}

function toggleBoneFixed(index) {
    if (state.fixedBoneIndices.has(index)) {
        state.fixedBoneIndices.delete(index);
    } else {
        state.fixedBoneIndices.add(index);
    }
    syncSelectionToUI();
}

function buildArapSystem(restPositions, neighborCount = 6) {
    // Initialize ARAP (As-Rigid-As-Possible) deformation system
    const n = restPositions.length;
    const rest = restPositions.map((p) => p.clone());
    const current = restPositions.map((p) => p.clone());
    const rotations = Array.from({ length: n }, () => new THREE.Matrix3().identity());
    const edges = Array.from({ length: n }, () => []);

    // Build k-nearest neighbor graph for deformation constraints
    for (let i = 0; i < n; i++) {
        const distances = [];
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            distances.push({ j, d: rest[i].distanceTo(rest[j]) });
        }
        distances.sort((a, b) => a.d - b.d);
        for (let k = 0; k < Math.min(neighborCount, distances.length); k++) {
            const j = distances[k].j;
            if (!edges[i].includes(j)) edges[i].push(j);
            if (!edges[j].includes(i)) edges[j].push(i);
        }
    }

    return { restPositions: rest, currentPositions: current, rotations, edges };
}

function solveArap(handles, iterations = 4) {
    if (!state.arap) return;
    const { restPositions, currentPositions, rotations, edges } = state.arap;

    for (let iter = 0; iter < iterations; iter++) {
        // ARAP local step: extract per-vertex rotations via polar decomposition
        for (let i = 0; i < currentPositions.length; i++) {
            const p_i = currentPositions[i];
            const r_i = restPositions[i];
            let S = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);

            for (const j of edges[i]) {
                const dp = currentPositions[j].clone().sub(p_i);
                const dr = restPositions[j].clone().sub(r_i);
                const outer = outerProduct3(dp, dr);
                for (let k = 0; k < 9; k++) S.elements[k] += outer.elements[k];
            }

            rotations[i] = extractRotation3D(S);
        }

        // ARAP global step: update vertex positions using rotation constraints
        for (let i = 0; i < currentPositions.length; i++) {
            if (handles.has(i)) {
                currentPositions[i].copy(handles.get(i));
                continue;
            }

            const neighbors = edges[i];
            if (!neighbors.length) continue;

            const r_i = restPositions[i];
            const R_i = rotations[i];
            const posSum = new THREE.Vector3();

            for (const j of neighbors) {
                const p_j = currentPositions[j];
                const r_j = restPositions[j];
                const R_j = rotations[j];
                const dr = r_i.clone().sub(r_j);
                const rotated_dr = dr.clone()
                    .applyMatrix3(R_i)
                    .add(dr.clone().applyMatrix3(R_j))
                    .multiplyScalar(0.5);
                posSum.add(p_j.clone().add(rotated_dr));
            }

            const targetPos = posSum.divideScalar(neighbors.length);
            currentPositions[i].lerp(targetPos, 0.75);
        }
    }

    syncArapToMeshes();
    refreshGaussianBoneTexture();
}

function syncArapToMeshes() {
    if (!state.arap) return;
    for (let i = 0; i < state.boneMeshes.length; i++) {
        const mesh = state.boneMeshes[i];
        const pos = state.arap.currentPositions[i];
        if (mesh && pos) mesh.position.copy(pos);
    }
}

function getPointerNDC(event) {
    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
}

function onPointerDown(event) {
    if (!state.boneMeshes.length) return;
    getPointerNDC(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.boneMeshes, false);
    if (!hits.length) return;

    const hit = hits[0];
    const meshIndex = state.boneMeshes.indexOf(hit.object);
    if (meshIndex < 0) return;

    // Prevent dragging fixed bones
    if (state.fixedBoneIndices.has(meshIndex)) {
        return;
    }

    const modifier = event.shiftKey || event.ctrlKey || event.metaKey;
    if (modifier) {
        toggleBoneSelection(meshIndex);
        if (!state.selectedBoneIndices.includes(meshIndex)) return;
    } else {
        if (!state.selectedBoneIndices.includes(meshIndex)) {
            setBoneSelection([meshIndex], meshIndex, true);
        } else {
            // If already selected bone is clicked, preserve multi-selection and update active bone
            state.activeBoneIndex = meshIndex;
            syncSelectionToUI();
        }
    }

    if (state.activeBoneIndex < 0) return;

    state.isDraggingBone = true;
    state.controls.enabled = false;

    state.dragStartPositions.clear();
    for (const idx of state.selectedBoneIndices) {
        state.dragStartPositions.set(idx, state.arap.currentPositions[idx].clone());
    }

    const activeMesh = state.boneMeshes[state.activeBoneIndex];
    if (!activeMesh) return;

    const worldPos = new THREE.Vector3();
    activeMesh.getWorldPosition(worldPos);
    state.dragPlane.setFromNormalAndCoplanarPoint(state.camera.getWorldDirection(new THREE.Vector3()).clone().negate(), worldPos);
    state.dragOffset.copy(worldPos).sub(hit.point);
    state.dragActiveLocalStart.copy(state.dragStartPositions.get(state.activeBoneIndex) || activeMesh.position);
    state.renderer.domElement.style.cursor = 'grabbing';
}

function onPointerMove(event) {
    if (!state.isDraggingBone || state.activeBoneIndex < 0 || !state.arap) return;
    getPointerNDC(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);

    const dragPoint = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(state.dragPlane, dragPoint)) return;
    dragPoint.add(state.dragOffset);
    const localTarget = state.contentGroup.worldToLocal(dragPoint.clone());
    const delta = localTarget.clone().sub(state.dragActiveLocalStart);

    const handles = new Map();
    
    // Add fixed bones as immobile constraints to handles
    for (const fixedIdx of state.fixedBoneIndices) {
        handles.set(fixedIdx, state.arap.currentPositions[fixedIdx].clone());
    }
    
    // Add dragged bones with delta movement
    for (const idx of state.selectedBoneIndices) {
        const startPos = state.dragStartPositions.get(idx);
        if (!startPos) continue;
        const nextPos = startPos.clone().add(delta);
        handles.set(idx, nextPos);
        state.arap.currentPositions[idx].copy(nextPos);
        if (state.boneMeshes[idx]) state.boneMeshes[idx].position.copy(nextPos);
    }

    solveArap(handles, 4);
}

function onPointerUp() {
    if (!state.isDraggingBone) return;
    state.isDraggingBone = false;
    state.controls.enabled = true;
    state.renderer.domElement.style.cursor = 'default';
}

function onDoubleClick() {
    clearBoneSelection();
    onPointerUp();
}

function onContextMenu(event) {
    event.preventDefault();
    if (!state.boneMeshes.length) return;
    
    getPointerNDC(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.boneMeshes, false);
    if (!hits.length) return;

    const hit = hits[0];
    const meshIndex = state.boneMeshes.indexOf(hit.object);
    if (meshIndex < 0) return;

    // Shift+right-click for multi-fixed
    if (event.shiftKey) {
        toggleBoneFixed(meshIndex);
    } else {
        // Single right-click: clear all fixed, then add this one
        state.fixedBoneIndices.clear();
        toggleBoneFixed(meshIndex);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = state.frameClock.getDelta();
    updateSplineAnimation(delta);
    state.controls?.update();
    if (state.viewer && typeof state.viewer.update === 'function') {
        try { state.viewer.update(); } catch (e) {}
    }
    state.renderer.render(state.scene, state.camera);
}

window.loadData = loadData;