import { Input, type InputProps } from "@fluentui/react-components";
import { formatVndInput, parseVndInput } from "@/lib/format";

type Props = Omit<
  InputProps,
  "value" | "defaultValue" | "onChange" | "onBlur" | "type" | "inputMode"
> & {
  value: string;
  onChange: (value: string) => void;
};

export function VndAmountInput({ value, onChange, ...props }: Props) {
  return (
    <Input
      contentAfter="₫"
      {...props}
      inputMode="decimal"
      value={value}
      onChange={(_, data) => onChange(data.value)}
      onBlur={() => {
        // Rewriting a focused input resets its caret and makes separators impossible to delete.
        // Leave invalid text visible instead of stripping it into a different payable amount.
        if (Number.isFinite(parseVndInput(value))) onChange(formatVndInput(value));
      }}
    />
  );
}
