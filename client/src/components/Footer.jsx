import { Link } from 'react-router-dom';
import '../css/Footer.css';

export default function Footer() {
  return (
    <footer className="footer">
      <small>Conversa · The AI reads. Rules decide. You approve.</small>
      <Link to="/settings">Integrations</Link>
    </footer>
  );
}
