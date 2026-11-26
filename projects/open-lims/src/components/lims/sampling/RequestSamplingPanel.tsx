import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Button, MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import { toneToColor } from "@/lib/admin/tone";
import { formatDate } from "@/features/request/ui/format";
import { downloadDocument, fetchDocument, useApiClient } from "@/lib/api";
import { saveBlob } from "@/features/report";
import { RequestError } from "@/features/request/ui/request-ui";
import {
  reconciliationFields,
  type Declaration,
  type ReconciliationField,
  type SamplingAssignmentDetail,
} from "@/features/sampling/types";

/**
 * Tab «Lấy mẫu» của S-03 (URD 8.1 tab 3) — bản chụp hiện trường, chỉ đọc.
 *
 * Dựng từ `GET /sampling-assignments/{code}`, cùng nguồn với màn `/lay-mau`. Không ô nhập: trường
 * nhóm B muốn sửa phải đi qua yêu cầu sửa hồ sơ (UF-16, BR-025), và tab không nhân đôi thao tác
 * của màn nghiệp vụ (D29).
 *
 * BM02/BM03 và file đính kèm được đọc từ `GET /sampling-assignments/{code}`. Các file được tải
 * xuống theo FR-DOC-014; màn này không nhúng nội dung tài liệu vào trang.
 *
 * Một vài thông tin khác chưa có trong hợp đồng API (người phân công và thời điểm ở khối 1; người
 * đối soát và thời điểm ở khối 2; sáu cột truy xuất mỗi dòng mẫu ở khối 5).
 */

const FIELD_LABELS: Record<ReconciliationField, string> = {
  productName: "Tên sản phẩm",
  growingAreaCode: "Mã vùng trồng",
  packingHouseCode: "Mã cơ sở đóng gói",
  vehiclePlate: "Biển số xe",
  containerNo: "Số container",
  trailerNo: "Số rơ-moóc",
  sealNo: "Số seal",
};

const CONCLUSION_LABELS = {
  CONFORMED: { text: "Phù hợp", tone: "success" as const },
  NOT_CONFORMED: { text: "Không phù hợp", tone: "warning" as const },
};

/** Ô trống thống nhất một dấu, để không lẫn giữa «hồ sơ không khai» và «API không trả». */
const BLANK = "—";

function text(value: string | null | undefined) {
  return value == null || value === "" ? BLANK : value;
}

function Section({
  title,
  children,
  actions,
  note,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  note?: string;
}) {
  return (
    <section className="dlp-card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: "var(--font-size-400)", fontWeight: 600 }}>{title}</h3>
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      {children}
      {note ? (
        <div
          style={{
            marginTop: 10,
            fontSize: "var(--font-size-200)",
            color: "var(--foreground-secondary)",
          }}
        >
          {note}
        </div>
      ) : null}
    </section>
  );
}

function FieldGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
        gap: "12px 24px",
      }}
    >
      {items.map(([label, value]) => (
        <div key={label}>
          <small style={{ color: "var(--foreground-secondary)" }}>{label}</small>
          <div style={{ fontWeight: 500 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function Scroller({ children }: { children: React.ReactNode }) {
  return <div style={{ overflowX: "auto" }}>{children}</div>;
}

/** Tệp vẫn được tải xuống theo quy định tài liệu; tên file giúp quầy nhận đúng ảnh/chữ ký. */
function SamplingEvidence({ id, label }: { id: string; label: string }) {
  const api = useApiClient();
  const document = useQuery({
    queryKey: ["document", id],
    queryFn: () => fetchDocument(api, id),
  });
  const download = useMutation({
    mutationFn: async () =>
      saveBlob(await downloadDocument(api, id), document.data?.fileName ?? `${label}-${id}`),
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ minWidth: 180 }}>{label}</span>
      {document.isLoading ? <Spinner size="tiny" label="Đang tải tên tệp…" /> : null}
      {document.data ? (
        <>
          <span style={{ color: "var(--foreground-secondary)" }}>{document.data.fileName}</span>
          <Button
            size="small"
            appearance="secondary"
            disabled={download.isPending}
            onClick={() => download.mutate()}
          >
            {download.isPending ? "Đang tải…" : "Tải xuống"}
          </Button>
        </>
      ) : null}
      <RequestError error={document.error ?? download.error} />
    </div>
  );
}

function EvidenceList({
  items,
}: {
  items: Array<{ id: string; label: string }>;
}) {
  return items.length ? (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map((item) => (
        <SamplingEvidence key={item.id} {...item} />
      ))}
    </div>
  ) : (
    <div style={{ color: "var(--foreground-secondary)" }}>Chưa có tệp đính kèm.</div>
  );
}

/** Khối 2 — đối soát bảy trường truy xuất: khai báo BM01 cạnh giá trị thực tế, kèm phán quyết. */
function ReconciliationTable({
  declaration,
  reconciliation,
}: {
  declaration: Declaration;
  reconciliation: SamplingAssignmentDetail["reconciliation"];
}) {
  // Đi theo bảy trường của BR-021 chứ không theo mảng `items` máy chủ trả: dòng chưa đối soát vẫn
  // phải hiện với giá trị khai báo của nó. Lọc theo `items` sẽ làm trường chưa đối soát biến mất
  // khỏi bảng, và một bảng sáu dòng trông y như một cuộc đối soát đã xong.
  const byField = new Map((reconciliation?.items ?? []).map((item) => [item.field, item]));
  return (
    <Scroller>
      <table className="dlp-datagrid" style={{ minWidth: 720 }}>
        <thead>
          <tr>
            <th>Trường truy xuất</th>
            <th>Khai báo BM01</th>
            <th>Giá trị thực tế</th>
            <th style={{ width: 120 }}>Đối soát</th>
          </tr>
        </thead>
        <tbody>
          {reconciliationFields.map((field) => {
            const item = byField.get(field);
            return (
              <tr key={field}>
                <td>{item?.fieldName ?? FIELD_LABELS[field]}</td>
                <td className="dlp-num">{text(declaration[field])}</td>
                <td className="dlp-num">{text(item?.actualValue)}</td>
                <td>
                  {item ? (
                    <Badge
                      appearance="tint"
                      color={item.verdict === "MATCH" ? "success" : "warning"}
                    >
                      {item.verdict === "MATCH" ? "Khớp" : "Lệch"}
                    </Badge>
                  ) : (
                    <span style={{ color: "var(--foreground-secondary)" }}>Chưa đối soát</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Scroller>
  );
}

/** Khối 3 — đề nghị sửa thông tin hiện trường đang chờ duyệt. */
function ChangeRequestTable({
  change,
}: {
  change: NonNullable<SamplingAssignmentDetail["pendingChangeRequest"]>;
}) {
  return (
    <Scroller>
      <table className="dlp-datagrid" style={{ minWidth: 760 }}>
        <thead>
          <tr>
            <th>Trường</th>
            <th style={{ width: 240 }}>Giá trị cũ → mới</th>
            <th>Lý do</th>
            <th style={{ width: 200 }}>Người đề nghị</th>
          </tr>
        </thead>
        <tbody>
          {change.fields.map((field) => (
            <tr key={field.field}>
              <td>{field.fieldName ?? FIELD_LABELS[field.field]}</td>
              <td className="dlp-num">
                <s style={{ color: "var(--foreground-secondary)" }}>{text(field.oldValue)}</s> →{" "}
                {text(field.newValue)}
              </td>
              <td>{text(change.reason)}</td>
              <td>
                <div>{change.requestedBy.fullName || change.requestedBy.id}</div>
                <div className="dlp-datagrid__secondary">{formatDate(change.requestedAt)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}

export function RequestSamplingPanel({ assignment }: { assignment: SamplingAssignmentDetail }) {
  const { reconciliation, pendingChangeRequest: change, bm02, bm03 } = assignment;
  const conclusion = reconciliation ? CONCLUSION_LABELS[reconciliation.conclusion] : undefined;

  return (
    <>
      <MessageBar intent="info" style={{ marginBottom: 16 }}>
        <MessageBarBody>
          Chỉ đọc: bản chụp hiện trường do nhân viên lấy mẫu ghi nhận. Trường được bảo vệ phải sửa
          qua yêu cầu sửa hồ sơ.
        </MessageBarBody>
      </MessageBar>

      {/* Ghi chú các khối dưới đây viết cho NGƯỜI DÙNG nghiệp vụ: nói cái họ thấy được trên màn
          hình. Lý do kỹ thuật (endpoint chưa trả trường đó) nằm ở chú thích đầu file. */}
      <Section
        title="1. Phân công lấy mẫu"
        note="Hệ thống chưa hiển thị được tên nhân viên lấy mẫu, người phân công và thời điểm phân công."
      >
        <FieldGrid
          items={[
            ["Mã lượt lấy mẫu", assignment.assignmentCode],
            ["Địa điểm", text(assignment.location)],
            ["Giờ dự kiến", text(assignment.scheduledTime)],
            [
              "Số mẫu dự kiến",
              assignment.expectedQuantity == null
                ? BLANK
                : `${assignment.expectedQuantity}${
                    assignment.quantityUnit ? ` ${assignment.quantityUnit}` : ""
                  }`,
            ],
            [
              "Chỉ tiêu",
              assignment.testParameters.map((p) => p.name || p.code).join(", ") || BLANK,
            ],
          ]}
        />
      </Section>

      <Section
        title="2. Đối soát hiện trường — 7 trường truy xuất"
        actions={
          conclusion ? (
            <Badge appearance="tint" color={toneToColor(conclusion.tone)}>
              {conclusion.text}
            </Badge>
          ) : (
            <Badge appearance="tint" color="informative">
              Chưa đối soát
            </Badge>
          )
        }
        note={
          reconciliation?.reason
            ? `Lý do: ${reconciliation.reason}`
            : "Hệ thống chưa hiển thị được người thực hiện đối soát và thời điểm đối soát."
        }
      >
        <ReconciliationTable declaration={assignment.declaration} reconciliation={reconciliation} />
      </Section>

      {/* Máy chủ chỉ trả đề nghị đang CHỜ DUYỆT (`findPendingByAssignmentId`), nên khối này vắng
          mặt khi không có đề nghị nào treo — kể cả khi trước đó đã có đề nghị được duyệt hoặc từ
          chối. Nói rõ phạm vi ngay trên khối, đừng để người đọc hiểu là «chưa từng có đề nghị». */}
      {change ? (
        <Section
          title="3. Đề nghị sửa thông tin hiện trường"
          actions={
            <Badge appearance="tint" color={toneToColor(change.status.tone)}>
              {change.status.name}
            </Badge>
          }
          note="Chỉ hiện đề nghị đang chờ duyệt; đề nghị đã duyệt hoặc bị từ chối xem ở tab Lịch sử."
        >
          <ChangeRequestTable change={change} />
        </Section>
      ) : null}

      {bm02 ? (
        <>
          <Section title="4. BM02 — phần I">
            <FieldGrid
              items={[
                ["Mã biểu mẫu", bm02.formCode],
                ["Revision", bm02.formRevision],
                ["Ngày hiệu lực", text(bm02.formEffectiveDate)],
                ["Trạng thái", bm02.status.name],
                ["Kết luận phù hợp", conclusion?.text ?? BLANK],
              ]}
            />
          </Section>

          <Section
            title="5. BM02 — bảng dòng mẫu"
            note="Hệ thống chưa hiển thị được mã vùng trồng, mã CSĐG, mã container, biển số, số rơ-moóc và phương pháp lấy mẫu của từng dòng."
          >
            <Scroller>
              <table className="dlp-datagrid" style={{ minWidth: 620 }}>
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>#</th>
                    <th>Tên mẫu</th>
                    <th>Khối lượng / số lượng</th>
                    <th>Chỉ tiêu</th>
                  </tr>
                </thead>
                <tbody>
                  {bm02.sampleLines.map((line) => (
                    <tr key={line.index}>
                      <td className="dlp-num">{line.index}</td>
                      <td style={{ fontWeight: 600 }}>{text(line.sampleName)}</td>
                      <td className="dlp-num">
                        {line.quantity}
                        {line.quantityUnit ? ` ${line.quantityUnit}` : ""}
                      </td>
                      <td>{line.parameterCodes.join(", ") || BLANK}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </Section>
        </>
      ) : (
        <Section title="4–5. BM02">
          <div style={{ color: "var(--foreground-secondary)" }}>
            Chưa lập BM02 cho lượt lấy mẫu này.
          </div>
        </Section>
      )}

      <Section
        title="6. BM02 — ký và thời gian"
        note="Chữ ký được tải xuống theo quy định tài liệu của hệ thống."
      >
        {bm02 ? (
          <>
            <FieldGrid
              items={[
                ["Bắt đầu", formatDate(bm02.startedAt)],
                ["Hoàn tất", formatDate(bm02.finishedAt)],
                ["Đại diện khách hàng", text(bm02.customerSignerName)],
              ]}
            />
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <EvidenceList
                items={[
                  { id: bm02.samplerSignatureDocumentId, label: "Chữ ký giám định viên" },
                  { id: bm02.customerSignatureDocumentId, label: "Chữ ký khách hàng" },
                ]}
              />
            </div>
          </>
        ) : (
          <div style={{ color: "var(--foreground-secondary)" }}>Chưa lập BM02.</div>
        )}
      </Section>

      {bm03 ? (
        <Section
          title="7. BM03 — nhãn/tem"
          note="Chữ ký và ảnh tem tải xuống theo quy định tài liệu của hệ thống. Ba tiêu chí nguyên vẹn khi bàn giao và khi tiếp nhận (D14) nằm ở checklist tiếp nhận."
      >
          <FieldGrid
            items={[
              ["Mã biểu mẫu", bm03.formCode],
              ["Revision", bm03.formRevision],
              ["Ngày hiệu lực", text(bm03.formEffectiveDate)],
              ["Trạng thái", bm03.status.name],
            ]}
          />
          <div style={{ marginTop: 12 }}>
            <Scroller>
              <table className="dlp-datagrid" style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>#</th>
                    <th>Chỉ tiêu</th>
                    <th>Số lượng</th>
                    <th style={{ width: 120 }}>Mẫu lưu</th>
                  </tr>
                </thead>
                <tbody>
                  {bm03.sampleLines.map((line) => (
                    <tr key={line.index}>
                      <td className="dlp-num">{line.index}</td>
                      <td>{text(line.parameterCode)}</td>
                      <td className="dlp-num">
                        {line.quantity}
                        {line.quantityUnit ? ` ${line.quantityUnit}` : ""}
                      </td>
                      <td>{line.retained ? "Có" : "Không"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </div>
          <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
            <EvidenceList
              items={[
                { id: bm03.samplerSignatureDocumentId, label: "Chữ ký giám định viên" },
                ...bm03.sealPhotoDocumentIds.map((id, index) => ({
                  id,
                  label: `Ảnh tem niêm phong ${index + 1}`,
                })),
              ]}
            />
          </div>
        </Section>
      ) : (
        <Section title="7. BM03 — nhãn/tem">
          <div style={{ color: "var(--foreground-secondary)" }}>
            Chưa lập BM03 cho lượt lấy mẫu này.
          </div>
        </Section>
      )}

      <Section
        title="8. File đính kèm"
        note="Tệp tải xuống để xem theo quy định tài liệu của hệ thống. Ảnh tem BM03 nằm ở mục 7."
      >
        <EvidenceList
          items={
            bm02?.scenePhotoDocumentIds.map((id, index) => ({
              id,
              label: `Ảnh hiện trường ${index + 1}`,
            })) ?? []
          }
        />
      </Section>
    </>
  );
}
