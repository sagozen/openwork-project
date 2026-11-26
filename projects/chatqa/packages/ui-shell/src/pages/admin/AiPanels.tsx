import { useEffect, useState } from 'react';
import { ChevronDown, Eye, EyeOff, Pencil, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Toggle } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { NetProgress } from '../../components/NetProgress';
import { platform } from '../../platform';
import { writeOnline } from './admin-error';
import { aiState, budgetPercent, ceilingVnd, hasRulesCeiling, maskedKey, modelLabel, monthNumber, parseCeilingPercent, PROVIDER_LABEL, usageLine, usd, vnd, type AiModelKey, type AiProviderKey, type AiSettings } from './ai-format';
import { fmtDate } from './format';
import { Dropdown, ErrorBanner } from './parts';
import { useResource } from './use-resource';
import { PRODUCT } from '@product/product';
import { IS_HSDESK } from '../../lib/catalog';
import { useAction } from '../../lib/use-action';

const TONE = { green: 'bg-green-soft text-green', amber: 'bg-amber-soft text-amber', red: 'bg-red-soft text-red' } as const;
const Box = 'stroke-in flex h-[36px] w-full items-center gap-[8px] rounded-[8px] px-[12px]';

function Label({ children }: { children: string }) {
  return <span className="text-[10px] font-semibold whitespace-nowrap text-text-3">{children}</span>;
}

