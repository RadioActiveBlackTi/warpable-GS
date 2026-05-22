import * as THREE from 'three';

/**
 * 원형 리플 효과 계산 (CPU 기반)
 * @param {number} x - 로컬 X
 * @param {number} y - 로컬 Y
 * @param {number} time - 경과 시간
 * @param {number} bendAmount - 진폭 배수
 * @param {number} radius - 실린더 반경
 * @returns {number} Z 오프셋
 */
export function getRippleZ(x, y, time, bendAmount, radius) {
    const amplitude = Math.min(Math.max(Math.abs(bendAmount), 0.0), 20.0);
    const r = Math.sqrt(x * x + y * y) / radius;

    if (r > 1.0) return 0.0;

    const rippleSpeed = 4.0;
    const rippleFreq = 22.0;
    const envelope = Math.exp(-r * 2.0);
    return Math.sin(r * rippleFreq - time * rippleSpeed) * envelope * amplitude;
}

/**
 * RBF (Radial Basis Function) 가중치 계산
 * @param {THREE.Vector3} vertexPos - 정점 위치
 * @param {THREE.Vector3[]} bonePositions - 뼈 위치 배열
 * @param {number} sigma - 가우시안 표준편차
 * @param {number} topK - 상위 K개 뼈 선택 (보통 4)
 * @returns {{indices: Uint32Array, weights: Float32Array}}
 */
export function computeRBFWeights(vertexPos, bonePositions, sigma = 5.0, topK = 4) {
    const indices = new Uint32Array(topK);
    const weights = new Float32Array(topK);
    
    // 모든 뼈에 대한 가중치 계산
    const allWeights = bonePositions.map((bonePos, idx) => {
        const dist = vertexPos.distanceTo(bonePos);
        const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
        return { index: idx, weight: w };
    });
    
    // 상위 K개 선택
    allWeights.sort((a, b) => b.weight - a.weight);
    
    // 정규화
    let sum = 0;
    for (let i = 0; i < topK; i++) {
        sum += allWeights[i].weight;
    }
    sum = Math.max(sum, 1e-5);
    
    // 결과 저장
    for (let i = 0; i < topK; i++) {
        indices[i] = allWeights[i].index;
        weights[i] = allWeights[i].weight / sum;
    }
    
    return { indices, weights };
}

/**
 * 3×3 행렬 덧셈
 * @param {THREE.Matrix3} A
 * @param {THREE.Matrix3} B
 */
export function addMatrix3(A, B) {
    for (let i = 0; i < 9; i++) {
        A.elements[i] += B.elements[i];
    }
}

/**
 * 3×3 행렬 스칼라 곱셈
 * @param {THREE.Matrix3} A
 * @param {number} scalar
 */
export function scaleMatrix3(A, scalar) {
    for (let i = 0; i < 9; i++) {
        A.elements[i] *= scalar;
    }
}

/**
 * Higham's Iteration을 사용한 극 분해 (Polar Decomposition)
 * S = R * P 에서 순수 회전 R만 추출
 * 특히 행렬식이 작아지는 붕괴 현상을 방지하기 위해 det^(1/3) 정규화 사용
 * 
 * @param {THREE.Matrix3} S - 공분산 행렬
 * @returns {THREE.Matrix3} 순수 회전 행렬
 */
export function extractRotation3D(S) {
    let R = S.clone();
    let det = R.determinant();

    // 행렬이 무너진 경우 (행렬식 거의 0) → 항등 회전 반환
    if (Math.abs(det) < 1e-9) {
        return new THREE.Matrix3().identity();
    }

    // 💡 핵심: 스케일 정규화 (이 줄이 없으면 케이지가 수축함)
    let scale = Math.pow(Math.abs(det), 1.0 / 3.0);
    for (let k = 0; k < 9; k++) {
        R.elements[k] /= scale;
    }

    // Higham's Iteration: R 수렴화
    const R_invT = new THREE.Matrix3();
    for (let iter = 0; iter < 5; iter++) {
        R_invT.copy(R).invert().transpose();
        for (let k = 0; k < 9; k++) {
            R.elements[k] = 0.5 * (R.elements[k] + R_invT.elements[k]);
        }
    }

    return R;
}

/**
 * 외적 행렬 (Outer Product) 생성
 * C = dp ⊗ dr
 * 
 * @param {THREE.Vector3} dp - 현재 위치 차이
 * @param {THREE.Vector3} dr - 정지 위치 차이
 * @returns {THREE.Matrix3} 3×3 외적 행렬
 */
export function outerProduct3(dp, dr) {
    return new THREE.Matrix3().set(
        dp.x * dr.x, dp.x * dr.y, dp.x * dr.z,
        dp.y * dr.x, dp.y * dr.y, dp.y * dr.z,
        dp.z * dr.x, dp.z * dr.y, dp.z * dr.z
    );
}

/**
 * 정점의 상위-K 가중치를 계산하여 BufferAttribute로 변환
 * 
 * @param {THREE.BufferGeometry} geometry - 메쉬 지오메트리
 * @param {THREE.Vector3[]} bonePositions - 뼈 위치 배열
 * @param {number} sigma - RBF 시그마
 * @param {number} topK - 상위 K개 뼈 (기본 4)
 * @returns {{skinIndices: THREE.BufferAttribute, skinWeights: THREE.BufferAttribute}}
 */
export function computeSkinningAttributes(geometry, bonePositions, sigma = 5.0, topK = 4) {
    const posAttr = geometry.attributes.position;
    const vertexCount = posAttr.count;
    
    const skinIndices = new Float32Array(vertexCount * 4);
    const skinWeights = new Float32Array(vertexCount * 4);
    
    for (let i = 0; i < vertexCount; i++) {
        const vPos = new THREE.Vector3(
            posAttr.getX(i),
            posAttr.getY(i),
            posAttr.getZ(i)
        );
        
        const { indices, weights } = computeRBFWeights(vPos, bonePositions, sigma, topK);
        
        for (let j = 0; j < 4; j++) {
            skinIndices[i * 4 + j] = indices[j] ?? 0;
            skinWeights[i * 4 + j] = weights[j] ?? 0;
        }
    }
    
    return {
        skinIndices: new THREE.BufferAttribute(skinIndices, 4),
        skinWeights: new THREE.BufferAttribute(skinWeights, 4),
    };
}
