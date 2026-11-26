import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { FileDropField, PageHead, useDlpToast } from "@/components/lims/common";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import { toneToColor } from "@/lib/admin/tone";
import { useAuth } from "@/lib/auth/AuthProvider";
import { resolveNavAccess } from "@/lib/auth/nav-access";
import { PERM } from "@/lib/admin/rbac";
import { searchString } from "@/lib/route-search";
import {
  FIX_DONE_A,
  FIX_DONE_B,
  FIX_GROUPS,
  FIX_GUARD,
  FIX_MODE_A,
  FIX_MODE_B,
  FIX_RECORD,
  FIX_TIMELINE,
  hasAnyChange,
  touchesGroupB,
} from "@/lib/admin/fix-record-data";
import { RemoteEditRequestPage } from "@/features/request/ui/remote-edit-request-page";

interface Search {
  code?: string;
}
export const Route = createFileRoute("/_app/sua-ho-so")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    code: searchString(search["code"]),
  }),
  head: () => ({
    meta: [
      { title: "Sửa hồ sơ trước phát hành - DLP LIMS" },
      {
        name: "description",
        content:
          "Sửa hồ sơ chưa phát hành theo ba nhóm trường A / B / C, bắt buộc lý do và file bằng chứng, ghi audit giá trị cũ → mới.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FixRecordScreen,
});

function FixRecordScreen() {
  const { can, usesClerk } = useAuth();
  const navigate = useNavigate();
  // Qua router chứ không phải `window.location.search`: SSR đọc được `""` rồi client đọc ra giá
  // trị thật (lệch hydrate), và điều hướng client-side đổi query cũng không làm component đọc lại.
  const { code } = Route.useSearch();
  if (!resolveNavAccess(can, usesClerk).requestEdit) {
    return <NoAccess screen="Sửa hồ sơ" />;
  }
  if (!usesClerk) return <DemoFixRecordScreen />;
  // Vào từ menu chính thì không có hồ sơ nào để sửa - dẫn về danh sách thay vì báo lỗi kỹ thuật.
  if (!code)
    return (
      <>
        <PageHead
          crumbs={[{ label: "Hồ sơ", to: "/ho-so" }, { label: "Sửa hồ sơ" }]}
          title="Sửa hồ sơ trước phát hành"
          description="Chọn hồ sơ cần sửa từ danh sách hồ sơ"
        />
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Chưa chọn hồ sơ:</MessageBarTitle> Mở danh sách hồ sơ và vào «Sửa» ở hồ
            sơ cần chỉnh.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void navigate({ to: "/ho-so" })}>
              Mở danh sách hồ sơ
            </Button>
          </MessageBarActions>
        </MessageBar>
      </>
    );
  return <RemoteEditRequestPage code={code} />;
}

function DemoFixRecordScreen() {
  const { can } = useAuth();
  const toast = useDlpToast();

  const [vals, setVals] = useState<Record<string, string>>({});
  const [why, setWhy] = useState("");
  const [proof, setProof] = useState<string>();
  const [done, setDone] = useState<"A" | "B" | null>(null);

  const groupB = useMemo(() => touchesGroupB(vals), [vals]);
  const changed = useMemo(() => hasAnyChange(vals), [vals]);

  if (!can(PERM.REQUEST_READ)) return <NoAccess screen="Sửa hồ sơ" />;

  const canWrite = can(PERM.REQUEST_PATCH_GROUP_A);
  const mode = groupB ? FIX_MODE_B : FIX_MODE_A;
  const doneMsg = done === "B" ? FIX_DONE_B : FIX_DONE_A;
  const cannotSubmit = !canWrite || !changed || !why.trim() || !proof;

  const set = (key: string, v: string) => {
    setVals((p) => ({ ...p, [key]: v }));
    setDone(null);
  };

  const submit = () => {
    const kind = groupB ? "B" : "A";
    setDone(kind);
    toast(
      `Hồ sơ ${FIX_RECORD.code} · đã ghi nhận lần sửa`,
      "Nhật ký lưu người sửa, giá trị cũ và mới, lý do cùng file bằng chứng.",
      kind === "B" ? "warning" : "success",
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1300, minWidth: 0 }}>
      <PageHead
        crumbs={[
          { label: "Hồ sơ kiểm nghiệm", to: "/ho-so" },
          { label: FIX_RECORD.code },
          { label: "Sửa hồ sơ" },
        ]}
        title={`Sửa hồ sơ ${FIX_RECORD.code} - chưa phát hành`}
        description={`Trạng thái «${FIX_RECORD.state}» · phiếu ${FIX_RECORD.cert} chưa phát hành. Các trường được chia theo nhóm quyền chỉnh sửa.`}
      />

      <MessageBar intent={mode.tone}>
        <MessageBarBody>
          <MessageBarTitle>{mode.title}</MessageBarTitle>
          {mode.body}
        </MessageBarBody>
      </MessageBar>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          style={{
            flex: "2 1 620px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          }}
        >
          {FIX_GROUPS.map((g) => (
            <div key={g.key} style={{ ...card, gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={sectionTitle}>{g.title}</span>
                <Badge appearance="tint" color={toneToColor(g.tone)} size="small">
                  {g.badge}
                </Badge>
              </div>
              <span style={hintText}>{g.note}</span>

              {g.key === "C" ? (
                <div
                  className="dlp-labelgrid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "230px 1fr",
                    gap: "8px 16px",
                    font: "14px/20px var(--font-family-base)",
                  }}
                >
                  {g.fields.map((f) => (
                    <Fragment key={f.key}>
                      <span style={{ color: "var(--foreground-secondary)" }}>{f.label}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{f.old}</span>
                    </Fragment>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))",
                    gap: 12,
                  }}
                >
                  {g.fields.map((f) => (
                    <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ font: "600 12px/16px var(--font-family-base)" }}>
                        {f.label}
                      </span>
                      <span style={{ ...hintText, textDecoration: "line-through" }}>{f.old}</span>
                      <Input
                        size="small"
                        disabled={!canWrite}
                        value={vals[f.key] ?? ""}
                        onChange={(_, d) => set(f.key, d.value)}
                        placeholder="Giá trị mới - để trống nếu không sửa"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div
            style={{
              background: "var(--background-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-surface)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-subtle)",
                ...sectionTitle,
              }}
            >
              Lịch sử sửa hồ sơ
            </div>
            {FIX_TIMELINE.map((h) => (
              <div
                key={h.what}
                className="dlp-rowgrid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1fr) 170px 130px",
                  gap: 12,
                  alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: "14px/20px var(--font-family-base)" }}>{h.what}</div>
                  <div style={hintText}>{h.who}</div>
                </div>
                <Badge appearance="tint" color={toneToColor(h.tone)} size="small">
                  {h.state}
                </Badge>
                <span
                  style={{ ...hintText, fontVariantNumeric: "tabular-nums", textAlign: "right" }}
                >
                  {h.at}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            flex: "1 1 320px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          }}
        >
          <div style={{ ...card, gap: 12 }}>
            <div style={sectionTitle}>Lý do và bằng chứng</div>
            <Field label="Lý do sửa - bắt buộc">
              <Textarea
                rows={3}
                disabled={!canWrite}
                value={why}
                onChange={(_, d) => {
                  setWhy(d.value);
                  setDone(null);
                }}
                placeholder="Ví dụ: khách gửi email đề nghị đổi người nhận kết quả ngày 03/08"
              />
            </Field>
            <Field label="Bằng chứng bắt buộc">
              <FileDropField
                accept=".pdf,image/jpeg,image/png"
                compact
                disabled={!canWrite}
                idle="Đính kèm email hoặc văn bản đề nghị của khách (JPEG · PNG · PDF)"
                selected={proof ? `Đã đính kèm ${proof}` : undefined}
                buttonLabel={proof ? "Chọn tệp khác" : "Chọn tệp"}
                onFile={(file) => {
                  setProof(file.name);
                  setDone(null);
                }}
              />
            </Field>
            <Button appearance="primary" disabled={cannotSubmit} onClick={submit}>
              {groupB ? "Gửi yêu cầu sửa" : "Lưu thay đổi"}
            </Button>
            <span style={hintText}>{FIX_GUARD}</span>
          </div>

          {done ? (
            <MessageBar intent={doneMsg.tone}>
              <MessageBarBody>
                <MessageBarTitle>{doneMsg.title}</MessageBarTitle>
                {doneMsg.body}
              </MessageBarBody>
            </MessageBar>
          ) : null}
        </div>
      </div>
    </div>
  );
}