/** Thẻ Dịch vụ AI (cột phải khung D7XS6): mô hình, khoá API, chi phí tháng. Lưu qua PUT /v1/ai/settings (cần mạng, quyền admin.ai_budget). */
export function AiServicePanel({ className }: { className?: string }) {
  const res = useResource(() => platform.api<AiSettings>(`/v1/ai/settings?product=${PRODUCT.code}`));
  const [saveError, setSaveError] = useState<unknown>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editBudget, setEditBudget] = useState<string | null>(null);
  const s = res.data;

  // Mọi lần lưu (nhà cung cấp, mô hình, khoá, ngân sách, trần quy tắc) dùng chung một cờ: đang lưu thì bỏ qua lần bấm / Enter tiếp.
  const [put, saving] = useAction(async (body: Record<string, unknown>) => {
    setSaveError(null);
    try {
      await writeOnline(() => platform.api(`/v1/ai/settings?product=${PRODUCT.code}`, { method: 'PUT', body }));
      await res.reload();
    } catch (e) {
      setSaveError(e);
    }
  });

  const st = s ? aiState(s) : null;
  return (
    <div className={cx('w-[360px] shrink-0 self-stretch rounded-[14px] bg-gradient-to-r from-ai to-ai-2 p-[2px] shadow-ai-card', className)}>
      <div className="flex h-full flex-col gap-[14px] rounded-[12px] bg-surface p-[20px] leading-[normal]">
        <div className="flex w-full items-center gap-[10px]">
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-r from-ai to-ai-2 text-white">
            <Sparkles size={17} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[15px] font-bold whitespace-nowrap text-text">Dịch vụ AI</span>
            <span className="truncate text-[11px] text-text-3" title={s?.baseUrl}>
              {s ? (s.providerLabel ?? PROVIDER_LABEL[s.provider]) : 'Nhà cung cấp AI · tự cấu hình'}
            </span>
          </div>
          {saving ? (
            <span role="status" className="text-[10px] font-semibold whitespace-nowrap text-text-3">
              Đang lưu…
            </span>
          ) : (
            st && <span className={cx('rounded-[10px] px-[8px] py-[3px] text-[10px] font-bold whitespace-nowrap', TONE[st.tone])}>{st.label}</span>
          )}
        </div>

        {res.error || saveError ? <ErrorBanner error={saveError ?? res.error} /> : null}
        <NetProgress op="ai.settings-load" active={!s && res.loading} label="Đang tải cấu hình dịch vụ AI" />
        <NetProgress op="ai.settings-save" active={saving} label="Đang lưu cấu hình dịch vụ AI" />

        {s && (
          <>
            {s.providers.length > 1 && (
              <div className="flex w-full flex-col gap-[4px]">
                <Label>Nhà cung cấp AI</Label>
                <Dropdown<AiProviderKey>
                  align="left"
                  value={s.provider}
                  options={s.providers.map((p) => ({ key: p, label: PROVIDER_LABEL[p] }))}
                  onChange={(p) => void put({ provider: p })}
                  trigger={(open, toggle) => (
                    <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={saving} onClick={toggle} className="block w-[316px] text-left disabled:opacity-60">
                      <ModelBox text={PROVIDER_LABEL[s.provider]} />
                    </button>
                  )}
                />
              </div>
            )}
            <div className="flex w-full flex-col gap-[4px]">
              <Label>Mô hình mặc định</Label>
              <Dropdown<AiModelKey>
                align="left"
                value={s.model}
                options={s.models.map((m) => ({ key: m, label: modelLabel(s.provider, m) }))}
                onChange={(m) => void put({ model: m })}
                trigger={(open, toggle) => (
                  <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={saving} onClick={toggle} className="block w-[316px] text-left disabled:opacity-60">
                    <ModelBox text={modelLabel(s.provider, s.model)} />
                  </button>
                )}
              />
            </div>
            {s.models.length > 1 && (
              <div className="flex w-full flex-col gap-[4px]">
                <Label>Khi cần chính xác cao</Label>
                <ModelBox text={modelLabel(s.provider, s.models[1])} />
              </div>
            )}
            <div className="flex w-full flex-col gap-[4px]">
              <Label>{s.cloud ? 'Khóa API riêng (không bắt buộc)' : 'Khóa API'}</Label>
              {editKey === null ? (
                <div className={`${Box} cursor-text`} onClick={() => setEditKey('')}>
                  <span className="min-w-0 flex-1 font-mono text-[12px] font-semibold text-text">{!s.keyHint && s.cloud ? 'Đang dùng model cloud' : maskedKey(s.keyHint, s.provider)}</span>
                  <button type="button" aria-label="Nhập khoá mới" className="text-text-3">
                    <EyeOff size={14} />
                  </button>
                </div>
              ) : (
                <form
                  className={Box}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editKey.trim()) void put({ apiKey: editKey.trim() }).then(() => setEditKey(null));
                  }}
                >
                  <input autoFocus readOnly={saving} value={editKey} onChange={(e) => setEditKey(e.target.value)} placeholder="Dán khoá API mới rồi Enter" className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-text-3" />
                  <button type="button" aria-label="Huỷ" onClick={() => setEditKey(null)} className="text-text-3">
                    <Eye size={14} />
                  </button>
                </form>
              )}
            </div>

            {s.cloud && <CloudCredit cloud={s.cloud} hasKey={s.hasKey} busy={saving} onUseCloud={() => put({ clearKey: true })} />}

            {s.providers.length > 0 && s.reasoningOff !== undefined && <AiTuning settings={s} onSave={put} />}

            <div className="group relative flex w-full flex-col gap-[8px] rounded-[10px] bg-ai-soft p-[14px]">
              <span className="text-[9px] font-bold tracking-[1px] whitespace-nowrap text-ai">CHI PHÍ AI THÁNG {monthNumber(s.month)}</span>
              <div className="flex items-end gap-[8px]">
                <span className="font-mono text-[24px] font-bold whitespace-nowrap text-text">{vnd(s.usage.costVnd)}</span>
                {editBudget === null ? (
                  <span className="text-[11px] whitespace-nowrap text-text-2">/ {vnd(s.budgetVnd)} VNĐ ngân sách</span>
                ) : (
                  <form
                    className="flex items-center gap-[4px] text-[11px] text-text-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const n = Number(editBudget.replace(/\D/g, ''));
                      if (Number.isFinite(n)) void put({ budgetVnd: n }).then(() => setEditBudget(null));
                    }}
                  >
                    /
                    <input autoFocus readOnly={saving} aria-label="Ngân sách tháng (VNĐ)" value={editBudget} onChange={(e) => setEditBudget(e.target.value)} className="stroke-in h-[22px] w-[90px] rounded-[5px] bg-surface px-[6px] font-mono outline-none" />
                    VNĐ
                  </form>
                )}
              </div>
              <div className="h-[6px] w-full rounded-[3px] bg-[#E4DDFB]">
                <div className="h-[6px] rounded-[3px] bg-gradient-to-r from-ai to-ai-2" style={{ width: `${budgetPercent(s.usage.costVnd, s.budgetVnd)}%` }} />
              </div>
              <span className="text-[11px] whitespace-nowrap text-text-2">{usageLine(s.usage, PRODUCT.code)}</span>
              <button type="button" aria-label="Đổi ngân sách" onClick={() => setEditBudget(String(s.budgetVnd))} className="absolute top-[10px] right-[10px] text-ai opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                <Pencil size={13} />
              </button>
            </div>

            {hasRulesCeiling(PRODUCT.code) && s.rulesBudgetPercent !== undefined && <RulesCeiling settings={s} busy={saving} onSave={(v) => put({ rulesBudgetPercent: v })} />}
            {IS_HSDESK && <MonthlyBudgetPanel onError={setSaveError} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Credit model cloud: chưa có khoá riêng thì gọi bằng model của nền tảng và trừ vào credit (trả theo lượng dùng,
 * tài khoản mới được tặng). Có khoá riêng thì không trừ credit; nút bên dưới bỏ khoá riêng để quay về model cloud.
 */
export function CloudCredit({ cloud, hasKey, busy, onUseCloud }: { cloud: NonNullable<AiSettings['cloud']>; hasKey: boolean; busy: boolean; onUseCloud: () => Promise<void> }) {
  return (
    <div className="flex w-full flex-col gap-[6px] rounded-[10px] bg-ai-soft p-[14px]" data-cloud-credit>
      <span className="text-[9px] font-bold tracking-[1px] whitespace-nowrap text-ai">CREDIT MODEL CLOUD</span>
      <div className="flex items-end gap-[8px]">
        <span className="font-mono text-[24px] font-bold whitespace-nowrap text-text">{usd(cloud.creditUsd)}</span>
        <span className="text-[11px] whitespace-nowrap text-text-2">còn lại · đã dùng {usd(cloud.usedUsd)} / {usd(cloud.grantedUsd)}</span>
      </div>
      <span className="text-[11px] text-text-2">
        {hasKey ? 'Đang gọi bằng khoá riêng của bạn, không trừ credit.' : 'Trả theo lượng dùng. Hết credit thì nạp thêm hoặc đặt khoá riêng.'}
      </span>
      {hasKey && (
        <button type="button" disabled={busy} onClick={() => void onUseCloud()} className="self-start text-[11px] font-semibold text-ai hover:underline disabled:opacity-60">
          Bỏ khoá riêng, dùng model cloud
        </button>
      )}
    </div>
  );
}

/**
 * Tinh chỉnh lượt gọi AI: tắt suy luận (mô hình suy luận tiêu token vào "suy nghĩ" nên câu trả dễ bị cụt) và token đầu ra tối đa mỗi lượt.
 * Để trống token = theo giá trị app gửi lên. Số token thật của từng lượt xem ở nhật ký máy và GET /v1/ai/calls.
 */
export function AiTuning({ settings: s, onSave }: { settings: AiSettings; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const [lo, hi] = s.maxTokensRange ?? [256, 16384];
  return (
    <div className="flex w-full flex-col gap-[8px]" data-ai-tuning>
      <div className="flex w-full items-center gap-[8px]">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-[12px] font-semibold text-text">Tắt suy luận</span>
          <span className="text-[10px] text-text-3">Giảm token và độ trễ; mô hình trả lời thẳng, không "suy nghĩ" trước</span>
        </div>
        <Toggle size="setting" checked={!!s.reasoningOff} label="Tắt suy luận" onChange={(on) => void onSave({ reasoningOff: on })} />
      </div>
      <div className="flex w-full flex-col gap-[4px]">
        <Label>Token đầu ra tối đa mỗi lượt</Label>
        {edit === null ? (
          <div className={`${Box} cursor-text`} onClick={() => setEdit(s.maxTokens ? String(s.maxTokens) : '')}>
            <span className="min-w-0 flex-1 font-mono text-[12px] font-semibold text-text">{s.maxTokens ?? 'Theo app gửi lên'}</span>
            <Pencil size={13} className="text-text-3" />
          </div>
        ) : (
          <form
            className={Box}
            onSubmit={(e) => {
              e.preventDefault();
              const v = edit.trim();
              if (v === '') return void onSave({ maxTokens: null }).then(() => setEdit(null));
              const n = Number(v);
              if (!Number.isInteger(n) || n < lo || n > hi) return setBad(true);
              setBad(false);
              void onSave({ maxTokens: n }).then(() => setEdit(null));
            }}
          >
            <input autoFocus aria-label="Token đầu ra tối đa" inputMode="numeric" value={edit} onChange={(e) => setEdit(e.target.value.replace(/D/g, ''))} placeholder={`${lo}–${hi}, để trống = theo app`} className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-text-3" />
            <button type="button" aria-label="Huỷ" onClick={() => { setEdit(null); setBad(false); }} className="text-text-3">
              <X size={14} />
            </button>
          </form>
        )}
        {bad && <span className="text-[10px] text-red">Nhập số nguyên từ {lo} đến {hi}.</span>}
      </div>
    </div>
  );
}

/**
 * Trần cho chạy thử và kiểm trùng của sổ quy tắc (BR-020): % ngân sách tháng, số nguyên 1-100. "Về mặc định" gửi null để
 * Worker dùng lại mặc định của contracts/limits.json.
 */
export function RulesCeiling({ settings: s, onSave, busy }: { settings: AiSettings; onSave: (percent: number | null) => Promise<void>; /** Đang lưu: ô nhập chỉ đọc, nút "Về mặc định" khoá. */ busy?: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const pct = s.rulesBudgetPercent ?? s.rulesBudgetPercentDefault ?? 0;
  const isDefault = s.rulesBudgetPercentDefault !== undefined && pct === s.rulesBudgetPercentDefault;
  return (
    <div className="flex w-full flex-col gap-[6px]" data-rules-ceiling>
      <span className="text-[10px] font-semibold text-text-3">Trần cho chạy thử và kiểm trùng quy tắc (% ngân sách tháng)</span>
      {edit === null ? (
        <div className={Box}>
          <span className="font-mono text-[13px] font-bold text-text">{pct}%</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-2">≈ {vnd(ceilingVnd(s.budgetVnd, pct))} VNĐ / tháng</span>
          {isDefault && <span className="rounded-[4px] bg-chip-neutral px-[6px] py-[1px] text-[10px] font-semibold text-text-2">mặc định</span>}
          <button type="button" aria-label="Đổi trần sổ quy tắc" onClick={() => setEdit(String(pct))} className="text-text-3">
            <Pencil size={13} />
          </button>
        </div>
      ) : (
        <form
          className={cx(Box, bad && '[--stroke-c:var(--color-red)] [--stroke-w:1.5px]')}
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseCeilingPercent(edit);
            setBad(n === null);
            if (n !== null) void onSave(n).then(() => setEdit(null));
          }}
        >
          <input
            autoFocus
            aria-label="Trần sổ quy tắc (%)"
            aria-invalid={bad}
            readOnly={busy}
            inputMode="numeric"
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] font-bold text-text outline-none"
          />
          <span className="text-[11px] text-text-2">%</span>
          <button type="button" aria-label="Huỷ" onClick={() => (setEdit(null), setBad(false))} className="text-text-3">
            <X size={13} />
          </button>
        </form>
      )}
      {bad && edit !== null ? <span className="text-[11px] text-red">Nhập số nguyên từ 1 đến 100.</span> : null}
      {!isDefault && s.rulesBudgetPercentDefault !== undefined && (
        <button type="button" disabled={busy} onClick={() => void onSave(null).then(() => setEdit(null))} className="self-start text-[11px] font-semibold text-blue disabled:opacity-50">
          Về mặc định ({s.rulesBudgetPercentDefault}%)
        </button>
      )}
    </div>
  );
}

