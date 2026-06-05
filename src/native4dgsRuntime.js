import * as THREE from 'three';

const MAX_SHADER_RANK = 32;
const BASIS_TEXTURE_MAX_WIDTH = 4096;
const BAKED_TEXTURE_WIDTH = 1024;
const YIELD_EVERY_SPLATS = 4096;

function resolveRelativeURL(baseURL, path) {
    if (!path) return null;
    return new URL(path, baseURL).href;
}

async function fetchJson(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Failed to fetch JSON ${url}: ${response.status}`
        );
    }

    return response.json();
}

async function fetchFloat32Array(url, expectedLength) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Failed to fetch binary ${url}: ${response.status}`
        );
    }

    const array = new Float32Array(
        await response.arrayBuffer()
    );

    if (
        expectedLength !== null &&
        array.length !== expectedLength
    ) {
        throw new Error(
            `Unexpected float count for ${url}: ` +
            `got ${array.length}, expected ${expectedLength}`
        );
    }

    return array;
}

async function fetchInt16Array(url, expectedLength) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Failed to fetch binary ${url}: ${response.status}`
        );
    }

    const array = new Int16Array(
        await response.arrayBuffer()
    );

    if (
        expectedLength !== null &&
        array.length !== expectedLength
    ) {
        throw new Error(
            `Unexpected int16 count for ${url}: ` +
            `got ${array.length}, expected ${expectedLength}`
        );
    }

    return array;
}

function makeRGBAFloatTexture(data, width, height) {
    const texture = new THREE.DataTexture(
        data,
        width,
        height,
        THREE.RGBAFormat,
        THREE.FloatType
    );

    texture.internalFormat = 'RGBA32F';
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;

    return texture;
}

function makeZeroTexture() {
    return makeRGBAFloatTexture(
        new Float32Array(4),
        1,
        1
    );
}

function yieldToBrowser() {
    return new Promise((resolve) => {
        requestAnimationFrame(resolve);
    });
}

async function packLowRankBasis(
    source,
    splatCount,
    rank
) {
    const splatsPerRow = Math.max(
        1,
        Math.floor(
            BASIS_TEXTURE_MAX_WIDTH /
            Math.max(rank, 1)
        )
    );

    const width = splatsPerRow * rank;
    const height = Math.ceil(
        splatCount / splatsPerRow
    );

    const packed = new Float32Array(
        width * height * 4
    );

    const valuesPerSplat = rank * 4;

    for (
        let splatIndex = 0;
        splatIndex < splatCount;
        splatIndex += 1
    ) {
        const row = Math.floor(
            splatIndex / splatsPerRow
        );

        const column =
            splatIndex % splatsPerRow;

        const sourceOffset =
            splatIndex * valuesPerSplat;

        const destinationOffset =
            (
                row * width +
                column * rank
            ) * 4;

        packed.set(
            source.subarray(
                sourceOffset,
                sourceOffset + valuesPerSplat
            ),
            destinationOffset
        );

        if (
            splatIndex > 0 &&
            splatIndex % YIELD_EVERY_SPLATS === 0
        ) {
            await yieldToBrowser();
        }
    }

    return {
        data: packed,
        width,
        height,
        splatsPerRow,
    };
}

function injectNative4DGSShader(material) {
    if (!material?.vertexShader) {
        return false;
    }

    if (
        material.vertexShader.includes(
            'uNative4DGSEnabled'
        )
    ) {
        return true;
    }

    const native4dgsGLSL = `
uniform float uNative4DGSEnabled;
uniform float uNative4DGSBackend;
uniform float uNative4DGSTime;
uniform float uNative4DGSFrameCount;
uniform float uNative4DGSRank;
uniform float uNative4DGSDisplacementScale;
uniform float uNative4DGSBasisSplatsPerRow;

uniform highp sampler2D uNative4DGSBasisTexture;
uniform highp sampler2D uNative4DGSWeightsTexture;
uniform highp sampler2D uNative4DGSBakedTextureA;
uniform highp sampler2D uNative4DGSBakedTextureB;

uniform vec2 uNative4DGSBakedTextureSize;
uniform float uNative4DGSBakedMix;

#define NATIVE4DGS_MAX_RANK ${MAX_SHADER_RANK}

