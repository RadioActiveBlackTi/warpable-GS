import numpy as np
from plyfile import PlyData
import matplotlib.colors as mcolors
import argparse

def apply_global_hue_shift(input_ply, output_ply, shift_amount=0.33):
    """
    shift_amount: 0.0 ~ 1.0 사이의 값. 
                  예) 0.33은 스펙트럼의 1/3을 이동 (빨강->초록, 초록->파랑, 파랑->빨강)
                  예) 0.5는 보색으로 반전 (파랑->노랑)
    """

    plydata = PlyData.read(input_ply)
    vertex = plydata.elements[0]
    
    # 1. DC 성분 추출
    f_dc_0 = np.asarray(vertex.data['f_dc_0'])
    f_dc_1 = np.asarray(vertex.data['f_dc_1'])
    f_dc_2 = np.asarray(vertex.data['f_dc_2'])
    
    SH_C0 = 0.28209479177387814
    
    # 2. DC 값을 0.0 ~ 1.0 범위의 RGB로 변환 (N, 3 형태의 배열로 묶기)
    R = f_dc_0 * SH_C0 + 0.5
    G = f_dc_1 * SH_C0 + 0.5
    B = f_dc_2 * SH_C0 + 0.5
    
    # RGB 값을 0~1 사이로 클리핑 (학습 중 0이나 1을 미세하게 벗어난 아웃라이어 방지)
    rgb_array = np.clip(np.stack((R, G, B), axis=-1), 0.0, 1.0)
    
    # 3. RGB -> HSV 변환
    hsv_array = mcolors.rgb_to_hsv(rgb_array)
    
    # 4. Hue(색조) 채널 시프팅 (0.0 ~ 1.0 범위를 순환하도록 modulo 1.0 처리)
    hsv_array[:, 0] = (hsv_array[:, 0] + shift_amount) % 1.0
    
    # 5. HSV -> RGB 역변환
    new_rgb_array = mcolors.hsv_to_rgb(hsv_array)
    
    new_R = new_rgb_array[:, 0]
    new_G = new_rgb_array[:, 1]
    new_B = new_rgb_array[:, 2]
    
    # 6. 변경된 RGB를 다시 f_dc 값으로 역변환하여 업데이트
    vertex.data['f_dc_0'][:] = (new_R - 0.5) / SH_C0
    vertex.data['f_dc_1'][:] = (new_G - 0.5) / SH_C0
    vertex.data['f_dc_2'][:] = (new_B - 0.5) / SH_C0
    
    # 7. f_rest (고차 SH 계수) 초기화
    # 베이스 색상이 완전히 바뀌었으므로, 기존의 반사광 데이터를 0으로 밀어버려야 아티팩트가 생기지 않습니다.
    for i in range(45):
        prop_name = f'f_rest_{i}'
        if prop_name in vertex.data.dtype.names:
            vertex.data[prop_name][:] = 0.0
            
    # 8. 저장
    print("Saving the modified PLY file...")
    PlyData([vertex]).write(output_ply)
    print("Completed!")

# 실행 예시: 색조를 스펙트럼의 1/3만큼 이동
# apply_global_hue_shift('input_scene.ply', 'output_scene.ply', shift_amount=0.33)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PLY Hue Shift Script")
    parser.add_argument("--input_ply", type=str,  help="input PLY path")
    parser.add_argument("--output_ply", type=str, help="output PLY path")
    parser.add_argument("--shift_amount", type=float, default=0.33, help="Hue shift amount (.0 ~ 1.0)")
    
    args = parser.parse_args()
    
    apply_global_hue_shift(args.input_ply, args.output_ply, args.shift_amount)