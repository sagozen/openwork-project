import { useState } from "react";
import { Button, Field, Input, Checkbox } from "@fluentui/react-components";
import { usePatchCatalogItem, type ConfigCatalogItem } from "@/features/config";
import { RESULT_VALUE_NAMES, type ValueType } from "@/features/sample/sample-api";
import { apiErrorMessage } from "@/lib/api";
export function ResultConfigurationEditor({
  item,
  canWrite,
}: {
  item: ConfigCatalogItem;
  canWrite: boolean;
}) {
  const current = item.resultConfiguration;
  const [types, setTypes] = useState<ValueType[]>(
    current?.allowedValueTypes ?? [current?.valueType ?? "NUMERIC"],
  );
  const [choices, setChoices] = useState(current?.choices.join("\n") ?? "");
  const [units, setUnits] = useState(current?.allowedUnits.join("\n") ?? item.unit ?? "");
  const [method, setMethod] = useState(current?.method ?? "");
  const [parts, setParts] = useState(current?.testParts ?? ["WHOLE"]);
  const [accredited, setAccredited] = useState(current?.accredited ?? false);
  const [confirmed, setConfirmed] = useState(current?.accreditationConfirmed ?? false);
  const patch = usePatchCatalogItem();
  const lines = (text: string) =>
    Array.from(
      new Set(
        text
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
  return (
    <details>
      <summary>Cấu hình kết quả · v{item.configurationVersion ?? 0}</summary>
      <fieldset
        disabled={!canWrite || patch.isPending}
        style={{ display: "grid", gap: 8, padding: 12 }}
      >
        <Field label="Loại trị số được phép cho chỉ tiêu" required>
          <div>
            {(Object.keys(RESULT_VALUE_NAMES) as ValueType[]).map((type) => (
              <Checkbox
                key={type}
                label={RESULT_VALUE_NAMES[type]}
                checked={types.includes(type)}
                onChange={(_, data) =>
                  setTypes((current) =>
                    data.checked ? [...current, type] : current.filter((item) => item !== type),
                  )
                }
              />
            ))}
          </div>
        </Field>
        {types.includes("CATALOG_CHOICE") ? (
          <Field label="Lựa chọn (mỗi dòng một trị số)">
            <textarea value={choices} onChange={(e) => setChoices(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Đơn vị hợp lệ (mỗi dòng một đơn vị; để trống nếu không đơn vị)">
          <textarea value={units} onChange={(e) => setUnits(e.target.value)} />
        </Field>
        <Field label="Phương pháp">
          <Input value={method} onChange={(_, d) => setMethod(d.value)} />
        </Field>
        <div>
          {["WHOLE", "SKIN", "FLESH"].map((part) => (
            <Checkbox
              key={part}
              label={part}
              checked={parts.includes(part)}
              onChange={(_, d) =>
                setParts((p) => (d.checked ? [...p, part] : p.filter((v) => v !== part)))
              }
            />
          ))}
        </div>
        <Checkbox
          label="Chỉ tiêu được công nhận"
          checked={accredited}
          onChange={(_, d) => {
            setAccredited(!!d.checked);
            if (!d.checked) setConfirmed(false);
          }}
        />
        <Checkbox
          label="Dữ liệu công nhận đã được xác nhận"
          checked={confirmed}
          disabled={!accredited}
          onChange={(_, d) => setConfirmed(!!d.checked)}
        />
        <Button
          disabled={
            !types.length ||
            !parts.length ||
            !method.trim() ||
            (types.includes("CATALOG_CHOICE") && !choices.trim()) ||
            (types.includes("NUMERIC") && !units.trim())
          }
          onClick={() =>
            patch.mutate({
              id: item.id,
              patch: {
                resultConfiguration: {
                  valueType: types.includes(current?.valueType as ValueType)
                    ? current!.valueType
                    : types[0]!,
                  allowedValueTypes: types,
                  choices: types.includes("CATALOG_CHOICE") ? lines(choices).filter(Boolean) : [],
                  allowedUnits: lines(units),
                  method: method.trim(),
                  testParts: parts,
                  accredited,
                  accreditationConfirmed: confirmed,
                },
              },
            })
          }
        >
          Lưu cấu hình
        </Button>
        {patch.error ? <p role="alert">{apiErrorMessage(patch.error)}</p> : null}
      </fieldset>
    </details>
  );
}
