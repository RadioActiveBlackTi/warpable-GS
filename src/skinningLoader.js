/**
 * skin_weight.py에서 생성한 바이너리/JSON 데이터를 로드하는 유틸리티
 * 
 * 사용 예:
 * const { proxyNodes, skinIndices, skinWeights } = 
 *   await loadSkinningData('./output_nodes24_sigma5.0');
 */
import * as THREE from 'three';

export async function loadSkinningData(dataPath, K = 4) {
    /**
     * proxy_nodes.json과 skinning_data.bin을 로드
     * @param {string} dataPath - 데이터 디렉토리 경로 (trailing slash 없음)
     * @param {number} K - 상위 K개 가중치 (기본 4)
     * @returns {Object} { proxyNodes, skinIndices, skinWeights }
     */

    try {
        // 1. proxy_nodes.json 로드 (프록시 노드 좌표)
        console.log(`📂 Skinning data 로드 중: ${dataPath}`);
        
        const nodesResponse = await fetch(`${dataPath}/proxy_nodes.json`);
        if (!nodesResponse.ok) {
            throw new Error(`proxy_nodes.json 로드 실패: ${nodesResponse.status}`);
        }
        const nodesData = await nodesResponse.json();
        console.log(`   ✓ ${nodesData.length}개 프록시 노드 로드됨`);

        // THREE.Vector3 배열로 변환
        const proxyNodes = nodesData.map(p => new THREE.Vector3(p.x, p.y, p.z));

        // 2. skinning_data.bin 로드 (스킨 가중치 데이터)
        const binResponse = await fetch(`${dataPath}/skinning_data.bin`);
        if (!binResponse.ok) {
            throw new Error(`skinning_data.bin 로드 실패: ${binResponse.status}`);
        }
        const binBuffer = await binResponse.arrayBuffer();
        const skinDataFloat32 = new Float32Array(binBuffer);
        console.log(`   ✓ ${skinDataFloat32.length / (2 * K) | 0}개 포인트 스킨 데이터 로드됨`);

        // 3. Float32Array를 skinIndices / skinWeights로 분리
        const numPoints = skinDataFloat32.length / (2 * K);
        const skinIndices = new Uint32Array(numPoints * K);
        const skinWeights = new Float32Array(numPoints * K);

        for (let i = 0; i < numPoints; i++) {
            for (let j = 0; j < K; j++) {
                // [idx0, idx1, ..., idxK-1, w0, w1, ..., wK-1] 형식
                skinIndices[i * K + j] = skinDataFloat32[i * (2 * K) + j];
                skinWeights[i * K + j] = skinDataFloat32[i * (2 * K) + K + j];
            }
        }

        console.log(`✅ Skinning data 로드 완료!`);
        return { proxyNodes, skinIndices, skinWeights };

    } catch (error) {
        console.error('❌ Skinning data 로드 실패:', error);
        throw error;
    }
}


/**
 * 로드한 데이터를 메시에 적용 (LBS 쉐이더용)
 * @param {THREE.BufferGeometry} geometry - 메시 지오메트리
 * @param {Uint32Array} skinIndices - 스킨 인덱스 (N×K)
 * @param {Float32Array} skinWeights - 스킨 가중치 (N×K)
 * @param {number} K - 상위 K개 가중치
 */
export function applySkinningToGeometry(geometry, skinIndices, skinWeights, K = 4) {
    // BufferAttribute로 변환하여 메시에 할당
    const posAttr = geometry.attributes.position;
    if (!posAttr) {
        throw new Error('Geometry에 position attribute가 없습니다');
    }

    const vertexCount = posAttr.count;
    if (skinIndices.length / K !== vertexCount) {
        throw new Error(`Vertex 개수 불일치: geometry=${vertexCount}, skinData=${skinIndices.length / K}`);
    }

    // skinIndices와 skinWeights를 4개씩 묶어서 저장 (GPU 쉐이더 호환)
    const paddedIndices = new Float32Array(vertexCount * 4);
    const paddedWeights = new Float32Array(vertexCount * 4);

    for (let i = 0; i < vertexCount; i++) {
        for (let j = 0; j < K; j++) {
            paddedIndices[i * 4 + j] = skinIndices[i * K + j];
            paddedWeights[i * 4 + j] = skinWeights[i * K + j];
        }
        // K < 4인 경우 나머지는 0으로 패딩
        for (let j = K; j < 4; j++) {
            paddedIndices[i * 4 + j] = 0;
            paddedWeights[i * 4 + j] = 0;
        }
    }

    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(paddedIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(paddedWeights, 4));

    console.log(`✓ Geometry에 스킨 속성 적용됨 (${vertexCount}개 vertex)`);
}


/**
 * 사용 예제:
 * 
 * // 데이터 로드
 * const { proxyNodes, skinIndices, skinWeights } = 
 *   await loadSkinningData('./nubjuk_face_rg_nodes24_sigma5.0');
 * 
 * // 메시에 적용
 * applySkinningToGeometry(testMesh.geometry, skinIndices, skinWeights, 4);
 * 
 * // main.js의 ARAP 솔버와 연동
 * holoPortal.setARAPData(proxyNodes, boneTexture, ...);
 */
