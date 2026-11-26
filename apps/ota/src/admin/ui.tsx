/**
 * Small form and status primitives shared by the admin tabs. Plain elements styled by `styles.css`,
 * so the admin needs no component library beyond the app shell.
 */

import type { ChangeEvent, ReactNode } from "react";

type Tone = "success" | "error" | "warning" | "secondary";

export function Badge({ variant = "secondary", children }: { variant?: Tone; children: ReactNode }) {
  return (
    <span className="ota-badge" data-tone={variant}>
      {children}
    </span>
  );
}

export function Button({
  type = "button",
  onClick,
  disabled,
  children,
}: {
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type={type} className="ota-btn" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Input({
  label,
  value,
  onChange,
  required,
  placeholder,
  maxLength,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  type?: "text" | "password";
}) {
  return (
    <label className="ota-field">
      <span>{label}</span>
      <input
        className="ota-input"
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
      />
    </label>
  );
}

export function Select({
  label,
  value,
  items,
  onValueChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <label className="ota-field">
      <span>{label}</span>
      <select className="ota-input" value={value} onChange={(event) => onValueChange(event.target.value)}>
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Switch({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  );
}
