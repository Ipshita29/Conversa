import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'lenis/dist/lenis.css';
import App from './App.jsx';
import SmoothScroll from './components/SmoothScroll.jsx';
import './css/global.css';

// A refresh always starts at the top: no browser scroll restoration, and a stale #section hash is dropped on reload.
// (A hash on a normal visit, e.g. /inbox -> /#inbox, is still honoured.)
window.history.scrollRestoration = 'manual';
if (performance.getEntriesByType?.('navigation')[0]?.type === 'reload' && window.location.hash) {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
window.scrollTo(0, 0);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <SmoothScroll>
        <App />
      </SmoothScroll>
    </BrowserRouter>
  </React.StrictMode>
);