function ModelBox({ text }: { text: string }) {
  return (
    <div className={Box}>
      <span className="min-w-0 flex-1 text-[12px] font-semibold text-text">{text}</span>
      <ChevronDown size={14} className="text-text-3" />
    </div>
  );
}

// ---------- Đồng ý xử lý dữ liệu qua dịch vụ AI ----------

const CONSENT_KEY = `${PRODUCT.code}.ai-consent.v1`;
const OPTIONS = [
  { key: 'send', title: 'Gửi hình ảnh & thông tin hàng hóa để AI phân tích', sub: 'Chưa xác nhận' },
  { key: 'mask', title: 'Ẩn tên khách hàng, giá nhập khi gửi AI', sub: 'Chỉ gửi ảnh, tên hàng, thông số cần cho phân loại' },
  { key: 'history', title: 'Lưu lịch sử phân tích trên Google Drive công ty', sub: 'Phục vụ truy vết và Sổ dạy AI' },
] as const;
type ConsentKey = (typeof OPTIONS)[number]['key'];
type Consent = Partial<Record<ConsentKey, { on: boolean; by?: string; at?: number }>>;

function readConsent(): Consent {
  try {
    return JSON.parse(localStorage.getItem(CONSENT_KEY) ?? '{}') as Consent;
  } catch {
    return {};
  }
}