vec3 evalNative4DGSLowRank(
    uint splatIdx
) {
    int splatIndexInt =
        int(splatIdx);

    int rank =
        int(uNative4DGSRank);

    int frameCount =
        max(
            1,
            int(uNative4DGSFrameCount)
        );

    float wrappedFrame =
        mod(
            uNative4DGSTime,
            float(frameCount)
        );

    int frameA =
        int(floor(wrappedFrame));

    int frameB =
        (frameA + 1) %
        frameCount;

    float frameMix =
        fract(wrappedFrame);

    int splatsPerRow =
        max(
            1,
            int(
                uNative4DGSBasisSplatsPerRow
            )
        );

    int basisRow =
        splatIndexInt /
        splatsPerRow;

    int basisSplatColumn =
        splatIndexInt %
        splatsPerRow;

    vec3 deltaA =
        vec3(0.0);

    vec3 deltaB =
        vec3(0.0);

    for (
        int rankIndex = 0;
        rankIndex < NATIVE4DGS_MAX_RANK;
        rankIndex++
    ) {
        if (rankIndex >= rank) {
            break;
        }

        int basisX =
            basisSplatColumn *
            rank +
            rankIndex;

        vec3 basis =
            texelFetch(
                uNative4DGSBasisTexture,
                ivec2(
                    basisX,
                    basisRow
                ),
                0
            ).rgb;

        float weightA =
            texelFetch(
                uNative4DGSWeightsTexture,
                ivec2(
                    rankIndex,
                    frameA
                ),
                0
            ).r;

        float weightB =
            texelFetch(
                uNative4DGSWeightsTexture,
                ivec2(
                    rankIndex,
                    frameB
                ),
                0
            ).r;

        deltaA +=
            basis *
            weightA;

        deltaB +=
            basis *
            weightB;
    }

    return mix(
        deltaA,
        deltaB,
        frameMix
    );
}

vec3 evalNative4DGSBaked(
    uint splatIdx
) {
    int splatIndexInt =
        int(splatIdx);

    int textureWidth =
        max(
            1,
            int(
                uNative4DGSBakedTextureSize.x
            )
        );

    ivec2 coordinate =
        ivec2(
            splatIndexInt %
                textureWidth,

            splatIndexInt /
                textureWidth
        );

    vec3 deltaA =
        texelFetch(
            uNative4DGSBakedTextureA,
            coordinate,
            0
        ).rgb;

    vec3 deltaB =
        texelFetch(
            uNative4DGSBakedTextureB,
            coordinate,
            0
        ).rgb;

    return mix(
        deltaA,
        deltaB,
        uNative4DGSBakedMix
    );
}

vec3 evalNative4DGSDelta(
    uint splatIdx
) {
    if (
        uNative4DGSEnabled <
        0.5
    ) {
        return vec3(0.0);
    }

    vec3 delta =
        vec3(0.0);

    if (
        uNative4DGSBackend <
        1.5
    ) {
        delta =
            evalNative4DGSLowRank(
                splatIdx
            );
    } else {
        delta =
            evalNative4DGSBaked(
                splatIdx
            );
    }

    return (
        delta *
        uNative4DGSDisplacementScale
    );
}
`;

    let vertexShader =
        material.vertexShader;

    const commonAnchor =
        '#include <common>';

    if (
        !vertexShader.includes(
            commonAnchor
        )
    ) {
        console.error(
            '[Native4DGSRuntime] ' +
            'Could not find #include <common>.'
        );

        return false;
    }

    vertexShader =
        vertexShader.replace(
            commonAnchor,
            `${commonAnchor}
${native4dgsGLSL}`
        );

    const centerPattern =
        /vec3\s+splatCenter\s*=\s*uintBitsToFloat\s*\(\s*uvec3\s*\(\s*sampledCenterColor\s*\.\s*gba\s*\)\s*\)\s*;/;

    if (
        !centerPattern.test(
            vertexShader
        )
    ) {
        console.error(
            '[Native4DGSRuntime] ' +
            'Could not find splatCenter decode line.'
        );

        return false;
    }

    vertexShader =
        vertexShader.replace(
            centerPattern,
            (matchedSource) => (
                `${matchedSource}
