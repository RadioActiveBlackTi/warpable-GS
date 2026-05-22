import * as THREE from 'three';
import { extractRotation3D, outerProduct3 } from './mathUtils.js';
import { ARAP } from './constants.js';

/**
 * 3D 볼류메트릭 케이지 ARAP 솔버
 * 
 * 기능:
 * - 정육면체 격자 케이지 생성 (numBones개 정점)
 * - Local step: 각 정점마다 회전 행렬 계산 (극분해)
 * - Global step: 제약조건을 만족하면서 정점 위치 업데이트
 * - Lerp damping으로 과도한 변형 방지
 */
export class VolumetricARAP {
    constructor(numBones = ARAP.NUM_BONES) {
        this.restPositions = [];
        this.currentPositions = [];
        this.rotations = [];
        this.edges = [];
        this.handles = new Map();  // index → targetPosition
        this.numBones = numBones;

        this.initCage();
    }

    /**
     * 볼류메트릭 케이지 초기화
     * 기본: 6층 × 4코너 = 24개 뼈
     */
    initCage() {
        const radius = ARAP.RADIUS;
        const numHeights = ARAP.NUM_HEIGHTS;
        const minY = ARAP.MIN_Y;
        const maxY = ARAP.MAX_Y;
        
        const dy = (maxY - minY) / (numHeights - 1);
        const heights = [];
        for (let i = 0; i < numHeights; i++) {
            heights.push(minY + i * dy);
        }
        
        const corners = [
            [-radius, -radius], [radius, -radius],
            [radius, radius], [-radius, radius]
        ];

        // 각 높이의 각 코너에 정점 생성
        for (let h of heights) {
            for (let c of corners) {
                const pos = new THREE.Vector3(c[0], h, c[1]);
                this.restPositions.push(pos.clone());
                this.currentPositions.push(pos.clone());
                this.rotations.push(new THREE.Matrix3());
                this.edges.push([]);
            }
        }

        // 엣지 구성: 거리 및 Y축 높이 조건 기반
        const distThresh = ARAP.EDGE_DIST_THRESHOLD;
        const yThresh = ARAP.EDGE_Y_THRESHOLD;
        
        for (let i = 0; i < this.numBones; i++) {
            for (let j = i + 1; j < this.numBones; j++) {
                const dist = this.restPositions[i].distanceTo(this.restPositions[j]);
                const yDist = Math.abs(this.restPositions[i].y - this.restPositions[j].y);
                
                // 같은 층이거나 인접한 1층 차이일 때만 엣지 연결
                if (dist < distThresh && yDist <= yThresh) {
                    this.edges[i].push(j);
                    this.edges[j].push(i);
                }
            }
        }
    }

    /**
     * 특정 정점에 움직임 제약(handle) 설정
     * @param {number} index - 정점 인덱스
     * @param {THREE.Vector3} targetPosition - 목표 위치
     */
    setHandle(index, targetPosition) {
        this.handles.set(index, targetPosition.clone());
    }

    /**
     * 모든 핸들 초기화
     */
    clearHandles() {
        this.handles.clear();
    }

    /**
     * ARAP 솔버 메인 루프
     * @param {number} iterations - 반복 횟수 (보통 4-5회)
     */
    solve(iterations = ARAP.ITERATIONS) {
        for (let iter = 0; iter < iterations; iter++) {
            this._localStep();
            this._globalStep();
        }
    }

