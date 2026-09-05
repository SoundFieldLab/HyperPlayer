import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initServices } from './wiring';

function App() {
  return <main aria-label="HyperPlayer" />;
}

// 服务装配：使 vendored 网易云 API 进入打包图并经受 vite CJS 转译验证
void initServices().catch((error) => {
  console.error('services init failed', error);
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
