import { Routes, Route, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Orders from './pages/Orders.jsx';
import Operations from './pages/Operations.jsx';
import Calendar from './pages/Calendar.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  return (
    <div className="app">
      <Navbar />
      <div className="app-body">
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/inbox" element={<Navigate to="/#inbox" replace />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </div>
  );
}
