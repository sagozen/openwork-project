/* S-05 · Ứng dụng lấy mẫu hiện trường (chỉ mobile) - UF-05, bản minh hoạ không nối API.
   Bố cục và thứ tự thao tác bám đúng bản chạy thật (`ConnectedFieldSamplingApp`): danh sách phiếu
   → lượt của tôi → mở lượt → đối soát bảy trường BM01 → BM03 → BM02 → hoàn tất, cùng mặt làm việc
   "Duyệt thay đổi" của quản lý một cửa. Chỉ khác nguồn dữ liệu: ở đây trạng thái nằm trong state
   của React thay vì do máy chủ trả về, nên khách xem demo bấm được trọn luồng mà không cần backend. */
import { useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Label,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import { ArrowLeft20Regular } from "@fluentui/react-icons";
import { AppLogo, FieldLabel, useDlpToast } from "@/components/lims/common";
import { FieldUserMenu } from "@/components/lims/field/FieldUserMenu";
import {
  BM01_EXPECTED_QUANTITY,
  BM03_CRIT,
  BM03_GEO,
  BM03_ROWS,
  FIELD_CHANGE_REQUESTS,
  FIELD_PUSH,
  FIELD_TURNS,
  MOBILE_RECORDS,
  MOBILE_TAGS,
  RECON_ROWS,
  SYNC_QUEUE,
  type ChangeRequestField,
  type ReconField,
} from "@/lib/admin/sampling-data";
import { SignaturePad } from "./SignaturePad";
import { FieldSurfaceNav } from "./FieldSurfaceNav";
import { FilePicker } from "./FilePicker";
import { card, cardTitle, secondary } from "./field-styles";

/* Trạng thái của một lượt lấy mẫu, đặt tên theo đúng vòng đời máy chủ dùng ở bản thật. Mỗi khối
   trên màn chỉ hiện ở trạng thái cho phép thao tác đó - giống hệt cách bản thật đọc
   `allowedActions`. */
type TurnStatus =
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "PENDING_CHANGE"
  | "RECONCILED"
  | "SAMPLED"
  | "COMPLETED"
  | "REJECTED";

const STATUS_TEXT: Record<TurnStatus, { label: string; tone: "info" | "warning" | "success" }> = {
  ASSIGNED: { label: "Đã phân công", tone: "warning" },
  IN_PROGRESS: { label: "Đang lấy mẫu", tone: "info" },
  PENDING_CHANGE: { label: "Chờ duyệt thay đổi", tone: "warning" },
  RECONCILED: { label: "Đã đối soát", tone: "info" },
  SAMPLED: { label: "Đã lập BM03", tone: "info" },
  COMPLETED: { label: "Đã hoàn tất BM02", tone: "success" },
  REJECTED: { label: "Kết luận không phù hợp", tone: "warning" },
};

type Verdict = "MATCH" | "MISMATCH";
type Decision = "APPROVE" | "REJECT";

type Step = "records" | "turns" | "assignment";

const CRIT_KEYS = ["representative", "sealedOnSite", "preserved"] as const;
type CritKey = (typeof CRIT_KEYS)[number];

export function FieldSamplingApp({ canManage = true }: { canManage?: boolean }) {
  const toast = useDlpToast();

  const [surface, setSurface] = useState<"field" | "manager">("field");
  const [step, setStep] = useState<Step>("records");
  const [activeTurn, setActiveTurn] = useState("26100012");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  const [push, setPush] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  /* Lượt đang mở */
  const [status, setStatus] = useState<TurnStatus>("ASSIGNED");
  const [openedAt, setOpenedAt] = useState<string>();
  const [declared, setDeclared] = useState<Record<ReconField, string | null>>(
    () =>
      Object.fromEntries(RECON_ROWS.map((r) => [r.field, r.declared])) as Record<
        ReconField,
        string | null
      >,
  );
  const [actual, setActual] = useState<Record<ReconField, string>>(
    () =>
      Object.fromEntries(RECON_ROWS.map((r) => [r.field, r.actual])) as Record<ReconField, string>,
  );
  const [verdicts, setVerdicts] = useState<Partial<Record<ReconField, Verdict>>>({});
  const [reason, setReason] = useState("");
  const [evidenceCount, setEvidenceCount] = useState(0);

  /* BM03 */
  const [criteria, setCriteria] = useState<Record<CritKey, boolean>>({
    representative: false,
    sealedOnSite: false,
    preserved: false,
  });
  const [quantity, setQuantity] = useState("");
  const [quantityUnit, setQuantityUnit] = useState("");
  const [sealPhotoCount, setSealPhotoCount] = useState(0);
  const [bm03Signed, setBm03Signed] = useState(false);

  /* BM02 */
  const [customerName, setCustomerName] = useState("");
  const [bm02Signed, setBm02Signed] = useState(false);
  const [customerSigned, setCustomerSigned] = useState(false);

  /* Đồng bộ ngoại tuyến - phần kể chuyện riêng của bản minh hoạ. */
  const [online, setOnline] = useState(false);
  const [synced, setSynced] = useState(false);

  /* Hàng chờ của quản lý */
  const [requests, setRequests] = useState(FIELD_CHANGE_REQUESTS);
  const [decisions, setDecisions] = useState<Record<string, Record<string, Decision>>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, Record<string, string>>>({});
  const [rejectAllReason, setRejectAllReason] = useState<Record<string, string>>({});

  const rows = RECON_ROWS.map((r) => ({
    ...r,
    declared: declared[r.field],
    actual: actual[r.field] ?? "",
    verdict: verdicts[r.field],
  }));
  const judged = rows.filter((r) => r.verdict).length;
  const mismatched = rows.filter((r) => r.verdict === "MISMATCH");
  const allJudged = judged === RECON_ROWS.length;
  const critOk = CRIT_KEYS.every((k) => criteria[k]);
  const quantityOk = Number(quantity.trim()) > 0;

  const visibleRecords = useMemo(
    () =>
      pickedTags.length === 0
        ? MOBILE_RECORDS
        : MOBILE_RECORDS.filter((r) => r.tags.some((t) => pickedTags.includes(t))),
    [pickedTags],
  );

  const title = useMemo(() => {
    if (surface === "manager") return "Duyệt thay đổi";
    if (step === "records") return "Phiếu kiểm nghiệm";
    if (step === "turns") return "Lượt của tôi";
    return `Lượt ${activeTurn}`;
  }, [surface, step, activeTurn]);

  function go(next: Step) {
    setStep(next);
    scroller.current?.scrollTo({ top: 0 });
  }

  function openTurn(code: string) {
    setActiveTurn(code);
    go("assignment");
  }

  /** Đặt lại toàn bộ trạng thái của lượt - dùng khi mở một lượt khác từ danh sách. */
  function resetTurn() {
    setStatus("ASSIGNED");
    setOpenedAt(undefined);
    setVerdicts({});
    setReason("");
    setEvidenceCount(0);
    setCriteria({ representative: false, sealedOnSite: false, preserved: false });
    setQuantity("");
    setQuantityUnit("");
    setSealPhotoCount(0);
    setBm03Signed(false);
    setCustomerName("");
    setBm02Signed(false);
    setCustomerSigned(false);
  }

  const openTurnAction = () => {
    setOpenedAt(new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }));
    setStatus("IN_PROGRESS");
    toast("Đã mở lượt", BM03_GEO);
  };

  const reconcile = () => {
    setStatus("RECONCILED");
    toast("Đã gửi kết quả đối soát", "Bảy trường khớp khai báo · chuyển sang lập BM03");
    scroller.current?.scrollTo({ top: 0 });
  };

  const requestChange = () => {
    setStatus("PENDING_CHANGE");
    setRequests((list) => [
      {
        id: "cr-demo",
        assignmentCode: activeTurn,
        requestedBy: "Nguyễn Văn C",
        requestedAt: new Date().toLocaleString("vi-VN"),
        reason: reason.trim(),
        fields: mismatched.map((r) => ({
          field: r.field,
          label: r.label,
          oldValue: r.declared ?? "hồ sơ không khai",
          newValue: r.actual,
        })),
      },
      ...list.filter((item) => item.id !== "cr-demo"),
    ]);
    toast(
      "Đã gửi đề nghị; lượt đang chờ quản lý duyệt",
      `${mismatched.length} trường lệch · quản lý một cửa duyệt theo từng trường`,
    );
    scroller.current?.scrollTo({ top: 0 });
  };

  const rejectSampling = () => {
    setStatus("REJECTED");
    toast(
      "Đã ghi nhận kết luận không phù hợp",
      "Lượt lấy mẫu dừng lại, quản lý một cửa nhận thông báo ngay.",
      "warning",
    );
  };

  const submitBm03 = () => {
    setStatus("SAMPLED");
    toast("Đã lập BM03", `${quantity} ${quantityUnit} · ${sealPhotoCount} ảnh tem`);
    scroller.current?.scrollTo({ top: 0 });
  };

  const submitBm02 = () => {
    setStatus("COMPLETED");
    toast("Đã ký và hoàn tất BM02", "Biên bản lưu trên máy · chờ đồng bộ lên hệ thống");
    scroller.current?.scrollTo({ top: 0 });
  };

  /** Quyết định hiện hành của một đề nghị; mặc định duyệt hết, đúng như bản thật. */
  const decisionOf = (requestId: string, field: string): Decision =>
    decisions[requestId]?.[field] ?? "APPROVE";

  const setDecision = (requestId: string, field: string, decision: Decision) =>
    setDecisions((all) => ({ ...all, [requestId]: { ...all[requestId], [field]: decision } }));

  const rejectReasonOf = (requestId: string, field: string) =>
    rejectReasons[requestId]?.[field] ?? "";

  const applyDecisions = (requestId: string, fields: ChangeRequestField[]) => {
    // Trường được duyệt mới ghi đè khai báo gốc - trường bị từ chối giữ nguyên giá trị BM01, đúng
    // như quy tắc "không ghi đè cho tới khi duyệt" của bản thật.
    setDeclared((current) => {
      const next = { ...current };
      for (const f of fields) {
        if (decisionOf(requestId, f.field) === "APPROVE") next[f.field] = f.newValue;
      }
      return next;
    });
    setRequests((list) => list.filter((item) => item.id !== requestId));
    if (requestId === "cr-demo") {
      // Lượt bị khoá được mở lại, nhưng phải đối soát lại từ đầu.
      setStatus("IN_PROGRESS");
      setVerdicts({});
    }
    toast("Đã xử lý đề nghị theo từng trường", `Lượt ${activeTurn} có thể đối soát lại`);
  };

  const rejectWholeRequest = (requestId: string) => {
    setRequests((list) => list.filter((item) => item.id !== requestId));
    if (requestId === "cr-demo") setStatus("IN_PROGRESS");
    toast("Đã từ chối toàn bộ đề nghị", "Khai báo gốc trên BM01 được giữ nguyên", "warning");
  };

  const pending = status === "PENDING_CHANGE";

  return (
    <div className="dlp-field">
      <header className="dlp-field__bar">
        {surface === "field" && step !== "records" ? (
          <button
            type="button"
            className="dlp-field__back"
            aria-label="Quay lại"
            onClick={() => go(step === "assignment" ? "turns" : "records")}
          >
            <ArrowLeft20Regular />
          </button>
        ) : null}
        <AppLogo size={24} variant="on-accent" />
        <span className="dlp-field__title">{title}</span>
        <span style={{ flex: 1 }} />
        {surface === "field" && step === "records" ? (
          <span className="dlp-field__meta">{visibleRecords.length} phiếu</span>
        ) : null}
        {surface === "field" && step === "turns" ? (
          <span className="dlp-field__meta">02/08 · {FIELD_TURNS.length} lượt</span>
        ) : null}
        {surface === "field" && step === "assignment" && openedAt ? (
          <span className="dlp-field__meta">{openedAt}</span>
        ) : null}
        {surface === "manager" ? (
          <span className="dlp-field__meta">{requests.length} đề nghị</span>
        ) : null}
        <FieldUserMenu />
      </header>

      {surface === "field" && step === "records" ? (
        <div className="dlp-field__filterbar">
          <Button size="large" style={{ flex: 1 }} onClick={() => setSheetOpen(true)}>
            {pickedTags.length ? `Nhãn · ${pickedTags.length}` : "Nhãn"}
          </Button>
          <Button size="large" style={{ flex: 1 }} onClick={() => setSheetOpen(true)}>
            Bộ lọc
          </Button>
        </div>
      ) : null}

      {/* Chừa chỗ cho thanh tab cố định ở đáy, giống bản nối API. */}
      <div className="dlp-field__body" ref={scroller} style={{ paddingBottom: 80 }}>
        {surface === "manager" ? (
          <ManagerQueue
            requests={requests}
            decisionOf={decisionOf}
            setDecision={setDecision}
            rejectReasonOf={rejectReasonOf}
            setRejectReason={(requestId, field, value) =>
              setRejectReasons((all) => ({
                ...all,
                [requestId]: { ...all[requestId], [field]: value },
              }))
            }
            rejectAllReason={rejectAllReason}
            setRejectAllReason={(requestId, value) =>
              setRejectAllReason((all) => ({ ...all, [requestId]: value }))
            }
            onApply={applyDecisions}
            onRejectAll={rejectWholeRequest}
          />
        ) : null}

        {surface === "field" && step === "records" ? (
          <>
            {visibleRecords.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  resetTurn();
                  openTurn(m.id.slice(0, 8));
                }}
                style={{ ...card, textAlign: "left", cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span
                    style={{
                      font: "600 16px/22px var(--font-family-base)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {m.id}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={secondary}>{m.han}</span>
                </div>
                <div style={{ font: "14px/20px var(--font-family-base)" }}>{m.sp}</div>
                <div style={secondary}>{m.kh}</div>
                <div>
                  <Badge
                    appearance="tint"
                    size="small"
                    color={
                      m.tone === "success"
                        ? "success"
                        : m.tone === "warning"
                          ? "warning"
                          : "informative"
                    }
                  >
                    {m.state}
                  </Badge>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {m.tags.slice(0, 2).map((t) => (
                    <Badge
                      key={t}
                      appearance="tint"
                      size="small"
                      color={MOBILE_TAGS.find((x) => x.name === t)?.color ?? "brand"}
                    >
                      {t}
                    </Badge>
                  ))}
                  {m.tags.length > 2 ? (
                    <Badge appearance="outline" color="subtle" size="small">
                      +{m.tags.length - 2}
                    </Badge>
                  ) : null}
                </div>
              </button>
            ))}

            {sheetOpen ? (
              <div className="dlp-field__sheet-scrim" onClick={() => setSheetOpen(false)}>
                <div className="dlp-field__sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="dlp-field__sheet-grip" />
                  <div style={{ font: "600 16px/22px var(--font-family-base)" }}>Lọc theo nhãn</div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      maxHeight: 220,
                      overflow: "auto",
                    }}
                  >
                    {MOBILE_TAGS.map((t) => (
                      <label
                        key={t.name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          minHeight: 44,
                          padding: "0 4px",
                        }}
                      >
                        <Checkbox
                          checked={pickedTags.includes(t.name)}
                          onChange={(_, d) =>
                            setPickedTags((prev) =>
                              d.checked ? [...prev, t.name] : prev.filter((x) => x !== t.name),
                            )
                          }
                        />
                        <Badge appearance="tint" color={t.color} size="small">
                          {t.name}
                        </Badge>
                        <span style={{ flex: 1 }} />
                        <span style={{ ...secondary, fontVariantNumeric: "tabular-nums" }}>
                          {t.count}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button size="large" style={{ flex: 1 }} onClick={() => setPickedTags([])}>
                      Bỏ chọn
                    </Button>
                    <Button
                      size="large"
                      appearance="primary"
                      style={{ flex: 1 }}
                      onClick={() => setSheetOpen(false)}
                    >
                      Áp dụng
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {surface === "field" && step === "turns" ? (
          <>
            {push ? (
              <button type="button" className="dlp-field__push" onClick={() => setPush(false)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Badge appearance="tint" color="brand" size="small">
                    Thông báo
                  </Badge>
                  <span style={{ flex: 1 }} />
                  <span style={{ ...secondary, fontSize: 11 }}>vừa xong</span>
                </div>
                <div style={cardTitle}>{FIELD_PUSH.title}</div>
                <div style={secondary}>{FIELD_PUSH.body}</div>
              </button>
            ) : null}

            {FIELD_TURNS.map((t) => (
              <div key={t.code} style={card}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span
                    style={{
                      font: "600 16px/22px var(--font-family-base)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {t.code}
                  </span>
                  <span style={{ flex: 1 }} />
                  <Badge
                    appearance="tint"
                    color={t.tone === "info" ? "informative" : "warning"}
                    size="small"
                  >
                    {t.code === activeTurn ? STATUS_TEXT[status].label : t.state}
                  </Badge>
                </div>
                <div style={{ font: "14px/20px var(--font-family-base)" }}>{t.title}</div>
                <div style={{ ...secondary, lineHeight: 1.6 }}>
                  {t.place} · {t.time}
                  {t.customer ? (
                    <>
                      <br />
                      {t.customer}
                    </>
                  ) : null}
                </div>
                <Button
                  appearance={t.actionable ? "primary" : "secondary"}
                  size="large"
                  onClick={() => {
                    if (t.code !== activeTurn) resetTurn();
                    openTurn(t.code);
                  }}
                >
                  Mở lượt
                </Button>
              </div>
            ))}
          </>
        ) : null}

        {surface === "field" && step === "assignment" ? (
          <>
            <div style={card}>
              <strong style={cardTitle}>{activeTurn} · Sầu riêng</strong>
              <span style={secondary}>Kho X, KCN Quang Minh · hẹn 08:00</span>
              <span>
                <Badge
                  appearance="tint"
                  size="small"
                  color={
                    STATUS_TEXT[status].tone === "success"
                      ? "success"
                      : STATUS_TEXT[status].tone === "warning"
                        ? "warning"
                        : "informative"
                  }
                >
                  {STATUS_TEXT[status].label}
                </Badge>
              </span>
            </div>

            {pending ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Lượt đang khoá chờ duyệt thay đổi</MessageBarTitle>Đang chờ Quản
                  lý Bộ phận một cửa. Dữ liệu khai báo gốc bên dưới chưa bị ghi đè.
                </MessageBarBody>
              </MessageBar>
            ) : null}

            {status === "ASSIGNED" ? (
              <Button appearance="primary" size="large" onClick={openTurnAction}>
                Mở lượt tại hiện trường
              </Button>
            ) : null}

            {status === "IN_PROGRESS" || pending ? (
              <>
                <div style={card}>
                  <strong style={cardTitle}>
                    Đối soát khai báo gốc · {judged}/{RECON_ROWS.length}
                  </strong>
                  {rows.map((r) => (
                    <div
                      key={r.field}
                      style={{
                        display: "grid",
                        gap: 8,
                        padding: 10,
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-control)",
                        background:
                          r.verdict === "MISMATCH"
                            ? "var(--background-subtle)"
                            : "var(--background-surface)",
                      }}
                    >
                      <Field label={`${r.label} · gốc: ${r.declared ?? "hồ sơ không khai"}`}>
                        <Input
                          size="large"
                          disabled={pending}
                          value={r.actual}
                          onChange={(_, d) => setActual((v) => ({ ...v, [r.field]: d.value }))}
                        />
                      </Field>
                      <div style={{ display: "grid", gap: 8 }}>
                        <Label required>Chọn Khớp hoặc Lệch</Label>
                        <div style={{ display: "flex", gap: 8 }}>
                          <Button
                            size="large"
                            disabled={pending}
                            appearance={r.verdict === "MATCH" ? "primary" : "secondary"}
                            onClick={() => setVerdicts((v) => ({ ...v, [r.field]: "MATCH" }))}
                          >
                            Khớp
                          </Button>
                          <Button
                            size="large"
                            disabled={pending}
                            appearance={r.verdict === "MISMATCH" ? "primary" : "secondary"}
                            onClick={() => setVerdicts((v) => ({ ...v, [r.field]: "MISMATCH" }))}
                          >
                            Lệch
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <Field
                  label="Lý do / ghi chú"
                  required={mismatched.length > 0}
                  hint="Bắt buộc khi có sai lệch hoặc từ chối lấy mẫu."
                >
                  <Textarea
                    disabled={pending}
                    value={reason}
                    placeholder="Ví dụ: khách đổi xe tải sáng nay"
                    onChange={(_, d) => setReason(d.value)}
                  />
                </Field>

                {pending ? null : (
                  <FilePicker
                    label="Ảnh bằng chứng"
                    required={mismatched.length > 0}
                    hint="Bắt buộc khi đề nghị sửa trường lệch hoặc từ chối lấy mẫu."
                    multiple
                    onFiles={(files) => setEvidenceCount(files.length)}
                  />
                )}

                {pending ? null : (
                  <>
                    <Button
                      size="large"
                      disabled={!reason.trim() || evidenceCount === 0}
                      onClick={rejectSampling}
                    >
                      Từ chối lấy mẫu
                    </Button>
                    {mismatched.length ? (
                      <Button
                        appearance="primary"
                        size="large"
                        disabled={!reason.trim() || evidenceCount === 0}
                        onClick={requestChange}
                      >
                        Đề nghị sửa {mismatched.length} trường lệch
                      </Button>
                    ) : (
                      <Button
                        appearance="primary"
                        size="large"
                        disabled={!allJudged}
                        onClick={reconcile}
                      >
                        Gửi kết quả đối soát
                      </Button>
                    )}
                    <span style={secondary}>
                      {allJudged
                        ? mismatched.length
                          ? "Cần trường lệch, lý do và ít nhất một ảnh bằng chứng."
                          : "Bảy trường đã đối soát, có thể gửi kết quả."
                        : "Hãy chọn Khớp hoặc Lệch cho từng trường."}
                    </span>
                  </>
                )}
              </>
            ) : null}

            {status === "RECONCILED" ? (
              <div style={card}>
                <strong style={cardTitle}>Ba tiêu chí bắt buộc</strong>
                {CRIT_KEYS.map((key, i) => (
                  <div key={key} className="dlp-field__crit" data-on={criteria[key]}>
                    <Checkbox
                      required
                      checked={criteria[key]}
                      onChange={(_, d) => setCriteria((v) => ({ ...v, [key]: Boolean(d.checked) }))}
                      label={
                        <span>
                          <span style={{ display: "block" }}>{BM03_CRIT[i]?.label}</span>
                          <span style={{ ...secondary, display: "block" }}>
                            {BM03_CRIT[i]?.note}
                          </span>
                        </span>
                      }
                    />
                  </div>
                ))}

                <strong style={cardTitle}>Lượng mẫu thực lấy</strong>
                <QuantityFields
                  quantity={quantity}
                  quantityUnit={quantityUnit}
                  setQuantity={setQuantity}
                  setQuantityUnit={setQuantityUnit}
                />
                <span style={secondary}>
                  Dòng mẫu của lượt: {BM03_ROWS.map((r) => `${r.code} (${r.ct})`).join(" · ")}
                </span>

                <FilePicker
                  label="Ảnh tem (tối thiểu 2)"
                  required
                  multiple
                  onFiles={(files) => setSealPhotoCount(files.length)}
                />
                <span style={{ ...secondary, fontVariantNumeric: "tabular-nums" }}>{BM03_GEO}</span>

                <SignaturePad
                  label="Xác nhận của người lấy mẫu (ký trên màn)"
                  required
                  onSigned={() => setBm03Signed(true)}
                  onClear={() => setBm03Signed(false)}
                />

                <Button
                  appearance="primary"
                  size="large"
                  disabled={!critOk || !quantityOk || sealPhotoCount < 2 || !bm03Signed}
                  onClick={submitBm03}
                >
                  Chốt BM03
                </Button>
                <span style={secondary}>
                  {critOk && quantityOk && sealPhotoCount >= 2 && bm03Signed
                    ? "Đủ điều kiện chốt BM03."
                    : "Xác nhận 3 tiêu chí, số lượng thực lấy, đơn vị tính, 2 ảnh tem và chữ ký trên màn."}
                </span>
              </div>
            ) : null}

            {status === "SAMPLED" ? (
              <div style={card}>
                <strong style={cardTitle}>BM02 · xác nhận hai bên</strong>
                <QuantityFields
                  quantity={quantity}
                  quantityUnit={quantityUnit}
                  setQuantity={setQuantity}
                  setQuantityUnit={setQuantityUnit}
                  inheritedFrom="BM03"
                />
                <Field label="Tên đại diện khách" required>
                  <Input
                    size="large"
                    value={customerName}
                    onChange={(_, d) => setCustomerName(d.value)}
                  />
                </Field>
                <SignaturePad
                  label="Người lấy mẫu (ký trên màn)"
                  required
                  onSigned={() => setBm02Signed(true)}
                  onClear={() => setBm02Signed(false)}
                />
                <SignaturePad
                  label="Đại diện khách hàng (ký trên màn)"
                  required
                  onSigned={() => setCustomerSigned(true)}
                  onClear={() => setCustomerSigned(false)}
                />
                <small>Chữ ký trên màn là xác nhận nghiệp vụ, không phải chữ ký số pháp lý.</small>
                <Button
                  appearance="primary"
                  size="large"
                  disabled={!customerName.trim() || !bm02Signed || !customerSigned}
                  onClick={submitBm02}
                >
                  Ký và hoàn tất BM02
                </Button>
                <span style={secondary}>
                  Cần số lượng thực lấy, đơn vị tính, chữ ký trên màn của hai bên và tên đại diện
                  khách.
                </span>
              </div>
            ) : null}

            {status === "REJECTED" ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Đã kết luận không phù hợp</MessageBarTitle>
                  Lượt lấy mẫu dừng lại. Quản lý một cửa nhận thông báo để làm việc lại với khách.
                </MessageBarBody>
              </MessageBar>
            ) : null}

            {status === "COMPLETED" ? (
              <>
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Đã hoàn tất lấy mẫu</MessageBarTitle>
                    BM02 và BM03 đã được lưu. Hồ sơ sẵn sàng chuyển sang bước tiếp nhận mẫu.
                  </MessageBarBody>
                </MessageBar>

                <div style={card}>
                  <strong style={cardTitle}>Biên bản đã chốt</strong>
                  <div
                    style={{ ...secondary, lineHeight: 1.8, fontVariantNumeric: "tabular-nums" }}
                  >
                    <div>BM02 ký hai bên · đại diện khách: {customerName}</div>
                    <div>
                      BM03 ba tiêu chí đạt · {quantity} {quantityUnit} · {BM03_ROWS.length} dòng mẫu
                    </div>
                    <div>
                      {sealPhotoCount + evidenceCount} ảnh hiện trường · khai báo gốc đối soát đủ{" "}
                      {RECON_ROWS.length} trường
                    </div>
                  </div>
                </div>

                {/* Câu chuyện ngoại tuyến của bản minh hoạ: biên bản chốt xong nằm trên máy tới khi
                    có sóng. Bản chạy thật gửi thẳng lên máy chủ nên không có khối này. */}
                <MessageBar intent={synced ? "success" : online ? "info" : "warning"}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {synced ? "Đã đồng bộ:" : online ? "Sẵn sàng gửi:" : "Mất sóng:"}
                    </MessageBarTitle>{" "}
                    {synced
                      ? "Toàn bộ biên bản và ảnh đã lên hệ thống. Hồ sơ chuyển trạng thái «Chờ tiếp nhận mẫu»."
                      : online
                        ? "Đã có sóng trở lại. Nhấn đồng bộ để đẩy 4 mục đang chờ lên hệ thống."
                        : "Kho X không có sóng. Biên bản lưu trên máy và tự đẩy lên khi có kết nối."}
                  </MessageBarBody>
                </MessageBar>

                <div style={{ ...card, padding: 0, gap: 0, overflow: "hidden" }}>
                  {SYNC_QUEUE.map((q) => (
                    <div key={q.name} className="dlp-field__row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: "14px/20px var(--font-family-base)" }}>{q.name}</div>
                        <div style={{ ...secondary, fontVariantNumeric: "tabular-nums" }}>
                          {q.meta}
                        </div>
                      </div>
                      <Badge appearance="tint" color={synced ? "success" : "warning"} size="small">
                        {synced
                          ? "Đã gửi"
                          : q.wifiOnly
                            ? "Chờ Wi-Fi"
                            : online
                              ? "Sẵn sàng"
                              : "Chờ sóng"}
                      </Badge>
                    </div>
                  ))}
                </div>

                <Button
                  appearance="primary"
                  size="large"
                  disabled={synced}
                  onClick={() => {
                    if (!online) {
                      setOnline(true);
                      toast(
                        "Đã bắt được sóng",
                        "Nhấn «Đồng bộ ngay» để đẩy 4 mục lên hệ thống",
                        "info",
                      );
                      return;
                    }
                    setSynced(true);
                    toast(`Đã đồng bộ lượt ${activeTurn}`, "4 mục · 18,5 MB đã lên hệ thống");
                  }}
                >
                  {synced ? "Đã đồng bộ xong" : online ? "Đồng bộ ngay" : "Thử kết nối lại"}
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <FieldSurfaceNav
        surface={surface}
        canManage={canManage}
        onSurface={(next) => {
          setSurface(next);
          if (next === "field" && step === "records") go("turns");
          scroller.current?.scrollTo({ top: 0 });
        }}
      />
    </div>
  );
}

/** Số lượng thực lấy + đơn vị tính, dùng chung cho BM03 và BM02 - giống hệt bản nối API: khi BM03
 *  đã chốt thì BM02 chỉ in lại con số kế thừa chứ không cho gõ đè. */
function QuantityFields(p: {
  quantity: string;
  quantityUnit: string;
  setQuantity: (v: string) => void;
  setQuantityUnit: (v: string) => void;
  inheritedFrom?: string;
}) {
  if (p.inheritedFrom) {
    return (
      <>
        <Field
          label={
            <FieldLabel
              label="Số lượng thực lấy"
              tooltip={`Kế thừa từ ${p.inheritedFrom} · sửa ở ${p.inheritedFrom}`}
            />
          }
        >
          <strong>{p.quantity || "-"}</strong>
        </Field>
        <Field label={<FieldLabel label="Đơn vị tính" tooltip={`Kế thừa từ ${p.inheritedFrom}`} />}>
          <strong>{p.quantityUnit || "-"}</strong>
        </Field>
      </>
    );
  }
  return (
    <>
      <Field
        label={
          <FieldLabel
            label="Số lượng thực lấy"
            tooltip={`Áp dụng cho mọi dòng mẫu · hồ sơ khai dự kiến: ${BM01_EXPECTED_QUANTITY}`}
          />
        }
        required
      >
        <Input
          type="number"
          min={1}
          size="large"
          value={p.quantity}
          onChange={(_, d) => p.setQuantity(d.value)}
        />
      </Field>
      <Field label={<FieldLabel label="Đơn vị tính" tooltip="Theo thực tế lấy mẫu" />} required>
        <Input
          size="large"
          value={p.quantityUnit}
          placeholder="Ví dụ: quả, kg, g"
          onChange={(_, d) => p.setQuantityUnit(d.value)}
        />
      </Field>
    </>
  );
}

/** Hàng chờ của quản lý một cửa: mỗi trường lệch được duyệt hoặc từ chối riêng, hoặc từ chối cả
 *  đề nghị kèm lý do - đúng hai lối ra của bản chạy thật. */
function ManagerQueue({
  requests,
  decisionOf,
  setDecision,
  rejectReasonOf,
  setRejectReason,
  rejectAllReason,
  setRejectAllReason,
  onApply,
  onRejectAll,
}: {
  requests: typeof FIELD_CHANGE_REQUESTS;
  decisionOf: (requestId: string, field: string) => Decision;
  setDecision: (requestId: string, field: string, decision: Decision) => void;
  rejectReasonOf: (requestId: string, field: string) => string;
  setRejectReason: (requestId: string, field: string, value: string) => void;
  rejectAllReason: Record<string, string>;
  setRejectAllReason: (requestId: string, value: string) => void;
  onApply: (requestId: string, fields: ChangeRequestField[]) => void;
  onRejectAll: (requestId: string) => void;
}) {
  return (
    <>
      {requests.map((item) => {
        const blocked = item.fields.some(
          (f) =>
            decisionOf(item.id, f.field) === "REJECT" && !rejectReasonOf(item.id, f.field).trim(),
        );
        return (
          <div key={item.id} style={card}>
            <strong style={cardTitle}>
              Lượt {item.assignmentCode} · {item.requestedBy}
            </strong>
            <span style={secondary}>{item.requestedAt}</span>
            <span>{item.reason}</span>
            {item.fields.map((f) => {
              const decision = decisionOf(item.id, f.field);
              return (
                <div key={f.field} style={card}>
                  <span>
                    {f.label}: <b>{f.oldValue}</b> → <b>{f.newValue}</b>
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button
                      size="large"
                      appearance={decision === "APPROVE" ? "primary" : "secondary"}
                      onClick={() => setDecision(item.id, f.field, "APPROVE")}
                    >
                      Duyệt
                    </Button>
                    <Button
                      size="large"
                      appearance={decision === "REJECT" ? "primary" : "secondary"}
                      onClick={() => setDecision(item.id, f.field, "REJECT")}
                    >
                      Từ chối trường
                    </Button>
                  </div>
                  {decision === "REJECT" ? (
                    <Input
                      size="large"
                      placeholder="Lý do từ chối trường"
                      value={rejectReasonOf(item.id, f.field)}
                      onChange={(_, d) => setRejectReason(item.id, f.field, d.value)}
                    />
                  ) : null}
                </div>
              );
            })}
            <Button
              appearance="primary"
              size="large"
              disabled={blocked}
              onClick={() => onApply(item.id, item.fields)}
            >
              Lưu quyết định từng trường
            </Button>
            <Field label="Hoặc từ chối toàn bộ">
              <Input
                size="large"
                value={rejectAllReason[item.id] ?? ""}
                onChange={(_, d) => setRejectAllReason(item.id, d.value)}
              />
            </Field>
            <Button
              size="large"
              disabled={!rejectAllReason[item.id]?.trim()}
              onClick={() => onRejectAll(item.id)}
            >
              Từ chối toàn bộ
            </Button>
          </div>
        );
      })}
      {requests.length === 0 ? <div style={card}>Không có đề nghị đang chờ duyệt.</div> : null}
    </>
  );
}