/**
 * Thẻ đồng ý xử lý dữ liệu qua AI. CHƯA có API lưu ở Worker: trạng thái chỉ nhớ trên máy này (localStorage) và chưa chặn gọi AI;
 * khi Worker có endpoint thì thay readConsent / lưu bằng platform.api.
 */
export function AiConsentCard({ className }: { className?: string }) {
  const [consent, setConsent] = useState<Consent>(readConsent);
  const [me, setMe] = useState('');
  useEffect(() => {
    void platform.getState().then((s) => setMe(s.user?.name ?? ''), () => undefined);
  }, []);
  const toggle = (k: ConsentKey, on: boolean) => {
    const next = { ...consent, [k]: { on, by: me, at: Math.floor(Date.now() / 1000) } };
    setConsent(next);
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
    } catch {
      /* chế độ riêng tư: giữ trong bộ nhớ */
    }
  };
  return (
    <div className={cx('stroke-in flex w-full flex-col gap-[12px] rounded-[12px] bg-surface p-[18px] leading-[normal]', className)}>
      <div className="flex items-center gap-[8px]">
        <ShieldCheck size={16} className="text-green" />
        <span className="text-[14px] font-bold whitespace-nowrap text-text">Đồng ý xử lý dữ liệu qua dịch vụ AI</span>
      </div>
      {OPTIONS.map((o) => {
        const c = consent[o.key];
        const sub = o.key === 'send' ? (c?.on && c.by && c.at ? `Xác nhận bởi ${c.by} · ${fmtDate(c.at)}` : o.sub) : o.sub;
        return (
          <div key={o.key} className="flex w-full items-center gap-[12px] rounded-[8px] bg-muted-box px-[12px] py-[10px]">
            <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
              <span className="w-full text-[12px] font-semibold text-text">{o.title}</span>
              <span className="w-full text-[11px] text-text-3">{sub}</span>
            </div>
            <Toggle size="setting" checked={!!c?.on} label={o.title} onChange={(on) => toggle(o.key, on)} />
          </div>
        );
      })}
    </div>
  );
}



