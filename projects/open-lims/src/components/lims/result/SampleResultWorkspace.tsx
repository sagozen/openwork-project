import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Spinner,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { PageHead, StatStrip, useDlpToast } from "@/components/lims/common";
import { apiErrorMessage, useApiClient, uploadFile, downloadDocument } from "@/lib/api";
import { saveBlob } from "@/features/report";
import {
  sampleApi,
  statusLabel,
  type SampleParameter,
  type SampleRawInput,
} from "@/features/sample/sample-api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { card } from "@/components/lims/request-styles";
import { ResultGrid } from "./ResultGrid";
import { ConclusionPane } from "./ConclusionPane";
import { ImportResultDrawer } from "./ImportResultDrawer";

export function SampleResultWorkspace({ sampleCode }: { sampleCode: string }) {
  const api = useApiClient();
  const cache = useQueryClient();
  const toast = useDlpToast();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [scanCode, setScanCode] = useState("");
  const scanInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!sampleCode) scanInputRef.current?.focus({ preventScroll: true });
  }, [sampleCode]);
  const [dialog, setDialog] = useState(false);
  const [busyParameters, setBusyParameters] = useState<string[]>([]);
  const setParameterBusy = useCallback(
    (code: string, busy: boolean) =>
      setBusyParameters((current) =>
        busy ? [...new Set([...current, code])] : current.filter((item) => item !== code),
      ),
    [],
  );
  const query = useQuery({
    queryKey: ["sample-results", sampleCode],
    queryFn: () => sampleApi.results(api, sampleCode),
    enabled: !!sampleCode && can(PERM.LAB_READ),
  });
  const submit = useMutation({
    mutationFn: () => sampleApi.submit(api, sampleCode, query.data!.version),
    onSuccess: async () => {
      setDialog(false);
      await cache.invalidateQueries();
      toast("Đã gửi cả mẫu kiểm tra kỹ thuật");
    },
  });
  const workspace = query.data;
  const parameters = workspace?.parameters ?? [];
  const sets = parameters.flatMap((parameter) => parameter.resultSets);
  const complete =
    parameters.length > 0 &&
    parameters.every(
      (parameter) =>
        parameter.resultSets.length > 0 &&
        parameter.resultSets.every(
          (set) => set.rawResults.length > 0 && !!set.finalResult?.rawResultId,
        ) &&
        parameter.technicalFiles.some((file) => file.status === "AVAILABLE"),
    );
  const canSubmit =
    !!workspace &&
    !query.isError &&
    complete &&
    !workspace.locked &&
    can(PERM.LAB_TASK_WORK) &&
    workspace.allowedActions.includes("sample:submit-review") &&
    !busyParameters.length;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <PageHead
        crumbs={[
          { label: "Bảng công việc lab", to: "/cong-viec" },
          { label: sampleCode || "Nhập kết quả" },
        ]}
        title={`Nhập kết quả thử nghiệm · ${sampleCode || "Chọn mẫu"}`}
        description={
          workspace
            ? `Hồ sơ ${workspace.requestCode} · ${statusLabel(workspace.status)} · Phiên bản ${workspace.version}`
            : "Quét mã mẫu trên phiếu để nhập kết quả hoặc chọn mẫu từ bảng công việc lab."
        }
        actions={
          workspace ? (
            <Button
              appearance="primary"
              disabled={!canSubmit || submit.isPending}
              onClick={() => setDialog(true)}
            >
              Gửi cả mẫu kiểm tra kỹ thuật
            </Button>
          ) : undefined
        }
      />
      <form
        style={card}
        onSubmit={(event) => {
          event.preventDefault();
          const code = scanCode.trim();
          if (!code) return;
          void navigate({ to: "/nhap-ket-qua", search: { code } });
          setScanCode("");
        }}
      >
        <Field
          label="Quét mã mẫu trên phiếu"
          hint="Máy quét nhập mã và Enter để mở phiếu. Có thể quét mã tiếp theo ngay tại đây."
        >
          <Input
            ref={scanInputRef}
            value={scanCode}
            autoComplete="off"
            placeholder="Quét hoặc nhập mã mẫu"
            onChange={(_, data) => setScanCode(data.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) {
                event.preventDefault();
              }
            }}
          />
        </Field>
        <Button
          type="submit"
          appearance="primary"
          disabled={!scanCode.trim()}
          style={{ alignSelf: "flex-start" }}
        >
          Mở phiếu
        </Button>
      </form>
      {!sampleCode ? (
        <Link to="/cong-viec">Mở bảng công việc lab để chọn mẫu</Link>
      ) : query.isPending ? (
        <Spinner label="Đang tải mẫu…" />
      ) : null}
      {query.error || submit.error ? (
        <MessageBar intent="error">
          <MessageBarBody>
            {apiErrorMessage(query.error || submit.error)}
            {query.error ? (
              <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
                Tải lại dữ liệu
              </Button>
            ) : null}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {workspace ? (
        <>
          <StatStrip
            items={[
              { label: "Chỉ tiêu", value: parameters.length, tone: "brand" },
              {
                label: "Kết quả gốc",
                value: sets.reduce((count, set) => count + set.rawResults.length, 0),
                tone: "info",
              },
              {
                label: "Kết quả cuối",
                value: `${sets.filter((set) => set.finalResult?.rawResultId).length}/${sets.length}`,
                tone: "success",
              },
              {
                label: "File kỹ thuật sẵn sàng",
                value: `${parameters.filter((p) => p.technicalFiles.some((f) => f.status === "AVAILABLE")).length}/${parameters.length}`,
                tone: "info",
              },
            ]}
          />
          {workspace.failedParameters.length ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                Chỉ sửa chỉ tiêu bị trả: {workspace.failedParameters.join(", ")}
              </MessageBarBody>
            </MessageBar>
          ) : null}
          {workspace.locked ? (
            <MessageBar intent="info">
              <MessageBarBody>Mẫu đã gửi kiểm tra và đang khoá chỉnh sửa.</MessageBarBody>
            </MessageBar>
          ) : !complete ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                Mỗi chỉ tiêu cần đủ lần đo, kết quả cuối cho các thành phần thử và ít nhất một file
                kỹ thuật sẵn sàng trước khi gửi cả mẫu.
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <nav aria-label="Chỉ tiêu của mẫu" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {parameters.map((parameter) => (
              <a key={parameter.code} href={`#parameter-${encodeURIComponent(parameter.code)}`}>
                {parameter.name}
              </a>
            ))}
          </nav>
          {parameters.map((parameter) => (
            <ParameterEntry
              key={`${workspace.sampleCode}:${parameter.code}:${workspace.version}:${parameter.configurationVersion}`}
              parameter={parameter}
              sampleCode={sampleCode}
              version={workspace.version}
              locked={workspace.locked || submit.isPending}
              editable={
                can(PERM.LAB_TASK_WORK) && parameter.editable && !workspace.locked && !query.isError
              }
              onBusy={setParameterBusy}
              reload={async () => {
                const result = await query.refetch();
                if (result.error) throw result.error;
              }}
            />
          ))}
        </>
      ) : null}
      <Dialog
        open={dialog}
        onOpenChange={(_, data) => {
          if (!submit.isPending) setDialog(data.open);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Gửi kiểm tra kỹ thuật</DialogTitle>
            <DialogContent>
              Gửi toàn bộ chỉ tiêu của mẫu {sampleCode}. Sau khi gửi, mẫu sẽ khoá chỉnh sửa.
            </DialogContent>
            <DialogActions>
              <Button disabled={submit.isPending} onClick={() => setDialog(false)}>
                Huỷ
              </Button>
              <Button
                appearance="primary"
                disabled={!canSubmit || submit.isPending}
                onClick={() => submit.mutate()}
              >
                Xác nhận gửi
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function ParameterEntry({
  parameter: p,
  sampleCode,
  version,
  locked,
  editable,
  reload,
  onBusy,
}: {
  parameter: SampleParameter;
  sampleCode: string;
  version: number;
  locked: boolean;
  editable: boolean;
  reload: () => Promise<void>;
  onBusy: (code: string, busy: boolean) => void;
}) {
  const api = useApiClient();
  const toast = useDlpToast();
  const { can } = useAuth();
  const [part, setPart] = useState(p.testParts[0] ?? p.resultSets[0]?.testPart ?? "WHOLE");
  const [importOpen, setImportOpen] = useState(false);
  const [unit, setUnit] = useState(p.allowedUnits[0] ?? "");
  const [refreshError, setRefreshError] = useState("");
  const task = `/analysis-tasks/${encodeURIComponent(p.taskCode)}`;
  const context = { sampleCode, parameterCode: p.code, version };
  const write = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => {
      await action();
      try {
        await reload();
        setRefreshError("");
      } catch (cause) {
        // A saved measurement is immutable; a failed refresh must not invite resubmission.
        setRefreshError(apiErrorMessage(cause));
      }
    },
    onSuccess: () => toast("Đã lưu"),
  });
  useEffect(() => {
    onBusy(p.code, write.isPending || importOpen);
    return () => onBusy(p.code, false);
  }, [p.code, write.isPending, importOpen, onBusy]);
  const run = (action: () => Promise<unknown>) => write.mutateAsync(action);
  const raw = (input: SampleRawInput) => api.post(`${task}/raw-results`, { ...input, ...context });
  return (
    <section
      id={`parameter-${encodeURIComponent(p.code)}`}
      style={{ display: "grid", gap: 12, scrollMarginTop: 80, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>
            {p.name} · {p.code}
          </h2>
          <span className="dlp-datagrid__secondary">
            {p.method} · cấu hình v{p.configurationVersion}
          </span>
        </div>
        <Badge appearance="tint">{editable ? "Được nhập" : "Chỉ đọc"}</Badge>
        {!locked && can(PERM.LAB_TASK_WORK) && p.allowedActions?.includes("task:start") ? (
          <Button
            disabled={write.isPending}
            onClick={() => void run(() => api.post(`${task}/start`)).catch(() => {})}
          >
            Bắt đầu
          </Button>
        ) : null}
        {!locked && can(PERM.LAB_TASK_CLAIM) && p.allowedActions?.includes("task:claim") ? (
          <Button
            disabled={write.isPending}
            onClick={() => void run(() => api.post(`${task}/claim`)).catch(() => {})}
          >
            Nhận chỉ tiêu
          </Button>
        ) : null}
        {editable ? (
          <Button disabled={write.isPending || locked} onClick={() => setImportOpen(true)}>
            Dán từ Excel · {p.name}
          </Button>
        ) : null}
      </div>
      {p.returnedFeedback ? (
        <MessageBar intent="warning">
          <MessageBarBody>{p.returnedFeedback.comment}</MessageBarBody>
        </MessageBar>
      ) : null}
      {write.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{apiErrorMessage(write.error)}</MessageBarBody>
        </MessageBar>
      ) : null}
      {refreshError && !editable ? (
        <MessageBar intent="warning">
          <MessageBarBody>Đã lưu; chưa tải lại được dữ liệu: {refreshError}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <ResultGrid
          sets={p.resultSets}
          activePart={part}
          unit={unit}
          onUnit={setUnit}
          sampleCode={sampleCode}
          parameter={p}
          disabled={!editable || locked || importOpen}
          busy={write.isPending}
          onPart={setPart}
          onAddRaw={(input) => run(() => raw(input))}
          onSelectFinal={(testPart, rawResultId, comment) =>
            run(() =>
              api.put(`${task}/final-result`, {
                ...context,
                testPart,
                rawResultId,
                ...(comment ? { comment } : {}),
              }),
            )
          }
        />
        <ConclusionPane
          files={p.technicalFiles}
          requiresFile
          disabled={!editable || locked || importOpen}
          busy={write.isPending}
          onAddFile={(file) =>
            run(async () => {
              const doc = await uploadFile(api, file, {
                grant: "lab:technical-file",
                fileName: file.name,
              });
              await api.post(`${task}/technical-files`, { ...context, documentId: doc.id });
            }).catch(() => {})
          }
          onDownload={(file) =>
            run(async () =>
              saveBlob(await downloadDocument(api, file.documentId), file.fileName),
            ).catch(() => {})
          }
        />
      </div>
      {importOpen ? (
        <ImportResultDrawer
          open
          onOpenChange={setImportOpen}
          sets={p.resultSets}
          part={part}
          onPart={setPart}
          sampleCode={sampleCode}
          unit={unit}
          parameter={p}
          onUnit={setUnit}
          onImportRow={async (input) => {
            await raw(input);
          }}
          onDone={reload}
        />
      ) : null}
    </section>
  );
}
