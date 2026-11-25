import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/themes.css';
import './styles/control.css';
import './styles/presentation.css';
import './styles/spectator.css';
import './styles/scorekeeper.css';
import './styles/system.css';
import './styles/bracket.css';
import './styles/modals.css';
import './styles/hub.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
