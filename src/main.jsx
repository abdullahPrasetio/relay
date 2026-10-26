import React from 'react';
import { createRoot } from 'react-dom/client';
import './monacoWorkers.js';
import App from './App.jsx';
import { DialogProvider } from './components/Dialogs.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </React.StrictMode>
);
