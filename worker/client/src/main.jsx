import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { SessionProvider } from './api/session.jsx';
import App from './App';
import './index.css';

// A data router, so an editor with unsaved changes can hold an in-app
// navigation (useBlocker) and ask first. The routes themselves are the
// <Routes> inside App, under one splat route.
const router = createBrowserRouter([{ path: '*', element: <SessionProvider><App /></SessionProvider> }], { basename: import.meta.env.BASE_URL.replace(/\/$/, '') });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