splatCenter += evalNative4DGSDelta(splatIndex);`
            )
        );

    material.vertexShader =
        vertexShader;

    material.needsUpdate =
        true;

    return true;
}

export class Native4DGSRuntime {
    constructor() {
        this.manifestURL = null;
        this.manifest = null;
        this.backend = 'zero';

        this.splatCount = 0;
        this.rank = 1;
        this.frameCount = 1;
        this.fps = 24;

        this.loop = true;
        this.speed = 1;
        this.playing = true;
        this.timeInFrames = 0;
        this.displacementScale = 1;

        this.basisTexture = null;
        this.weightsTexture = null;
        this.basisSplatsPerRow = 1;

        this.bakedMotion = null;
        this.bakedQuantScale =
            new Float32Array([1, 1, 1]);

        this.bakedTextureA = null;
        this.bakedTextureB = null;
        this.bakedTextureDataA = null;
        this.bakedTextureDataB = null;
        this.bakedTextureWidth = 1;
        this.bakedTextureHeight = 1;
        this.currentBakedFrameA = -1;
        this.currentBakedFrameB = -1;
        this.currentBakedMix = 0;

        this.attachedMaterial = null;
    }

    async load(
        manifestOrObject,
        options = {}
    ) {
        if (
            typeof manifestOrObject ===
            'string'
        ) {
            this.manifestURL =
                manifestOrObject;

            this.manifest =
                await fetchJson(
                    manifestOrObject
                );
        } else if (
            manifestOrObject &&
            typeof manifestOrObject ===
                'object'
        ) {
            this.manifestURL =
                window.location.href;

            this.manifest =
                manifestOrObject;
        } else {
            this.manifestURL =
                window.location.href;

            this.manifest = {
                backend: 'zero',
            };
        }

        this.manifest = {
            ...this.manifest,
            ...options,
        };

        this.backend =
            this.manifest.backend ??
            'zero';

        this.rank = Math.min(
            Math.max(
                1,
                Number(
                    this.manifest.rank ?? 1
                )
            ),
            MAX_SHADER_RANK
        );

        this.frameCount = Math.max(
            1,
            Number(
                this.manifest.frameCount ??
                this.manifest.frames ??
                1
            )
        );

        this.fps = Number(
            this.manifest.fps ?? 24
        );

        this.speed = Number(
            this.manifest.speed ?? 1
        );

        this.loop =
            this.manifest.loop !== false;

        this.playing =
            this.manifest.playing !== false;

        this.timeInFrames = Number(
            this.manifest.startFrame ?? 0
        );

        this.displacementScale = Number(
            this.manifest
                .displacementScale ?? 1
        );

        return this;
    }

    async attachToSplatMesh(
        splatMesh,
        splatCountOverride = null
    ) {
        if (!splatMesh?.material) {
            throw new Error(
                'Native4DGSRuntime: splat material is not ready'
            );
        }

        this.attachedMaterial =
            splatMesh.material;

        this.splatCount = Number(
            splatCountOverride ??
            splatMesh.getSplatCount?.() ??
            0
        );

        if (this.splatCount <= 0) {
            throw new Error(
                'Native4DGSRuntime: splat count is zero'
            );
        }

        const manifestCount = Number(
            this.manifest
                ?.gaussianCount ??
            this.splatCount
        );

        if (
            manifestCount !==
            this.splatCount
        ) {
            throw new Error(
                `Native4DGSRuntime: Gaussian count mismatch: ` +
                `PLY=${this.splatCount}, manifest=${manifestCount}`
            );
        }

        if (
            this.backend ===
            'lowrank_texture'
        ) {
            await this.loadLowRankTextures();
        } else if (
            this.backend ===
            'baked_keyframes_int16'
        ) {
            await this.loadBakedKeyframes();
        } else {
            this.createZeroTextures();
        }

        this.installUniforms(
            this.attachedMaterial
        );

        if (
            !injectNative4DGSShader(
                this.attachedMaterial
            )
        ) {
            throw new Error(
                'Native4DGSRuntime: failed to patch splat shader'
            );
        }

        if (
            this.backend ===
            'baked_keyframes_int16'
        ) {
            this.updateBakedTextures(
                this.timeInFrames
            );
        }

        console.log(
            '[Native4DGSRuntime] attached',
            {
                backend: this.backend,
                splatCount: this.splatCount,
                rank: this.rank,
                frameCount: this.frameCount,
                fps: this.fps,
            }
        );

        return true;
    }

    createZeroTextures() {
        this.backend = 'zero';

        this.basisTexture =
            makeZeroTexture();

        this.weightsTexture =
            makeZeroTexture();

        this.bakedTextureA =
            makeZeroTexture();

        this.bakedTextureB =
            makeZeroTexture();

        this.bakedTextureWidth = 1;
        this.bakedTextureHeight = 1;
    }

    async loadLowRankTextures() {
        const baseURL =
            this.manifestURL ||
            window.location.href;

        const basisURL =
            resolveRelativeURL(
                baseURL,
                this.manifest.basisPath
            );

        const weightsURL =
            resolveRelativeURL(
                baseURL,
                this.manifest.weightsPath
            );

        if (
            !basisURL ||
            !weightsURL
        ) {
            throw new Error(
                'lowrank_texture requires basisPath and weightsPath'
            );
        }

        const basis =
            await fetchFloat32Array(
                basisURL,
                this.splatCount *
                this.rank *
                4
            );

        const weights =
            await fetchFloat32Array(
                weightsURL,
                this.frameCount *
                this.rank *
                4
            );

        const packed =
            await packLowRankBasis(
                basis,
                this.splatCount,
                this.rank
            );

        this.basisSplatsPerRow =
            packed.splatsPerRow;

        this.basisTexture =
            makeRGBAFloatTexture(
                packed.data,
                packed.width,
                packed.height
            );

        this.weightsTexture =
            makeRGBAFloatTexture(
                weights,
                this.rank,
                this.frameCount
            );

        this.bakedTextureA =
            makeZeroTexture();

        this.bakedTextureB =
            makeZeroTexture();

        this.bakedTextureWidth = 1;
        this.bakedTextureHeight = 1;
    }

    async loadBakedKeyframes() {
        const baseURL =
            this.manifestURL ||
            window.location.href;

        const motionURL =
            resolveRelativeURL(
                baseURL,
                this.manifest.motionPath
            );

        if (!motionURL) {
            throw new Error(
                'baked_keyframes_int16 requires motionPath'
            );
        }

        this.bakedMotion =
            await fetchInt16Array(
                motionURL,
                this.frameCount *
                this.splatCount *
                3
            );

        if (
            !Array.isArray(
                this.manifest.quantScale
            ) ||
            this.manifest.quantScale.length !== 3
        ) {
            throw new Error(
                'baked_keyframes_int16 requires quantScale with three values'
            );
        }

        this.bakedQuantScale =
            new Float32Array(
                this.manifest.quantScale
            );

        this.bakedTextureWidth =
            Math.min(
                BAKED_TEXTURE_WIDTH,
                this.splatCount
            );

        this.bakedTextureHeight =
            Math.ceil(
                this.splatCount /
                this.bakedTextureWidth
            );

        const texelCount =
            this.bakedTextureWidth *
            this.bakedTextureHeight;

        this.bakedTextureDataA =
            new Float32Array(
                texelCount * 4
            );

        this.bakedTextureDataB =
            new Float32Array(
                texelCount * 4
            );

        this.bakedTextureA =
            makeRGBAFloatTexture(
                this.bakedTextureDataA,
                this.bakedTextureWidth,
                this.bakedTextureHeight
            );

        this.bakedTextureB =
            makeRGBAFloatTexture(
                this.bakedTextureDataB,
                this.bakedTextureWidth,
                this.bakedTextureHeight
            );

        this.basisTexture =
            makeZeroTexture();

        this.weightsTexture =
            makeZeroTexture();
    }

    fillBakedTexture(
        frameIndex,
        target
    ) {
        const sourceOffset =
            frameIndex *
            this.splatCount *
            3;

        const scaleX =
            this.bakedQuantScale[0];

        const scaleY =
            this.bakedQuantScale[1];

        const scaleZ =
            this.bakedQuantScale[2];

        target.fill(0);

        for (
            let i = 0;
            i < this.splatCount;
            i += 1
        ) {
            const source =
                sourceOffset +
                i * 3;

            const destination =
                i * 4;

            target[destination] =
                this.bakedMotion[source] *
                scaleX;

            target[destination + 1] =
                this.bakedMotion[
                    source + 1
                ] *
                scaleY;

            target[destination + 2] =
                this.bakedMotion[
                    source + 2
                ] *
                scaleZ;
        }
    }

    updateBakedTextures(
        timeInFrames
    ) {
        const wrappedFrame =
            this.loop
                ? (
                    (
                        timeInFrames %
                        this.frameCount
                    ) +
                    this.frameCount
                ) %
                this.frameCount
                : THREE.MathUtils.clamp(
                    timeInFrames,
                    0,
                    Math.max(
                        0,
                        this.frameCount - 1
                    )
                );

        const frameA =
            Math.floor(
                wrappedFrame
            );

        const frameB =
            this.loop
                ? (
                    frameA + 1
                ) %
                this.frameCount
                : Math.min(
                    frameA + 1,
                    this.frameCount - 1
                );

        const frameMix =
            wrappedFrame -
            frameA;

        if (
            frameA !==
            this.currentBakedFrameA
        ) {
            this.fillBakedTexture(
                frameA,
                this.bakedTextureDataA
            );

            this.bakedTextureA
                .needsUpdate = true;

            this.currentBakedFrameA =
                frameA;
        }

        if (
            frameB !==
            this.currentBakedFrameB
        ) {
            this.fillBakedTexture(
                frameB,
                this.bakedTextureDataB
            );

            this.bakedTextureB
                .needsUpdate = true;

            this.currentBakedFrameB =
                frameB;
        }

        this.currentBakedMix =
            frameMix;

        const uniform =
            this.attachedMaterial
                ?.uniforms
                ?.uNative4DGSBakedMix;

        if (uniform) {
            uniform.value =
                frameMix;
        }
    }

    installUniforms(material) {
        const isBaked =
            this.backend ===
            'baked_keyframes_int16';

        material.uniforms
            .uNative4DGSEnabled = {
                value:
                    this.backend ===
                    'zero'
                        ? 0
                        : 1,
            };

        material.uniforms
            .uNative4DGSBackend = {
                value:
                    isBaked
                        ? 2
                        : 1,
            };

        material.uniforms
            .uNative4DGSTime = {
                value:
                    this.timeInFrames,
            };

        material.uniforms
            .uNative4DGSFrameCount = {
                value:
                    this.frameCount,
            };

        material.uniforms
            .uNative4DGSRank = {
                value:
                    this.rank,
            };

        material.uniforms
            .uNative4DGSDisplacementScale = {
                value:
                    this.displacementScale,
            };

        material.uniforms
            .uNative4DGSBasisSplatsPerRow = {
                value:
                    this.basisSplatsPerRow,
            };

        material.uniforms
            .uNative4DGSBasisTexture = {
                value:
                    this.basisTexture,
            };

        material.uniforms
            .uNative4DGSWeightsTexture = {
                value:
                    this.weightsTexture,
            };

        material.uniforms
            .uNative4DGSBakedTextureA = {
                value:
                    this.bakedTextureA,
            };

        material.uniforms
            .uNative4DGSBakedTextureB = {
                value:
                    this.bakedTextureB,
            };

        material.uniforms
            .uNative4DGSBakedTextureSize = {
                value:
                    new THREE.Vector2(
                        this.bakedTextureWidth,
                        this.bakedTextureHeight
                    ),
            };

        material.uniforms
            .uNative4DGSBakedMix = {
                value:
                    this.currentBakedMix,
            };

        material.uniformsNeedUpdate =
            true;
    }

    update(deltaSeconds) {
        if (
            !this.playing ||
            !this.attachedMaterial
        ) {
            return;
        }

        this.timeInFrames +=
            deltaSeconds *
            this.fps *
            this.speed;

        if (this.loop) {
            this.timeInFrames %=
                this.frameCount;
        } else {
            this.timeInFrames =
                Math.min(
                    this.timeInFrames,
                    Math.max(
                        0,
                        this.frameCount - 1
                    )
                );
        }

        const timeUniform =
            this.attachedMaterial
                .uniforms
                ?.uNative4DGSTime;

        if (timeUniform) {
            timeUniform.value =
                this.timeInFrames;
        }

        if (
            this.backend ===
            'baked_keyframes_int16'
        ) {
            this.updateBakedTextures(
                this.timeInFrames
            );
        }
    }

    setPlaying(value) {
        this.playing =
            Boolean(value);
    }

    setDisplacementScale(value) {
        this.displacementScale =
            Number(value);

        const uniform =
            this.attachedMaterial
                ?.uniforms
                ?.uNative4DGSDisplacementScale;

        if (uniform) {
            uniform.value =
                this.displacementScale;
        }
    }

    dispose() {
        this.basisTexture?.dispose();
        this.weightsTexture?.dispose();
        this.bakedTextureA?.dispose();
        this.bakedTextureB?.dispose();

        this.bakedMotion = null;
        this.bakedTextureDataA = null;
        this.bakedTextureDataB = null;
        this.attachedMaterial = null;
    }
}