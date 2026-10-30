import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Navbar, Footer } from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Orders from './pages/Orders.jsx';
import Plan from './pages/Plan.jsx';
import Payments from './pages/Payments.jsx';
import Risks from './pages/Risks.jsx';
import Analytics from './pages/Analytics.jsx';
import WhatIf from './pages/WhatIf.jsx';
import Inbox from './pages/Inbox.jsx';
import Settings from './pages/Settings.jsx';

// Old addresses keep working: the Deadlines page became Plan (and its what-if section became What-if), Operations and Dashboard were merged.
function Moved({ to, simulation }) {
  const { hash } = useLocation();
  return <Navigate to={simulation && hash === '#simulation' ? '/whatif' : to} replace />;
}

export default function App() {
  return (
    <div className="app">
      <Navbar />
      <div className="app-body">
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/plan" element={<Plan />} />
            <Route path="/risks" element={<Risks />} />
            <Route path="/insights" element={<Analytics />} />
            <Route path="/whatif" element={<WhatIf />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/deadlines" element={<Moved to="/plan" simulation />} />
            <Route path="/operations" element={<Moved to="/plan" />} />
            <Route path="/dashboard" element={<Moved to="/insights" />} />
            <Route path="/calendar" element={<Moved to="/plan" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </div>
  );
}
