import os
import urllib.request
import ssl
import time
from PIL import Image, ImageChops
from io import BytesIO
import socket

ssl._create_default_https_context = ssl._create_unverified_context
socket.setdefaulttimeout(10)

# 일반 달 위상 (이것들을 그림자 마스크로 쓸 겁니다)
phase_unicodes = [
    "1f315", "1f316", "1f317", "1f318",
    "1f311", "1f312", "1f313", "1f314"
]

FACE_MOON_CODE = "1f31d" # 🌝 보름달 얼굴 (베이스 텍스처)
OUTPUT_DIR = "dataset/moon/images"
SQUARE_SIZE = 800
MAX_RETRIES = 3

if not os.path.exists(OUTPUT_DIR):
    os.makedirs(OUTPUT_DIR)

def download_emoji(code):
    """깃허브에서 이모지를 다운로드하여 RGBA 이미지로 반환"""
    url = f"https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u{code}.png"
    for attempt in range(MAX_RETRIES):
        try:
            headers = {'User-Agent': 'Mozilla/5.0'}
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req) as response:
                return Image.open(BytesIO(response.read())).convert("RGBA")
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2)
    raise Exception(f"다운로드 실패: {code}")

print("🚀 인면암(人面岩) 베이스 얼굴 다운로드 중...")
try:
    face_rgba = download_emoji(FACE_MOON_CODE)
    
    # 베이스 얼굴을 검은 배경에 합성
    face_bg = Image.new("RGB", (SQUARE_SIZE, SQUARE_SIZE), (0, 0, 0))
    offset = ((SQUARE_SIZE - face_rgba.width) // 2, (SQUARE_SIZE - face_rgba.height) // 2)
    face_bg.paste(face_rgba, offset, face_rgba)
    
except Exception as e:
    print(f"❌ 베이스 얼굴 다운로드 에러: {e}")
    exit()

print("🌔 그림자 마스크 다운로드 및 합성(Multiply) 시작...\n")

for i, code in enumerate(phase_unicodes):
    filename = f"moon_{i}.png"
    print(f"[{i+1}/8] {filename} 렌더링 중...", end="", flush=True)
    
    try:
        # 1. 일반 달 위상 이미지 다운로드
        phase_rgba = download_emoji(code)
        
        # 2. 일반 달도 검은 배경에 올리기
        phase_bg = Image.new("RGB", (SQUARE_SIZE, SQUARE_SIZE), (0, 0, 0))
        phase_bg.paste(phase_rgba, offset, phase_rgba)
        
        # 3. 그림자 마스크로 쓰기 위해 흑백(Grayscale) 변환 후 다시 RGB 형식으로 맞춤
        shadow_mask = phase_bg.convert("L").convert("RGB")
        
        # 4. 🔥 핵심: 얼굴 텍스처에 그림자 마스크 곱하기 (Multiply Blending)
        # 이 과정을 거치면 얼굴은 유지되면서 완벽한 달의 위상 그림자가 드리워집니다.
        blended_image = ImageChops.multiply(face_bg, shadow_mask)
        
        # 5. 저장
        blended_image.save(os.path.join(OUTPUT_DIR, filename), "PNG")
        print(" ✅ 성공!")
        
        time.sleep(1)
        
    except Exception as e:
        print(f" ❌ 에러: {e}")

print("\n🎉 모든 작업 완료! 완벽한 인면암 달 데이터셋이 생성되었습니다.")