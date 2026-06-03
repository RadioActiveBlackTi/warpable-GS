import * as THREE from 'three';

/**
 * Native4DGSRuntime
 *
 * This is a renderer-side interface for a future learned 4DGS deformation model.
 * It does not invent procedural motion. If no model asset is supplied, it creates a zero-deformation backend.
 *
 * Supported manifest v1:
 *
 * {
 *   "type": "native4dgs-runtime-v1",
 *   "backend": "lowrank_texture" | "zero",
 *   "frameCount": 120,
 *   "fps": 24,
 *   "rank": 16,
 *   "loop": true,
 *   "displacementScale": 1.0,
 *   "basisPath": "native4dgs_basis_rank16_rgba32f.bin",
 *   "weightsPath": "native4dgs_weights_rank16_rgba32f.bin"
 * }
 *
 * lowrank_texture backend:
 *   basis texture shape   = [splatCount, rank, RGBA32F]
 *   weights texture shape = [frameCount, rank, RGBA32F]
 *
 * Deformation evaluated in the splat vertex shader:
 *   Δx_i(t) = Σ_k weights[t, k].r * basis[i, k].rgb
 */

const MAX_SHADER_RANK = 32;

function resolveRelativeURL(baseURL, maybeRelativePath) {
    if (!maybeRelativePath) return null;
    return new URL(maybeRelativePath, baseURL).href;
}

