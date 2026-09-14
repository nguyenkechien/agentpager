import { createContext, useCallback, useContext, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { BadgeState } from '../shared/api.js';
import { BADGE_LABELS } from '../shared/labels.js';

export function Badge({ state, large = false }: { state: BadgeState | null; large?: boolean }) {
  return (
    <span className={`badge badge-${state ?? 'unknown'}${large ? ' badge-large' : ''}`} data-testid="badge">
      <span className="badge-dot" aria-hidden="true" />
      {state === null ? 'Đang đọc trạng thái…' : BADGE_LABELS[state]}
    </span>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'link';
  busy?: boolean;
  busyLabel?: string;
}

export function Button({ variant = 'secondary', busy = false, busyLabel, children, disabled, type = 'button', className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`button button-${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled === true || busy}
      aria-busy={busy}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Banner({
  tone,
  title,
  children,
  actions,
}: {
  tone: 'info' | 'warn' | 'error';
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
      <div className="banner-body">
        {title ? <strong>{title}</strong> : null}
        {children ? <div className="banner-text">{children}</div> : null}
      </div>
      {actions ? <div className="banner-actions">{actions}</div> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  errors,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  errors?: readonly string[];
  children: ReactNode;
}) {
  const errorId = `${htmlFor}-errors`;
  return (
    <div className={`field${errors && errors.length > 0 ? ' field-invalid' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
      {errors && errors.length > 0 ? (
        <ul className="field-errors" id={errorId} role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface Toast {
  id: number;
  tone: 'info' | 'error';
  message: string;
}

interface ToastContextValue {
  show: (message: string, tone?: Toast['tone']) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
export const TOAST_DURATION_MS = 6_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const show = useCallback(
    (message: string, tone: Toast['tone'] = 'info') => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((current) => [...current, { id, tone, message }]);
      setTimeout(() => {
        dismiss(id);
      }, TOAST_DURATION_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
            <span>{toast.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Đóng thông báo"
              onClick={() => {
                dismiss(toast.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast needs a ToastProvider');
  return value;
}
