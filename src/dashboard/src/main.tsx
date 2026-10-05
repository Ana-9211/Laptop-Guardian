import './api'; // reads the session token from the URL fragment before anything else looks at the address
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