async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch JSON ${url}: ${resp.status}`);
    return await resp.json();
}

async function fetchFloat32Array(url, expectedFloats = null) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch binary ${url}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const arr = new Float32Array(buf);
    if (expectedFloats !== null && arr.length !== expectedFloats) {
        throw new Error(`Unexpected float count for ${url}: got ${arr.length}, expected ${expectedFloats}`);
    }
    return arr;
}

function makeRGBAFloatTexture(data, width, height) {
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.internalFormat = 'RGBA32F';
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

function makeZeroRGBAFloatTexture(width, height) {
    return makeRGBAFloatTexture(new Float32Array(width * height * 4), width, height);
}

function injectNative4DGSShader(material) {
    if (!material || !material.vertexShader) return false;
    if (material.vertexShader.includes('uNative4DGSEnabled')) return true;

    const prefix = `
        uniform float uNative4DGSEnabled;
        uniform float uNative4DGSTime;
        uniform float uNative4DGSFrameCount;
        uniform float uNative4DGSRank;
        uniform float uNative4DGSDisplacementScale;
        uniform sampler2D uNative4DGSBasisTexture;
        uniform sampler2D uNative4DGSWeightsTexture;

        #define NATIVE4DGS_MAX_RANK ${MAX_SHADER_RANK}

        vec3 evalNative4DGSDelta(float splatIdx) {
            if (uNative4DGSEnabled < 0.5) return vec3(0.0);

            int sIdx = int(splatIdx);
            int rank = int(uNative4DGSRank);
            int frameCount = max(1, int(uNative4DGSFrameCount));

            float wrappedFrame = mod(uNative4DGSTime, float(frameCount));
            int f0 = int(floor(wrappedFrame));
            int f1 = int(mod(float(f0 + 1), float(frameCount)));
            float a = fract(wrappedFrame);

            vec3 d0 = vec3(0.0);
            vec3 d1 = vec3(0.0);

            for (int k = 0; k < NATIVE4DGS_MAX_RANK; ++k) {
                if (k >= rank) break;

                vec4 basis = texelFetch(uNative4DGSBasisTexture, ivec2(k, sIdx), 0);
                float w0 = texelFetch(uNative4DGSWeightsTexture, ivec2(k, f0), 0).r;
                float w1 = texelFetch(uNative4DGSWeightsTexture, ivec2(k, f1), 0).r;

                d0 += basis.rgb * w0;
                d1 += basis.rgb * w1;
            }

            return mix(d0, d1, a) * uNative4DGSDisplacementScale;
        }
    `;

    let vs = material.vertexShader;
    vs = prefix + '\n' + vs;

    const centerPattern = /vec3\s+splatCenter\s*=\s*uintBitsToFloat\s*\(\s*uvec3\s*\(\s*sampledCenterColor\s*\.\s*gba\s*\)\s*\)\s*;/;
    if (!centerPattern.test(vs)) {
        console.warn('[Native4DGSRuntime] Could not find splatCenter decode line. Shader not patched.');
        return false;
    }

    vs = vs.replace(
        centerPattern,
        `vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));
            splatCenter += evalNative4DGSDelta(splatIndex);`
    );

    material.vertexShader = vs;
    material.needsUpdate = true;
    return true;
}

export class Native4DGSRuntime {
    constructor() {
        this.manifestURL = null;
        this.manifest = null;
        this.splatCount = 0;
        this.rank = 1;
        this.frameCount = 1;
        this.fps = 24;
        this.loop = true;
        this.speed = 1.0;
        this.playing = true;
        this.timeInFrames = 0.0;
        this.displacementScale = 1.0;
        this.basisTexture = null;
        this.weightsTexture = null;
        this.attachedMaterial = null;
    }

    async load(manifestOrObject, options = {}) {
        if (typeof manifestOrObject === 'string') {
            this.manifestURL = manifestOrObject;
            this.manifest = await fetchJson(manifestOrObject);
        } else if (manifestOrObject && typeof manifestOrObject === 'object') {
            this.manifest = manifestOrObject;
            this.manifestURL = window.location.href;
        } else {
            this.manifest = { backend: 'zero' };
            this.manifestURL = window.location.href;
        }

        this.manifest = { ...this.manifest, ...options };
        this.rank = Math.min(Number(this.manifest.rank ?? 1), MAX_SHADER_RANK);
        this.frameCount = Math.max(1, Number(this.manifest.frameCount ?? this.manifest.frames ?? 1));
        this.fps = Number(this.manifest.fps ?? 24);
        this.speed = Number(this.manifest.speed ?? 1.0);
        this.loop = this.manifest.loop !== false;
        this.playing = this.manifest.playing !== false;
        this.timeInFrames = Number(this.manifest.startFrame ?? 0.0);
        this.displacementScale = Number(this.manifest.displacementScale ?? 1.0);

        return this;
    }

    async attachToSplatMesh(splatMesh, splatCountOverride = null) {
        if (!splatMesh?.material) throw new Error('Native4DGSRuntime.attachToSplatMesh: splatMesh material not ready');

        this.attachedMaterial = splatMesh.material;
        this.splatCount = Number(splatCountOverride ?? splatMesh.getSplatCount?.() ?? 0);
        if (this.splatCount <= 0) throw new Error('Native4DGSRuntime.attachToSplatMesh: splatCount is zero');

        const backend = this.manifest?.backend ?? 'zero';

        if (backend === 'lowrank_texture') {
            await this.loadLowRankTextures();
        } else {
            this.basisTexture = makeZeroRGBAFloatTexture(this.rank, this.splatCount);
            this.weightsTexture = makeZeroRGBAFloatTexture(this.rank, this.frameCount);
        }

        this.installUniforms(this.attachedMaterial);
        injectNative4DGSShader(this.attachedMaterial);

        console.log('[Native4DGSRuntime] attached', {
            backend,
            splatCount: this.splatCount,
            rank: this.rank,
            frameCount: this.frameCount,
            fps: this.fps,
        });

        return true;
    }

    async loadLowRankTextures() {
        const base = this.manifestURL || window.location.href;
        const basisURL = resolveRelativeURL(base, this.manifest.basisPath);
        const weightsURL = resolveRelativeURL(base, this.manifest.weightsPath);
        if (!basisURL || !weightsURL) {
            throw new Error('lowrank_texture backend requires basisPath and weightsPath');
        }

        const basisFloats = this.splatCount * this.rank * 4;
        const weightFloats = this.frameCount * this.rank * 4;

        const basis = await fetchFloat32Array(basisURL, basisFloats);
        const weights = await fetchFloat32Array(weightsURL, weightFloats);

        this.basisTexture = makeRGBAFloatTexture(basis, this.rank, this.splatCount);
        this.weightsTexture = makeRGBAFloatTexture(weights, this.rank, this.frameCount);
    }

    installUniforms(material) {
        material.uniforms.uNative4DGSEnabled = { value: 1.0 };
        material.uniforms.uNative4DGSTime = { value: this.timeInFrames };
        material.uniforms.uNative4DGSFrameCount = { value: this.frameCount };
        material.uniforms.uNative4DGSRank = { value: this.rank };
        material.uniforms.uNative4DGSDisplacementScale = { value: this.displacementScale };
        material.uniforms.uNative4DGSBasisTexture = { value: this.basisTexture };
        material.uniforms.uNative4DGSWeightsTexture = { value: this.weightsTexture };
    }

    update(deltaSeconds) {
        if (!this.playing || !this.attachedMaterial?.uniforms?.uNative4DGSTime) return;

        this.timeInFrames += deltaSeconds * this.fps * this.speed;

        if (this.loop) {
            this.timeInFrames = this.timeInFrames % this.frameCount;
        } else {
            this.timeInFrames = Math.min(this.timeInFrames, Math.max(0, this.frameCount - 1));
        }

        this.attachedMaterial.uniforms.uNative4DGSTime.value = this.timeInFrames;
    }

    setPlaying(v) {
        this.playing = !!v;
    }

    setDisplacementScale(v) {
        this.displacementScale = Number(v);
        if (this.attachedMaterial?.uniforms?.uNative4DGSDisplacementScale) {
            this.attachedMaterial.uniforms.uNative4DGSDisplacementScale.value = this.displacementScale;
        }
    }
}
