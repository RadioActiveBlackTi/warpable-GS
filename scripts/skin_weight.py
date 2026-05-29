import numpy as np
from scipy.spatial import distance
from plyfile import PlyData
import struct
import json
import argparse
import os
from pathlib import Path

def farthest_point_sampling(points, num_samples):
    """
    Farthest Point Sampling (FPS) 알고리즘을 사용하여 
    포인트 클라우드에서 가장 균일하게 퍼진 프록시 노드들을 추출합니다.
    """
    N = points.shape[0]
    farthest_pts = np.zeros((num_samples, 3))
    
    # 첫 번째 노드는 랜덤하게 선택
    curr_node_idx = np.random.randint(N)
    farthest_pts[0] = points[curr_node_idx]
    
    # 각 점에서 가장 가까운 노드까지의 거리 (초기값: 무한대)
    distances = np.full(N, np.inf)
    
    for i in range(1, num_samples):
        # 방금 추가된 노드와 모든 점 사이의 거리 계산
        dist_to_curr = np.linalg.norm(points - farthest_pts[i-1], axis=1)
        
        # 각 점이 가진 '가장 가까운 노드와의 거리'를 갱신
        distances = np.minimum(distances, dist_to_curr)
        
        # 가장 거리가 먼 점을 다음 프록시 노드로 선택
        next_node_idx = np.argmax(distances)
        farthest_pts[i] = points[next_node_idx]
        
    return farthest_pts

def bake_skinning_data(ply_path, output_dir=None, num_nodes=24, K=4, sigma=5.0):
    """
    스킨 가중치 데이터를 계산하여 저장합니다.
    
    Args:
        ply_path: 입력 PLY 파일 경로
        output_dir: 출력 디렉토리 (None이면 입력 파일 기준 이름으로 생성)
        num_nodes: 프록시 노드(뼈대) 개수
        K: 상위 K개 가중치 선택
        sigma: RBF 가우시안 표준편차
    """
    # 입력 파일 검증
    if not os.path.exists(ply_path):
        print(f"❌ 에러: 파일을 찾을 수 없습니다: {ply_path}")
        return False
    
    # 출력 디렉토리 설정
    if output_dir is None:
        # 입력 파일명 기반으로 출력 이름 생성
        # 예: darkrai.ply → darkrai_nodes_300_sigma_5.0
        input_name = Path(ply_path).stem
        output_name = f"{input_name}_nodes{num_nodes}_sigma{sigma:.1f}"
        output_dir = output_name
    
    # 출력 디렉토리 생성
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"📁 출력 디렉토리: {output_dir}")
    print(f"⚙️  설정: nodes={num_nodes}, K={K}, sigma={sigma:.1f}")
    print("=" * 60)
    
    print("1️⃣  PLY 파일 로드 중...")
    plydata = PlyData.read(ply_path)
    
    # x, y, z 좌표 추출
    x = plydata['vertex']['x']
    y = plydata['vertex']['y']
    z = plydata['vertex']['z']
    points = np.stack((x, y, z), axis=-1)
    N = points.shape[0]
    print(f"   └─ {N:,}개 포인트 로드됨")
    
    print(f"2️⃣  FPS 알고리즘으로 {num_nodes}개의 프록시 노드(뼈대) 추출 중...")
    proxy_nodes = farthest_point_sampling(points, num_nodes)
    print(f"   └─ 추출 완료")
    
    print(f"3️⃣  {N:,}개의 스플랫에 대해 RBF 가중치 계산 중...")
    # 모든 점과 모든 프록시 노드 사이의 유클리드 거리 행렬 계산 (N, num_nodes)
    dists = distance.cdist(points, proxy_nodes, 'euclidean')
    
    # RBF(Gaussian) 가중치 변환: w = exp(-d^2 / (2 * sigma^2))
    weights = np.exp(-(dists ** 2) / (2 * sigma ** 2))
    print(f"   └─ 계산 완료")
    
    print(f"4️⃣  상위 K={K}개의 가중치 선별 및 정규화...")
    # 각 점마다 가중치가 가장 높은 상위 K개의 노드 인덱스 추출 (내림차순 정렬)
    # np.argsort는 오름차순이므로 뒤에서부터 가져와서 뒤집음
    top_k_indices = np.argsort(weights, axis=1)[:, -K:][:, ::-1]
    
    # 추출한 인덱스를 바탕으로 상위 K개 가중치 값만 가져오기
    top_k_weights = np.take_along_axis(weights, top_k_indices, axis=1)
    
    # K개 가중치의 합이 1.0이 되도록 정규화 (Zero division 방지)
    weight_sums = np.sum(top_k_weights, axis=1, keepdims=True) + 1e-6
    top_k_weights = top_k_weights / weight_sums
    print(f"   └─ 정규화 완료")
    
    print("5️⃣  웹 브라우저용 바이너리 및 JSON 파일 생성 중...")
    
    # 뼈대 위치는 JavaScript에서 읽기 편하게 JSON으로 저장
    nodes_list = [{"x": float(p[0]), "y": float(p[1]), "z": float(p[2])} for p in proxy_nodes]
    proxy_nodes_path = os.path.join(output_dir, 'proxy_nodes.json')
    with open(proxy_nodes_path, 'w') as f:
        json.dump(nodes_list, f, indent=4)
    print(f"   └─ {proxy_nodes_path} 생성됨 ({len(nodes_list)}개 노드)")
        
    # 가중치 데이터는 용량이 크므로 Float32 바이너리로 꽉 압축해서 저장
    # 배열 형태: [idx0, idx1, idx2, idx3, w0, w1, w2, w3] * N
    skin_data = np.zeros((N, 2*K), dtype=np.float32)
    skin_data[:, 0:K] = top_k_indices.astype(np.float32)
    skin_data[:, K:2*K] = top_k_weights.astype(np.float32)
    
    skinning_data_path = os.path.join(output_dir, 'skinning_data.bin')
    with open(skinning_data_path, 'wb') as f:
        f.write(skin_data.tobytes())
    
    file_size_mb = os.path.getsize(skinning_data_path) / (1024 * 1024)
    print(f"   └─ {skinning_data_path} 생성됨 ({file_size_mb:.2f} MB)")
    
    # 메타데이터 저장
    metadata = {
        "input_file": os.path.basename(ply_path),
        "num_points": int(N),
        "num_nodes": int(num_nodes),
        "K": int(K),
        "sigma": float(sigma),
        "data_format": f"float32 array of shape ({N}, {2*K})"
    }
    metadata_path = os.path.join(output_dir, 'metadata.json')
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=4)
    print(f"   └─ {metadata_path} 생성됨")
    
    print("=" * 60)
    print("✅ 성공! 모든 파일이 생성되었습니다.")
    print(f"📦 출력 위치: {os.path.abspath(output_dir)}")
    return True