    /**
     * Local Step: 각 정점마다 최적의 회전 행렬 R_i 계산
     * S_i = Σ (dp_ij ⊗ dr_ij) → R_i = polar_decomposition(S_i)
     */
    _localStep() {
        for (let i = 0; i < this.numBones; i++) {
            const p_i = this.currentPositions[i];
            const r_i = this.restPositions[i];
            let S = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);

            // 인접 정점들의 엣지에서 공분산 행렬 구성
            for (let j of this.edges[i]) {
                const dp = this.currentPositions[j].clone().sub(p_i);
                const dr = this.restPositions[j].clone().sub(r_i);
                const outer = outerProduct3(dp, dr);
                
                for (let k = 0; k < 9; k++) {
                    S.elements[k] += outer.elements[k];
                }
            }

            // 극분해로 순수 회전 추출
            this.rotations[i] = extractRotation3D(S);
        }
    }

    /**
     * Global Step: 제약조건을 만족하면서 정점 위치 업데이트
     * 각 정점은:
     * 1. handle이 설정되면 그 위치로 고정
     * 2. 아니면 인접 정점들의 가중평균으로 이동 (+ lerp damping)
     */
    _globalStep() {
        const dampingFactor = ARAP.LERP_DAMPING;
        
        for (let i = 0; i < this.numBones; i++) {
            // Handle 제약 적용
            if (this.handles.has(i)) {
                this.currentPositions[i].copy(this.handles.get(i));
                continue;
            }

            let posSum = new THREE.Vector3();
            const r_i = this.restPositions[i];
            const R_i = this.rotations[i];

            // 인접 정점들 기반 위치 제안 계산
            for (let j of this.edges[i]) {
                const p_j = this.currentPositions[j];
                const r_j = this.restPositions[j];
                const R_j = this.rotations[j];

                const dr = r_i.clone().sub(r_j);
                // 양쪽 회전을 평균: (R_i + R_j) / 2
                const rotated_dr = dr.clone()
                    .applyMatrix3(R_i)
                    .add(dr.clone().applyMatrix3(R_j))
                    .multiplyScalar(0.5);
                
                posSum.add(p_j.clone().add(rotated_dr));
            }

            // 제안된 새 위치로 부드럽게 이동 (damping)
            if (this.edges[i].length > 0) {
                const targetPos = posSum.divideScalar(this.edges[i].length);
                this.currentPositions[i].lerp(targetPos, dampingFactor);
            }
        }
    }

    /**
     * 현재 상태에서 변환 행렬 추출 (뼈 텍스처 업데이트용)
     * 각 뼈 i에 대해: T_i = T(p_i) * R_i * T(-r_i)
     * 
     * @returns {THREE.Matrix4[]} 각 뼈의 변환 행렬 배열
     */
    getTransformMatrices() {
        const matrices = [];
        
        for (let i = 0; i < this.numBones; i++) {
            const p = this.currentPositions[i];
            const R = this.rotations[i];
            const rest = this.restPositions[i];
            
            // T(p) * R * T(-rest)를 순차 적용
            const mCurrent = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
            const mRot = new THREE.Matrix4().setFromMatrix3(R);
            const mRestInv = new THREE.Matrix4().makeTranslation(-rest.x, -rest.y, -rest.z);
            
            mCurrent.multiply(mRot);
            mCurrent.multiply(mRestInv);
            
            matrices.push(mCurrent);
        }
        
        return matrices;
    }

    /**
     * 변환 행렬을 3D 뼈 텍스처에 저장 (column-major)
     * 텍스처 형식: 12×8 RGBA Float32
     * 각 뼈마다 16개 float (4×4 행렬)
     * 
     * @param {Float32Array} boneData - 텍스처 데이터 배열
     */
    updateBoneTextureData(boneData) {
        const matrices = this.getTransformMatrices();
        
        for (let i = 0; i < this.numBones; i++) {
            const arr = matrices[i].toArray();  // column-major
            const offset = i * 16;
            for (let k = 0; k < 16; k++) {
                boneData[offset + k] = arr[k];
            }
        }
    }

    /**
     * 디버그: 모든 정점의 위치 출력
     */
    printPositions() {
        console.log('Current positions:');
        for (let i = 0; i < this.numBones; i++) {
            const p = this.currentPositions[i];
            console.log(`  Bone ${i}: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
        }
    }

    /**
     * 디버그: 케이지를 시각화할 선분 배열 반환
     * @returns {THREE.Vector3[]} 선분 끝점들의 배열
     */
    getEdgeLineSegments() {
        const lines = [];
        for (let i = 0; i < this.numBones; i++) {
            for (let j of this.edges[i]) {
                if (i < j) {  // 각 엣지는 한 번만 추가
                    lines.push(this.currentPositions[i]);
                    lines.push(this.currentPositions[j]);
                }
            }
        }
        return lines;
    }
}
