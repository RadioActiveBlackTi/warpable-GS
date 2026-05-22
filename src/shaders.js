/**
 * 모든 쉐이더를 하나의 모듈로 관리
 * 1. Lid Ripple Shader (호로포탈 표면)
 * 2. Test Mesh LBS Shader (테스트 실린더 메쉬)
 * 3. Gaussian Splat LBS 주입 코드
 */

/**
 * 호로포탈 Lid 메쉬의 쉐이더 주입 설정
 * (onBeforeCompile에서 사용)
 */
export function setupLidShaderInjection() {
    return {
        uniforms: {
            uTime: { value: 0.0 },
            uBendAmount: { value: 2.0 },
            uRadius: { value: 50.0 },
            uDistanceFade: { value: 1.0 },
            uResolution: { value: { x: window.innerWidth, y: window.innerHeight } },
        },
        
        injectVertex: `
            uniform float uTime;
            uniform float uBendAmount;
            uniform float uRadius;

            // Local slope passed to the fragment shader.
            varying vec2 vLocalSlope;

            float rippleFunc(vec2 p, float t, float b, float radius) {
                float amplitude = clamp(abs(b), 0.0, 20.0);
                float r = length(p) / radius;
                if (r > 1.0) return 0.0;
                float rippleSpeed = 4.0;
                float rippleFreq = 22.0;
                float envelope = exp(-r * 2.0);
                return sin(r * rippleFreq - t * rippleSpeed) * envelope * amplitude;
            }
        `,
        
        replaceNormalVertex: `
            float eps = 0.01;
            vec3 p0 = position;
            p0.z += rippleFunc(p0.xy, uTime, uBendAmount, uRadius);

            vec3 px = position + vec3(eps, 0.0, 0.0);
            px.z += rippleFunc(px.xy, uTime, uBendAmount, uRadius);

            vec3 py = position + vec3(0.0, eps, 0.0);
            py.z += rippleFunc(py.xy, uTime, uBendAmount, uRadius);

            vec3 T = normalize(px - p0);
            vec3 B = normalize(py - p0);
            vec3 localN = normalize(cross(T, B));

            vec3 objectNormal = localN;
            vLocalSlope = localN.xy;
        `,
        
        replaceBeginVertex: `
            vec3 transformed = vec3(position);
            transformed.z += rippleFunc(position.xy, uTime, uBendAmount, uRadius);
        `,
        
        injectFragment: `
            uniform sampler2D map;
            uniform float uDistanceFade;
            uniform vec2 uResolution;
            varying vec2 vLocalSlope;
        `,
        
        replaceMapFragment: `
            vec2 screenUv = gl_FragCoord.xy / uResolution;
            float warpStrength = 0.06;
            vec2 uvOffset = vLocalSlope * warpStrength * uDistanceFade;
            vec2 warpedUv = clamp(screenUv + uvOffset, 0.0, 1.0);
            vec4 sampledDiffuseColor = texture2D(map, warpedUv);

            // Keep empty areas translucent so the water layer still reads as a surface.
            diffuseColor *= sampledDiffuseColor;
            diffuseColor.a = mix(0.28, 0.78, sampledDiffuseColor.a);
        `,
        
        replaceOutputFragment: `
            gl_FragColor = vec4(outgoingLight, diffuseColor.a);
        `
    };
}

/**
 * 테스트 메쉬 (실린더) LBS 쉐이더
 * GPU 텍스처 기반 4-본 스킨 애니메이션
 */
export function createTestMeshLBSShader(boneTextureWidth, boneTextureHeight) {
    return {
        uniforms: {
            boneTexture: { value: null },      // 호출자가 설정
            boneTextureWidth: { value: boneTextureWidth },
            boneTextureHeight: { value: boneTextureHeight }
        },
        
        vertexShader: `
            uniform sampler2D boneTexture;
            uniform float boneTextureWidth;
            uniform float boneTextureHeight;
            attribute vec4 skinIndex;
            attribute vec4 skinWeight;

            mat4 getBoneMatrix(float boneIdx) {
                // 각 행렬은 16개 float = 4개 vec4 (column-major)
                float texWidth = boneTextureWidth;
                float texHeight = boneTextureHeight;
                
                // 행렬 i의 시작 픽셀 위치
                float pixelStart = boneIdx * 4.0;
                float x = mod(pixelStart, texWidth);
                float y = floor(pixelStart / texWidth);
                
                float dx = 1.0 / texWidth;
                float dy = 1.0 / texHeight;
                
                // 4개 vec4 (4개 열) 읽기
                vec4 col0 = texture2D(boneTexture, vec2((x + 0.5) * dx, (y + 0.5) * dy));
                vec4 col1 = texture2D(boneTexture, vec2((x + 1.5) * dx, (y + 0.5) * dy));
                vec4 col2 = texture2D(boneTexture, vec2((x + 2.5) * dx, (y + 0.5) * dy));
                vec4 col3 = texture2D(boneTexture, vec2((x + 3.5) * dx, (y + 0.5) * dy));
                
                // GLSL mat4는 column-major
                return mat4(col0, col1, col2, col3);
            }

            void main() {
                // 💡 4개의 뼈대 행렬(x, y, z, w)을 모두 부드럽게 섞음 (4-Bone LBS)
                mat4 skinMat = getBoneMatrix(skinIndex.x) * skinWeight.x +
                               getBoneMatrix(skinIndex.y) * skinWeight.y +
                               getBoneMatrix(skinIndex.z) * skinWeight.z +
                               getBoneMatrix(skinIndex.w) * skinWeight.w;
                               
                vec4 skinnedPos = skinMat * vec4(position, 1.0);
                gl_Position = projectionMatrix * viewMatrix * skinnedPos;
            }
        `,
        
        fragmentShader: `
            void main() {
                gl_FragColor = vec4(0.0, 0.8, 1.0, 0.4);
            }
        `,
        
        shaderMaterial: {
            wireframe: true,
            transparent: true,
            depthTest: false,
            side: 'DoubleSide'  // THREE.DoubleSide 해당
        }
    };
}

