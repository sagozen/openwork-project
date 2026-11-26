import { useEffect, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
} from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { PageHead } from "@/components/lims/common";
import { ReportSupplementaryDocuments } from "@/components/lims/delivery/ReportSupplementaryDocuments";
import { card, hintText } from "@/components/lims/request-styles";
import { supplementaryDocumentKeys, useSupplementaryDocumentReports } from "@/features/report";
import { PERM } from "@/lib/admin/rbac";
import { toneToColor } from "@/lib/admin/tone";
import { apiErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { searchString } from "@/lib/route-search";

export const Route = createFileRoute("/_app/tai-lieu-bo-sung")({
  validateSearch: (search: Record<string, unknown>): { sampleCode?: string } => ({
    sampleCode: searchString(search["sampleCode"]),
  }),
  head: () => ({
    meta: [{ title: "Tài liệu bổ sung - DLP LIMS" }, { name: "robots", content: "noindex" }],
  }),
  component: SupplementaryDocumentsScreen,
});

function SupplementaryDocumentsScreen() {
  const { can } = useAuth();
  const allowed =
    can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD) || can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_READ);
  return allowed ? <SupplementaryDocumentsWorkspace /> : <NoAccess screen="Tài liệu bổ sung" />;
}

function SupplementaryDocumentsWorkspace() {
  const { can } = useAuth();
  const canAdd = can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD);
  const canReadDocuments = can(PERM.REPORT_READ) || can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_READ);
  const { sampleCode = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [input, setInput] = useState(sampleCode);
  const [selectedId, setSelectedId] = useState<string>();
  const reportsQuery = useSupplementaryDocumentReports(sampleCode);
  const busy = useIsMutating({ mutationKey: supplementaryDocumentKeys.all }) > 0;
  const reports = reportsQuery.data ?? [];
  const selected =
    reports.find((report) => report.id === selectedId) ??
    reports.find((report) => report.current) ??
    reports[0];

  useEffect(() => {
    setInput(sampleCode);
    setSelectedId(undefined);
  }, [sampleCode]);

  return (
    <div className="dlp-stack" style={{ maxWidth: 1000 }}>
      <PageHead
        crumbs={[{ label: "Nghiệp vụ" }, { label: "Tài liệu bổ sung" }]}
        title="Tài liệu bổ sung"
        description="Thêm hoặc mở tài liệu nội bộ của đúng phiên bản phiếu đã phát hành theo mã mẫu; không cần quyền ký hoặc phát hành phiếu."
      />
      <form
        style={{ ...card, gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !input.trim()) return;
          setSelectedId(undefined);
          if (input.trim() === sampleCode) void reportsQuery.refetch();
          else void navigate({ search: { sampleCode: input.trim() } });
        }}
      >
        <Field
          label="Mã mẫu"
          hint="Nhập hoặc quét mã mẫu để tìm các phiên bản phiếu kết quả."
          required
        >
          <Input
            value={input}
            disabled={busy}
            onChange={(_, data) => setInput(data.value)}
            placeholder="Nhập mã mẫu"
          />
        </Field>
        <div>
          <Button
            appearance="primary"
            type="submit"
            disabled={busy || !input.trim() || reportsQuery.isFetching}
          >
            Tìm phiếu kết quả
          </Button>
        </div>
      </form>
      {reportsQuery.isFetching ? <Spinner size="small" label="Đang tải phiên bản phiếu…" /> : null}
      {reportsQuery.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Không thể tải phiếu kết quả</MessageBarTitle>
            {apiErrorMessage(reportsQuery.error)}
            <Button
              appearance="subtle"
              disabled={reportsQuery.isFetching || busy}
              onClick={() => void reportsQuery.refetch()}
            >
              Thử lại
            </Button>
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {reportsQuery.isSuccess && reports.length === 0 ? (
        <MessageBar intent="info">
          <MessageBarBody>
            Mẫu {sampleCode} chưa có phiếu kết quả. Chỉ thêm tài liệu sau khi phiếu đã được phát
            hành.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {selected ? (
        <>
          <section style={{ ...card, gap: 12 }} aria-label="Chọn phiên bản phiếu">
            <Field label="Phiên bản phiếu kết quả">
              <select
                aria-label="Phiên bản phiếu kết quả"
                value={selected.id}
                disabled={busy || reportsQuery.isFetching}
                onChange={(event) => setSelectedId(event.target.value)}
                style={{ width: "100%", minHeight: 40 }}
              >
                {reports.map((report) => (
                  <option key={report.id} value={report.id}>
                    {report.reportCode} · phiên bản {report.version} · {report.status.name}
                    {report.current ? " · Hiện hành" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <Badge appearance="tint" color={toneToColor(selected.status.tone)}>
                {selected.status.name}
              </Badge>
            </div>
            {!canReadDocuments ? (
              <span style={hintText}>
                Quyền thêm tài liệu không bao gồm xem PDF phiếu hoặc mở tài liệu đã bổ sung. Cần
                thêm quyền Xem và tải tài liệu bổ sung (hoặc quyền xem phiếu kết quả).
              </span>
            ) : null}
          </section>
          <ReportSupplementaryDocuments
            reportId={selected.id}
            version={selected.version}
            status={selected.status.code}
            canAddSupplementaryDocument={canAdd}
            canReadDocuments={canReadDocuments}
            disabled={busy || reportsQuery.isFetching}
          />
        </>
      ) : null}
    </div>
  );
}
