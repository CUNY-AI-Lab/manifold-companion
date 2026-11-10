import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SessionProvider } from './api/session.jsx';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
