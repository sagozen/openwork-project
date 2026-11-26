// Dịch vụ AI (Cài đặt › Dịch vụ AI): số liệu hiển thị từ GET /v1/ai/settings (worker/src/routes/ai.ts).
/** Gói mô hình (worker/src/lib/ai.ts AI_MODELS); mỗi sản phẩm chỉ chọn trong `models` máy chủ trả về. */
export type AiModelKey = 'flash' | 'plus' | 'sonnet';

/** Nhà cung cấp cho đường gọi kiểu OpenAI (worker/src/lib/ai.ts AI_PROVIDERS). Sản phẩm Claude trả `providers` rỗng. */
export type AiProviderKey = 'alibaba' | 'fal' | 'opencode';

export interface AiSettings {
  /** Nhà cung cấp đang chọn (ban đầu là Alibaba). */
  provider: AiProviderKey;
  /** Nhà cung cấp chọn được của sản phẩm; rỗng với sản phẩm gọi Claude. */
  providers: AiProviderKey[];
  /** Tên hiển thị của nhà cung cấp (Anthropic với sản phẩm Claude). */
  providerLabel?: string;
  model: AiModelKey;
  models: AiModelKey[];
  /** Endpoint đang cấu hình (OpenAI-compatible); hiện ở tooltip dòng nhà cung cấp, không gắn cứng bên nào. */
  baseUrl?: string;
  hasKey: boolean;
  keyHint: string | null;
  budgetVnd: number;
  /** "2026-11" */
  month: string;
  usage: { calls: number; tokens_in: number; tokens_out: number; cost_vnd: number; costVnd: number };
  /** Trần chạy thử và kiểm trùng của sổ quy tắc (% ngân sách tháng) đang áp dụng, và mặc định của contracts/limits.json. */
  rulesBudgetPercent?: number;
  rulesBudgetPercentDefault?: number;
  /** Tắt suy luận của mô hình (Worker gửi tham số theo nhà cung cấp); chỉ có với sản phẩm gọi kiểu OpenAI. */
  reasoningOff?: boolean;
  /** Token đầu ra tối đa xin mỗi lượt; null = theo app gửi lên. maxTokensRange = [thấp nhất, cao nhất] cho phép. */
  maxTokens?: number | null;
  maxTokensRange?: [number, number];
  /**
   * Model cloud của nền tảng (chỉ sản phẩm có, vd ChatQASoftware): chưa có khoá riêng thì gọi bằng khoá của nền tảng
   * và trừ vào credit (USD), trả theo lượng dùng. Thiếu = sản phẩm không có model cloud.
   */
  cloud?: { active: boolean; creditUsd: number; grantedUsd: number; usedUsd: number };
}

export const PROVIDER_LABEL: Record<AiProviderKey, string> = {
  alibaba: 'Alibaba Cloud Model Studio · Qwen',
  fal: 'fal.ai · OpenRouter',
  opencode: 'OpenCode Go · DeepSeek',
};

/** Nhãn gói theo nhà cung cấp: cùng gói nhưng fal.ai chạy model Qwen3-VL khác (qua OpenRouter). */
export const MODEL_LABEL: Record<AiProviderKey, Record<AiModelKey, string>> = {
  alibaba: { flash: 'Qwen3-VL-Flash', plus: 'Qwen3-VL-Plus', sonnet: 'Claude Sonnet 5.5' },
  fal: { flash: 'Qwen3-VL 30B-A3B', plus: 'Qwen3-VL 235B-A22B', sonnet: 'Claude Sonnet 5.5' },
  opencode: { flash: 'DeepSeek V4.1 Flash', plus: 'DeepSeek V4.1 Flash', sonnet: 'Claude Sonnet 5.5' },
};

export const modelLabel = (provider: AiProviderKey, model: AiModelKey): string => MODEL_LABEL[provider]?.[model] ?? MODEL_LABEL.alibaba[model];

/** 186400 -> "186.400" (kiểu Việt Nam). */
export const vnd = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export const monthNumber = (month: string) => String(Number(month.slice(5, 7)) || '');

/** Phần trăm ngân sách đã dùng, 0..100. */
export const budgetPercent = (used: number, budget: number) => (budget > 0 ? Math.min(100, Math.max(0, (used / budget) * 100)) : 100);

/** Trung bình VNĐ / lượt gọi AI. */
export const avgPerCall = (s: AiSettings['usage']) => (s.calls > 0 ? Math.round(s.costVnd / s.calls) : 0);

/** Dòng lượt dùng dưới thanh ngân sách: HS Desk đếm lượt phân tích mặt hàng, sản phẩm khác đếm lượt gọi AI. */
export const usageLine = (s: AiSettings['usage'], product: string) =>
  product === 'hsdesk'
    ? `${vnd(s.calls)} lượt phân tích · trung bình ${avgPerCall(s)} VNĐ / mặt hàng`
    : `${vnd(s.calls)} lượt gọi AI · trung bình ${avgPerCall(s)} VNĐ / lượt`;

/** Khoá đã che: chỉ 4 ký tự cuối. fal.ai dùng khoá dạng `id:secret` nên không có tiền tố `sk-`. */
export const maskedKey = (hint: string | null, provider: AiProviderKey = 'alibaba') => (hint ? `${provider === 'fal' ? '' : 'sk-'}••••••••••${hint}` : 'Chưa có khoá');

export type AiState = { tone: 'green' | 'amber' | 'red'; label: string };
export function aiState(s: AiSettings): AiState {
  if (!s.hasKey && s.cloud?.active) return s.cloud.creditUsd > 0 ? { tone: 'green', label: 'Model cloud' } : { tone: 'red', label: 'Hết credit' };
  if (!s.hasKey) return { tone: 'amber', label: 'Chưa có khoá' };
  if (s.usage.costVnd >= s.budgetVnd) return { tone: 'red', label: 'Hết ngân sách' };
  return { tone: 'green', label: 'Hoạt động' };
}

/** 4.5 -> "$4.50". */
export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Sản phẩm có sổ quy tắc phân loại (trần BR-020 chỉ có nghĩa ở đó). */
export const hasRulesCeiling = (product: string) => product === 'hsdesk';

/** Trần sổ quy tắc nhập vào: số nguyên 1..100; 0, 101, số thập phân, chữ, để trống => null. */
export function parseCeilingPercent(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}

/** Số tiền tương ứng với trần (% của ngân sách tháng), làm tròn VNĐ. */
export const ceilingVnd = (budgetVnd: number, percent: number) => Math.round((budgetVnd * percent) / 100);
