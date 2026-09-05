import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <main aria-label="HyperPlayer" />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
