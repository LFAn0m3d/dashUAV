import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  createBrowserRouter,
  RouterProvider,
} from 'react-router-dom';
import App from './pages/App';
import Dashboard from './pages/Dashboard';
import Map from './pages/Map';
import Threats from './pages/Threats';
import Data from './pages/Data';
import Settings from './pages/Settings';
import Auth from './pages/Auth';
import './index.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'map', element: <Map /> },
      { path: 'threats', element: <Threats /> },
      { path: 'data', element: <Data /> },
      { path: 'settings', element: <Settings /> },
      { path: 'auth', element: <Auth /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
