import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from '../store/appStore';
import '../index.css';

const container = document.getElementById('root');
// No `!` (HARD CONSTRAINT 4). A missing mount point means index.html and this file
// disagree, which should say so rather than throw a null-property error.
if (container === null) throw new Error('Mount point #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App store={useStore} />
  </StrictMode>,
);
