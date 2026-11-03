import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@/components/arc/foundation.css';
import './index.css';
import App from './App';

// data-theme and data-accent are set on <html> before first paint by index.html and kept in sync by the store.
const root = document.documentElement;
if (!root.hasAttribute('data-accent')) root.setAttribute('data-accent', 'amber');
if (!root.hasAttribute('data-theme')) root.setAttribute('data-theme', 'light');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The daemon serves the build at /ui (vite base '/ui/'); BASE_URL is '/ui/'. */}
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