/**
 * 가우시안 스플랫 LBS 주입 코드
 * holoPortal.injectSkinning()에서 사용됨
 * 
 * @returns {Object} 주입할 쉐이더 코드 조각들
 */
export function getGaussianSplatLBSInjection() {
    return {
        // 쉐이더 main() 함수 시작 부분에 추가
        mainFunctionPrefix: `
            uniform sampler2D boneTexture;
            uniform float boneTextureWidth;
            uniform float boneTextureHeight;
            uniform sampler2D skinIndicesTexture;
            uniform sampler2D skinWeightsTexture;

            // 💡 UV 좌표 계산(getDataUV, texture)을 모두 버리고, 정수형 픽셀 인덱스(texelFetch)로 직행
            mat4 getBoneMatrix(float boneIdx) {
                int bIdx = int(boneIdx);
                int texW = int(boneTextureWidth);
                int pixelStart = bIdx * 4;
                
                vec4 col0 = texelFetch(boneTexture, ivec2((pixelStart + 0) % texW, (pixelStart + 0) / texW), 0);
                vec4 col1 = texelFetch(boneTexture, ivec2((pixelStart + 1) % texW, (pixelStart + 1) / texW), 0);
                vec4 col2 = texelFetch(boneTexture, ivec2((pixelStart + 2) % texW, (pixelStart + 2) / texW), 0);
                vec4 col3 = texelFetch(boneTexture, ivec2((pixelStart + 3) % texW, (pixelStart + 3) / texW), 0);
                
                return mat4(col0, col1, col2, col3);
            }
            
            void main() {
        `,
        
        // splatCenter 계산 후에 추가
        splatCenterModification: `
            // 💡 라이브러리 내장 함수(getDataUV) 완전 폐기!
            // 스플랫 인덱스를 정수로 변환하여 텍스처에서 직접 가중치/인덱스 픽셀을 뽑아옵니다.
            int texW = int(centersColorsTextureSize.x);
            int sIdx = int(splatIndex);
            ivec2 texelCoord = ivec2(sIdx % texW, sIdx / texW);
            
            vec4 skinIdx = texelFetch(skinIndicesTexture, texelCoord, 0);
            vec4 skinW = texelFetch(skinWeightsTexture, texelCoord, 0);
            
            // LBS 계산
            mat4 skinMat = getBoneMatrix(skinIdx.x) * skinW.x +
                           getBoneMatrix(skinIdx.y) * skinW.y +
                           getBoneMatrix(skinIdx.z) * skinW.z +
                           getBoneMatrix(skinIdx.w) * skinW.w;
                           
            splatCenter = (skinMat * vec4(splatCenter, 1.0)).xyz;
        `
    };
}

/**
 * 쉐이더 문자열 교체 헬퍼
 * @param {string} shader - 원본 쉐이더 코드
 * @param {string} searchPattern - regex 패턴 또는 문자열
 * @param {string} replacement - 교체 문자열
 * @returns {string}
 */
export function replaceShaderCode(shader, searchPattern, replacement) {
    if (typeof searchPattern === 'string') {
        return shader.replace(searchPattern, replacement);
    }
    return shader.replace(new RegExp(searchPattern, 'g'), replacement);
}

/**
 * 쉐이더에 전처리 코드 추가
 * @param {string} shader - 원본 쉐이더
 * @param {string} includeDirective - 교체할 #include 지시문 (예: '#include <beginnormal_vertex>')
 * @param {string} newCode - 새 코드
 * @returns {string}
 */
export function injectBeforeInclude(shader, includeDirective, newCode) {
    return shader.replace(includeDirective, newCode);
}
