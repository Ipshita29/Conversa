export default function StateMessage({ kind = 'empty', message, onRetry, children }) {
  return (
    <div className={`state-message state-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      {children}
      {onRetry && <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>}
    </div>
  );
}
