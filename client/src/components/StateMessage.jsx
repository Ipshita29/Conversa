export default function StateMessage({ kind = 'empty', message, onRetry }) {
  return (
    <div className={`state-message state-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  );
}
