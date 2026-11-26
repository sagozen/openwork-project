import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
} from "@fluentui/react-components";
import { FileDropField } from "@/components/lims/common";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import {
  reportApi,
  openBlob,
  saveBlob,
  supplementaryDocumentKeys,
  useAddReportSupplementaryDocument,
  useReportApi,
  useReportSupplementaryDocuments,
  type SupplementaryDocument,
} from "@/features/report";
import { apiErrorMessage, uploadFile } from "@/lib/api";
import { formatDateTime, formatFileSize } from "@/lib/format";

interface ReportSupplementaryDocumentsProps {
  reportId: string;
  version: number;
  status: string;
  canAddSupplementaryDocument: boolean;
  canReadDocuments?: boolean;
  disabled?: boolean;
}

interface SupplementaryDocumentDraft {
  file: File;
  documentId?: string;
}

export function ReportSupplementaryDocuments(props: ReportSupplementaryDocumentsProps) {
  // A version change unmounts its draft and mutation observers, even if a caller forgets a key.
  return <SupplementaryDocumentsForVersion key={props.reportId} {...props} />;
}

function SupplementaryDocumentsForVersion({
  reportId,
  version,
  status,
  canAddSupplementaryDocument,
  canReadDocuments = true,
  disabled,
}: ReportSupplementaryDocumentsProps) {
  const api = useReportApi();
  const documentsQuery = useReportSupplementaryDocuments(reportId, true, !canReadDocuments);
  const add = useAddReportSupplementaryDocument();
  const [draft, setDraft] = useState<SupplementaryDocumentDraft>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const append = useMutation({
    mutationKey: supplementaryDocumentKeys.detail(reportId),
    mutationFn: async (input: SupplementaryDocumentDraft & { reportId: string }) => {
      let documentId = input.documentId;
      if (!documentId) {
        const uploaded = await uploadFile(api, input.file, {
          grant: "report.supplementary-document",
          fileName: input.file.name,
        });
        documentId = uploaded.id;
        if (mounted.current) {
          // Keep the uploaded id if linking fails, so retry does not upload the same bytes again.
          setDraft((current) =>
            current?.file === input.file ? { ...current, documentId: uploaded.id } : current,
          );
        }
      }
      if (!mounted.current) {
        throw new Error("Phiên bản đang xem đã thay đổi; tài liệu chưa được gắn vào phiếu.");
      }
      // Use the id captured at submission, never a later selected version.
      return add.mutateAsync({ reportId: input.reportId, documentId });
    },
    onSuccess: () => {
      if (mounted.current) setDraft(undefined);
    },
  });
  const download = useMutation({
    mutationKey: supplementaryDocumentKeys.detail(reportId),
    mutationFn: async (input: { reportId: string; document: SupplementaryDocument }) =>
      saveBlob(
        await reportApi.downloadSupplementaryDocument(
          api,
          input.reportId,
          input.document.documentId,
        ),
        input.document.fileName,
      ),
  });
  // Same authenticated bytes as the download; a blob URL lets the browser render PDFs and
  // images in a new tab instead of forcing a save dialog that hides what was attached.
  const preview = useMutation({
    mutationKey: supplementaryDocumentKeys.detail(reportId),
    mutationFn: async (input: { reportId: string; document: SupplementaryDocument }) =>
      openBlob(
        await reportApi.downloadSupplementaryDocument(
          api,
          input.reportId,
          input.document.documentId,
        ),
      ),
  });

  const canAppend = canAddSupplementaryDocument && status === "RELEASED";
  const busy = Boolean(disabled || append.isPending || download.isPending || preview.isPending);
  const downloadingId = download.isPending ? download.variables?.document.documentId : undefined;
  const previewingId = preview.isPending ? preview.variables?.document.documentId : undefined;
  const documents = documentsQuery.data?.items ?? [];
  const submit = () => {
    if (draft && canAppend && !busy) append.mutate({ ...draft, reportId });
  };

  return (
    <section style={{ ...card, gap: 12 }} aria-label="Tài liệu bổ sung">
      <div style={sectionTitle}>Tài liệu bổ sung · phiên bản {version}</div>
      <MessageBar intent="info">
        <MessageBarBody>
          Tài liệu bổ sung chỉ được lưu nội bộ cho đúng phiên bản này; không thay thế bản scan đã ký
          hoặc PDF đã phát hành, không tự động gửi qua email và không xuất hiện trên tra cứu công
          khai. Có thể thêm nhiều tài liệu, mỗi lần một tệp; tài liệu đã thêm không sửa hoặc xoá và
          không chuyển sang phiên bản thay thế.
        </MessageBarBody>
      </MessageBar>

      {documentsQuery.isFetching ? (
        <Spinner
          size="tiny"
          label={
            documentsQuery.isLoading
              ? "Đang tải tài liệu bổ sung…"
              : "Đang cập nhật tài liệu bổ sung…"
          }
        />
      ) : null}
      {documentsQuery.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Không thể tải tài liệu bổ sung</MessageBarTitle>
            {apiErrorMessage(documentsQuery.error)}
            <Button
              appearance="subtle"
              disabled={documentsQuery.isFetching}
              onClick={() => void documentsQuery.refetch()}
            >
              Thử tải lại danh sách
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {documentsQuery.isSuccess && documents.length === 0 ? (
        <span style={hintText}>Phiên bản này chưa có tài liệu bổ sung.</span>
      ) : null}
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
        {documents.map((document) => (
          <li
            key={document.documentId}
            style={{ display: "flex", gap: 12, justifyContent: "space-between", flexWrap: "wrap" }}
          >
            <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <strong>{document.fileName}</strong>
              <div style={hintText}>
                {formatFileSize(document.sizeBytes)} · {document.addedBy.fullName} ·{" "}
                {formatDateTime(document.addedAt)}
              </div>
            </div>
            {canReadDocuments ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  disabled={busy}
                  aria-label={`Xem tài liệu bổ sung ${document.fileName}`}
                  icon={previewingId === document.documentId ? <Spinner size="tiny" /> : undefined}
                  onClick={() => preview.mutate({ reportId, document })}
                >
                  Xem
                </Button>
                <Button
                  appearance="primary"
                  disabled={busy}
                  aria-label={`Tải tài liệu bổ sung ${document.fileName}`}
                  icon={downloadingId === document.documentId ? <Spinner size="tiny" /> : undefined}
                  onClick={() => download.mutate({ reportId, document })}
                >
                  Tải xuống
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {download.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>
              Không thể tải tệp {download.variables?.document.fileName}
            </MessageBarTitle>
            {apiErrorMessage(download.error)}
            <Button
              appearance="subtle"
              disabled={busy}
              onClick={() => download.variables && download.mutate(download.variables)}
            >
              Thử tải lại tệp
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {preview.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>
              Không thể mở tệp {preview.variables?.document.fileName}
            </MessageBarTitle>
            {apiErrorMessage(preview.error)}
            <Button
              appearance="subtle"
              disabled={busy}
              onClick={() => preview.variables && preview.mutate(preview.variables)}
            >
              Thử mở lại tệp
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {canAppend ? (
        <>
          <Field label="Thêm một tài liệu bổ sung">
            <FileDropField
              accept=""
              idle="Chọn tài liệu bổ sung cho phiên bản đã phát hành"
              selected={
                draft ? `${draft.file.name} · ${formatFileSize(draft.file.size)}` : undefined
              }
              pending={append.isPending}
              pendingLabel={
                add.isPending ? "Đang gắn tài liệu vào phiên bản…" : "Đang tải tài liệu lên…"
              }
              disabled={busy}
              onFile={(file) => {
                setDraft({ file });
                append.reset();
                add.reset();
              }}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button appearance="primary" disabled={busy || !draft} onClick={submit}>
              {append.isPending
                ? "Đang thêm tài liệu…"
                : append.isError
                  ? "Thử thêm lại tài liệu"
                  : "Thêm tài liệu bổ sung"}
            </Button>
            {draft ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setDraft(undefined);
                  append.reset();
                  add.reset();
                }}
              >
                Bỏ tệp đang chọn
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <span style={hintText}>
          {status !== "RELEASED"
            ? "Chỉ thêm tài liệu khi phiên bản đang ở trạng thái Đã phát hành; không thể bổ sung vào phiên bản đã thay thế."
            : "Cần quyền report.supplementaryDocument.add để thêm tài liệu bổ sung."}
        </span>
      )}
      {append.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Chưa thể thêm tài liệu bổ sung</MessageBarTitle>
            {apiErrorMessage(append.error)}
            {draft?.documentId
              ? " Tệp đã tải lên; thử thêm lại không cần tải lại tệp."
              : " Tệp đang chọn vẫn được giữ để thử lại."}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {append.isSuccess ? (
        <MessageBar intent="success">
          <MessageBarBody>
            Đã thêm {append.data.fileName} vào phiên bản {version}. Chọn tệp tiếp theo để thêm tài
            liệu khác.
          </MessageBarBody>
        </MessageBar>
      ) : null}
    </section>
  );
}
