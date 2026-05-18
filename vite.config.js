import { defineConfig } from 'vite';

// 커스텀 플러그인: 서버를 통과하는 '모든' 요청에 보안 헤더를 강제로 박아 넣습니다.
const crossOriginIsolationPlugin = () => ({
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      // SharedArrayBuffer를 위한 추가 안전장치 헤더
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); 
      next();
    });
  }
});

export default defineConfig({
  plugins: [crossOriginIsolationPlugin()]
});