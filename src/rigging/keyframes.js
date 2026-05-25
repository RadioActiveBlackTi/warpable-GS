import * as THREE from 'three';

function cloneVector3ArrayToJSON(vectors = []) {
    return vectors.map((v) => [v.x, v.y, v.z]);
}

function resolveKeyframePoint(keyframe, boneIndex, restPositions = []) {
    const handlePositions = Array.isArray(keyframe?.handlePositions) ? keyframe.handlePositions : [];
    for (const item of handlePositions) {
        if (Number.isInteger(item?.index) && item.index === boneIndex && Array.isArray(item.position) && item.position.length >= 3) {
            return new THREE.Vector3().fromArray(item.position);
        }
    }

    const currentPositions = Array.isArray(keyframe?.currentPositions) ? keyframe.currentPositions : [];
    const current = currentPositions[boneIndex];
    if (Array.isArray(current) && current.length >= 3) {
        return new THREE.Vector3().fromArray(current);
    }

    const rest = restPositions[boneIndex];
    if (rest && typeof rest.clone === 'function') {
        return rest.clone();
    }

    return new THREE.Vector3();
}

export function createKeyframeSnapshot({
    name,
    arap,
    selectedBoneIndices = [],
    fixedBoneIndices = [],
    activeBoneIndex = -1,
    globalTransform = new THREE.Matrix4(),
} = {}) {
    if (!arap) return null;

    const selected = [...new Set(selectedBoneIndices.filter((i) => Number.isInteger(i)))];
    const fixed = [...new Set(fixedBoneIndices.filter((i) => Number.isInteger(i)))];
    const handleIndices = [...new Set([...selected, ...fixed])];

    if (handleIndices.length === 0) return null;

    return {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: name?.trim() || 'Keyframe',
        createdAt: new Date().toISOString(),
        selectedBoneIndices: selected,
        fixedBoneIndices: fixed,
        activeBoneIndex,
        handleIndices,
        handlePositions: handleIndices.map((index) => ({
            index,
            position: arap.currentPositions[index]?.toArray?.() ?? [0, 0, 0],
        })),
        restPositions: cloneVector3ArrayToJSON(arap.restPositions),
        currentPositions: cloneVector3ArrayToJSON(arap.currentPositions),
        rotations: arap.rotations.map((m) => (m?.toArray?.() ?? new THREE.Matrix3().identity().toArray())),
        globalTransform: globalTransform?.toArray?.() ?? new THREE.Matrix4().identity().toArray(),
    };
}

export function normalizeKeyframePayload(payload) {
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

export function exportKeyframePayload({ keyframes = [], sourceDataPath = '' } = {}) {
    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        sourceDataPath,
        keyframes,
    };
}

export function buildLoopingCatmullRomTracks(keyframes = [], restPositions = []) {
    if (!Array.isArray(keyframes) || keyframes.length < 2) return new Map();

    const handleSet = new Set();
    for (const kf of keyframes) {
        for (const idx of (kf?.handleIndices || [])) {
            if (Number.isInteger(idx)) handleSet.add(idx);
        }
    }

    const tracks = new Map();
    for (const boneIndex of [...handleSet].sort((a, b) => a - b)) {
        const points = keyframes.map((kf) => resolveKeyframePoint(kf, boneIndex, restPositions));
        if (points.length >= 3) {
            tracks.set(boneIndex, new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.5));
        } else if (points.length === 2) {
            tracks.set(boneIndex, {
                getPoint: (t, target = new THREE.Vector3()) => target.lerpVectors(points[0], points[1], t),
            });
        }
    }
    return tracks;
}

export class LoopingKeyframeAnimator {
    constructor({
        keyframes = [],
        restPositions = [],
        onApplyHandles = null,
        onStatusChange = null,
        speed = 1.0,
        iterations = 10,
    } = {}) {
        this.keyframes = keyframes;
        this.restPositions = restPositions;
        this.onApplyHandles = onApplyHandles;
        this.onStatusChange = onStatusChange;
        this.speed = speed;
        this.iterations = iterations;
        this.playing = false;
        this.time = 0;
        this.phaseOffset = 0;
        this.tracks = new Map();
    }

    setKeyframes(keyframes) {
        this.keyframes = Array.isArray(keyframes) ? keyframes : [];
        this.rebuild();
    }

    setRestPositions(restPositions) {
        this.restPositions = Array.isArray(restPositions) ? restPositions : [];
        this.rebuild();
    }

    setSpeed(speed) {
        this.speed = Number.isFinite(speed) ? speed : this.speed;
    }

    rebuild() {
        this.tracks = buildLoopingCatmullRomTracks(this.keyframes, this.restPositions);
        this._emitStatus();
        return this.tracks;
    }

    play(startPhase = 0) {
        if (this.keyframes.length < 2) return false;
        if (!this.tracks || this.tracks.size === 0) this.rebuild();
        if (!this.tracks || this.tracks.size === 0) return false;
        this.phaseOffset = ((startPhase % 1) + 1) % 1;
        this.time = 0;
        this.playing = true;
        this._emitStatus();
        return true;
    }

    stop() {
        this.playing = false;
        this._emitStatus();
    }

    toggle(startPhase = 0) {
        if (this.playing) {
            this.stop();
            return false;
        }
        return this.play(startPhase);
    }

    update(deltaTime = 0) {
        if (!this.playing || !this.tracks || this.tracks.size === 0) return null;

        const speed = Math.max(0.01, this.speed || 1.0);
        this.time += deltaTime * speed;
        const phase = (this.phaseOffset + this.time) % 1;
        const handles = new Map();
        const normalized = ((phase % 1) + 1) % 1;

        for (const [boneIndex, curve] of this.tracks.entries()) {
            const target = new THREE.Vector3();
            curve.getPoint(normalized, target);
            handles.set(boneIndex, target);
        }

        if (typeof this.onApplyHandles === 'function') {
            this.onApplyHandles(handles, {
                phase: normalized,
                time: this.time,
                iterations: this.iterations,
            });
        }

        return handles;
    }

    getStatus() {
        return {
            playing: this.playing,
            trackCount: this.tracks?.size || 0,
            handleCount: this.tracks?.size || 0,
            keyframeCount: this.keyframes?.length || 0,
        };
    }

    _emitStatus() {
        if (typeof this.onStatusChange === 'function') {
            this.onStatusChange(this.getStatus());
        }
    }
}
