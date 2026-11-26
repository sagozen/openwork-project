import type { InputHTMLAttributes } from "react";

/**
 * A six-digit code as one field: phones offer the code from the email or SMS,
 * paste works, and screen readers hear one input instead of six boxes.
 */
export default function OtpInput({
  value,
  onValue,
  length = 6,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValue: (value: string) => void;
  length?: number;
}) {
  return (
    <input
      {...rest}
      className="otp-input"
      value={value}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern={`[0-9]{${length}}`}
      maxLength={length}
      spellCheck={false}
      onChange={(event) =>
        onValue(event.target.value.replace(/\D/g, "").slice(0, length))
      }
    />
  );
}
