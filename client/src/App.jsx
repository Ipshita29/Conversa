import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Orders from './pages/Orders.jsx';
import Operations from './pages/Operations.jsx';
import Calendar from './pages/Calendar.jsx';
import Inbox from './pages/Inbox.jsx';

export default function App() {
  return (
    <div className="app">
      <Navbar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/inbox" element={<Inbox />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
