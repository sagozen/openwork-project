export function isHandoverWholeLotScan(
  code: string,
  context: { requestCode?: string; parentSampleCode?: string; scanCodes?: readonly string[] },
): boolean {
  const needle = code.trim().toLowerCase();
  if (!needle) return false;
  const aliases = [context.parentSampleCode, ...(context.scanCodes ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toLowerCase());
  return aliases.includes(needle);
}

export function handoverLotItems(input: {
  parentSampleCode?: string;
  subSamples?: readonly { code: string; index: number }[];
  sampleCodes?: readonly string[];
}): Array<{ code: string; kind: string }> {
  if (input.sampleCodes?.length) return input.sampleCodes.map((code) => ({ code, kind: "Mã mẫu" }));
  if (input.parentSampleCode?.trim()) {
    return [{ code: input.parentSampleCode.trim(), kind: "Mã mẫu" }];
  }
  return [];
}