/** Ngân sách AI tháng của Báo giá (hs-suggest BR-013, FR-032): mức, đã dùng, bổ sung, hoá đơn. Cùng thẻ Dịch vụ AI. */
interface BudgetDetail {
  month: string;
  levelVnd: number;
  topupsVnd: number;
  capVnd: number;
  usedVnd: number;
  remainingVnd: number;
  warn: boolean;
  empty: boolean;
  topups?: { id: string; amountVnd: number; byUser: string; at: number }[];
  invoice?: { amountVnd: number; byUser: string; at: number; alert: boolean } | null;
}

function MonthlyBudgetPanel({ onError }: { onError: (e: unknown) => void }) {
  const [d, setD] = useState<BudgetDetail | null>(null);
  const [level, setLevel] = useState('');
  const [topup, setTopup] = useState('');
  const [invoice, setInvoice] = useState('');
  const reload = () => platform.suggest.budgetDetail().then((x) => setD(x as BudgetDetail)).catch(() => setD(null));
  useEffect(() => {
    void reload();
  }, []);
  // Ba ô (mức tháng, bổ sung, hoá đơn) dùng chung một cờ: đang lưu thì bỏ qua Enter / bấm tiếp, tránh cộng bổ sung hai lần.
  const [save, saving] = useAction((fn: () => Promise<unknown>) => {
    onError(null);
    return fn().then(reload).catch(onError);
  });
  if (!d) return null;
  return (
    <div className="flex w-full flex-col gap-[8px] rounded-[10px] border border-border p-[12px]">
      <span className="text-[9px] font-bold tracking-[1px] whitespace-nowrap text-ai">NGÂN SÁCH AI THÁNG {monthNumber(d.month)}</span>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-2">Mức tháng</span>
        <form
          className="flex items-center gap-[4px]"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(level.replace(/\D/g, ''));
            if (n > 0) save(() => platform.suggest.setBudgetLevel(n));
          }}
        >
          <input aria-label="Mức tháng (VNĐ)" readOnly={saving} value={level || vnd(d.levelVnd)} onChange={(e) => setLevel(e.target.value)} className="stroke-in h-[22px] w-[92px] rounded-[5px] bg-surface px-[6px] font-mono text-[11px] outline-none" />
          <span className="text-text-3">VNĐ</span>
        </form>
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-2">Bổ sung</span>
        <form
          className="flex items-center gap-[4px]"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(topup.replace(/\D/g, ''));
            if (n > 0) save(() => platform.suggest.addTopup(n)).then(() => setTopup(''));
          }}
        >
          <input aria-label="Bổ sung (VNĐ)" readOnly={saving} value={topup} placeholder={vnd(d.topupsVnd)} onChange={(e) => setTopup(e.target.value)} className="stroke-in h-[22px] w-[92px] rounded-[5px] bg-surface px-[6px] font-mono text-[11px] outline-none" />
          <button type="submit" disabled={saving} className="text-accent disabled:opacity-50">
            {saving ? 'Đang lưu…' : 'Thêm'}
          </button>
        </form>
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-2">Đã dùng / còn lại</span>
        <span className={d.empty ? 'text-red' : d.warn ? 'text-amber' : 'text-text'}>{vnd(d.usedVnd)} / {vnd(Math.max(0, d.remainingVnd))}</span>
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-2">Hoá đơn</span>
        <form
          className="flex items-center gap-[4px]"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(invoice.replace(/\D/g, ''));
            if (n >= 0) save(() => platform.suggest.setInvoice(n)).then(() => setInvoice(''));
          }}
        >
          <input aria-label="Số trên hoá đơn" readOnly={saving} value={invoice} placeholder={d.invoice ? vnd(d.invoice.amountVnd) : '—'} onChange={(e) => setInvoice(e.target.value)} className="stroke-in h-[22px] w-[92px] rounded-[5px] bg-surface px-[6px] font-mono text-[11px] outline-none" />
          <button type="submit" disabled={saving} className="text-accent disabled:opacity-50">
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </form>
      </div>
      {d.invoice?.alert && <span className="text-[10px] text-amber">Hoá đơn cao hơn ước tính quá 10%.</span>}
      <span className="text-[10px] text-text-3">Chi phí từng lượt tính riêng, không lưu nội dung mặt hàng.</span>
    </div>
  );
}
