import * as THREE from 'three';
import { getGaussianSplatLBSInjection } from '../shaders.js';

export function getGaussianSplatCenters(splatMesh) {
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

export function createGaussianSkinningTextures(splatMesh, restPositions, { sigma = 5.0, topK = 4 } = {}) {
    const mat = splatMesh?.material;
    const texSize = mat?.uniforms?.centersColorsTextureSize?.value;
    if (!mat || !texSize || !Array.isArray(restPositions) || restPositions.length === 0) {
        return null;
    }

    const texW = Math.max(1, texSize.x | 0);
    const texH = Math.max(1, texSize.y | 0);
    const splatCount = splatMesh.getSplatCount?.() ?? (texW * texH);
    const { centers } = getGaussianSplatCenters(splatMesh);

    const skinIndices = new Float32Array(texW * texH * 4);
    const skinWeights = new Float32Array(texW * texH * 4);

    for (let i = 0; i < Math.min(centers.length, splatCount); i++) {
        const center = centers[i];
        const allWeights = restPositions
            .map((bonePos, idx) => {
                const dist = center.distanceTo(bonePos);
                const weight = Math.exp(-(dist * dist) / (2 * sigma * sigma));
                return { index: idx, weight };
            })
            .sort((a, b) => b.weight - a.weight)
            .slice(0, topK);

        const sum = Math.max(allWeights.reduce((acc, item) => acc + item.weight, 0), 1e-5);
        for (let j = 0; j < topK; j++) {
            const item = allWeights[j] || { index: 0, weight: 0 };
            skinIndices[i * 4 + j] = item.index;
            skinWeights[i * 4 + j] = item.weight / sum;
        }
    }

    const skinIndicesTexture = new THREE.DataTexture(skinIndices, texW, texH, THREE.RGBAFormat, THREE.FloatType);
    skinIndicesTexture.internalFormat = 'RGBA32F';
    skinIndicesTexture.minFilter = THREE.NearestFilter;
    skinIndicesTexture.magFilter = THREE.NearestFilter;
    skinIndicesTexture.needsUpdate = true;

    const skinWeightsTexture = new THREE.DataTexture(skinWeights, texW, texH, THREE.RGBAFormat, THREE.FloatType);
    skinWeightsTexture.internalFormat = 'RGBA32F';
    skinWeightsTexture.minFilter = THREE.NearestFilter;
    skinWeightsTexture.magFilter = THREE.NearestFilter;
    skinWeightsTexture.needsUpdate = true;

    return {
        texW,
        texH,
        splatCount,
        centers,
        skinIndicesTexture,
        skinWeightsTexture,
    };
}

export function injectGaussianSplatLBS({
    splatMesh,
    restPositions,
    boneTexture,
    boneTextureWidth,
    boneTextureHeight,
    sigma = 5.0,
    topK = 4,
} = {}) {
    const mat = splatMesh?.material;
    if (!mat || !splatMesh || !Array.isArray(restPositions) || restPositions.length === 0 || !boneTexture) {
        return null;
    }

    const textures = createGaussianSkinningTextures(splatMesh, restPositions, { sigma, topK });
    if (!textures) return null;

    mat.uniforms.boneTexture = { value: boneTexture };
    mat.uniforms.boneTextureWidth = { value: boneTextureWidth };
    mat.uniforms.boneTextureHeight = { value: boneTextureHeight };
    mat.uniforms.skinIndicesTexture = { value: textures.skinIndicesTexture };
    mat.uniforms.skinWeightsTexture = { value: textures.skinWeightsTexture };

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

    return textures;
}