def main():
    """명령행 인터페이스"""
    parser = argparse.ArgumentParser(
        description='PLY 파일에서 스킨 가중치 데이터를 계산하여 저장합니다.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예제:
  # 기본값 사용 (nodes=24, sigma=5.0)
  python skin_weight.py input.ply
  
  # 300개 노드, 시그마 3.0으로 지정
  python skin_weight.py input.ply -n 300 --sigma 3.0
  
  # 출력 디렉토리 명시 지정
  python skin_weight.py input.ply -o ./output
  
  # 모든 옵션 지정
  python skin_weight.py input.ply -o ./output -n 300 -k 4 --sigma 3.0
        """
    )
    
    parser.add_argument(
        'input',
        help='입력 PLY 파일 경로'
    )
    parser.add_argument(
        '-o', '--output',
        default=None,
        help='출력 디렉토리 (기본: input_nodes{N}_sigma{S} 형태로 자동 생성)'
    )
    parser.add_argument(
        '-n', '--nodes',
        type=int,
        default=24,
        help='프록시 노드(뼈대) 개수 (기본: 24)'
    )
    parser.add_argument(
        '-k', '--topk',
        type=int,
        default=4,
        help='상위 K개 가중치 선택 (기본: 4)'
    )
    parser.add_argument(
        '--sigma',
        type=float,
        default=5.0,
        help='RBF 가우시안 표준편차 (기본: 5.0)'
    )
    
    args = parser.parse_args()
    
    # 유효성 검사
    if args.nodes < 1:
        print("❌ 에러: nodes는 1 이상이어야 합니다")
        return False
    if args.topk < 1:
        print("❌ 에러: topk는 1 이상이어야 합니다")
        return False
    if args.sigma <= 0:
        print("❌ 에러: sigma는 0보다 커야 합니다")
        return False
    if args.topk > args.nodes:
        print(f"❌ 에러: topk({args.topk})는 nodes({args.nodes})보다 클 수 없습니다")
        return False
    
    # 실행
    return bake_skinning_data(
        ply_path=args.input,
        output_dir=args.output,
        num_nodes=args.nodes,
        K=args.topk,
        sigma=args.sigma
    )


if __name__ == '__main__':
    success = main()
    exit(0 if success else 1)