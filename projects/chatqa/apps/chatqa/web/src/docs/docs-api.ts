// Phần thuần của trang Tài liệu: tách/ghép front-matter, mã vừa gán, dòng diff, lọc ma trận độ phủ. Gọi Go qua testApi
// (testing/bridge.ts, test.Service.Docs/SaveDoc/Coverage...); quy tắc mã và front-matter khớp apps/chatqa/desktop/internal/docs.
import { errorText } from '@shell/lib/session';
import type { AffectedCase, CaseRef, Coverage, DocType, Requirement, ReqRow } from '../testing/bridge';

export const DOC_TYPES: { key: DocType; label: string }[] = [
  { key: 'PRD', label: 'PRD - yêu cầu sản phẩm' },
  { key: 'BRD', label: 'BRD - yêu cầu nghiệp vụ' },
  { key: 'URD', label: 'URD - yêu cầu người dùng' },
  { key: 'SRS', label: 'SRS - đặc tả phần mềm' },
  { key: 'AC', label: 'AC - tiêu chí nghiệm thu' },
  { key: 'other', label: 'Khác' },
];

/** Gợi ý quy ước neo hiện cạnh ô soạn thảo. */
export const ANCHOR_HINT = 'Thêm `{#REQ-012}` cuối tiêu đề; để trống, app tự gán khi lưu';
/** Chỗ được gắn mã: tiêu đề cấp 2–6 và mục danh sách cấp đầu; bảng Markdown không được đọc. */
export const ANCHOR_SCOPE = 'Mã chỉ gắn ở tiêu đề (## trở xuống) và mục danh sách cấp đầu. Bảng Markdown không hỗ trợ mã yêu cầu: viết mỗi tiêu chí thành một mục danh sách.';

const APP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ANCHOR_RE = /\{#([^}]*)\}\s*$/;
const TYPES = new Set<string>(DOC_TYPES.map((t) => t.key));

/** Tên app như kho tài liệu/flow (Go: appNameRe). */
export const validAppName = (s: string) => APP_RE.test(s);
/** Mã tài liệu = tên tệp (Go: docIDRe). */
export const validDocId = (s: string) => DOC_ID_RE.test(s);

export interface DocParts {
  type: DocType;
  title: string;
  /** Dòng front-matter khác type/title/rev: giữ nguyên khi lưu lại. */
  extra: string[];
  body: string;
}

/** Tách front-matter (--- ... ---) của tài liệu đã lưu thành loại, tiêu đề, dòng khác và phần thân. rev do Go quản lý nên bỏ. */
export function splitDoc(markdown: string): DocParts {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: DocParts = { type: 'other', title: '', extra: [], body: lines.join('\n') };
  if (lines[0]?.trimEnd() !== '---') return out;
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  if (end < 0) return out;
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    const key = at < 0 ? '' : line.slice(0, at).trim();
    const val = at < 0 ? '' : line.slice(at + 1).trim();
    if (key === 'type') {
      const t = val.replace(/\s+#.*$/, '');
      const found = [...TYPES].find((x) => x.toLowerCase() === t.toLowerCase());
      if (found) out.type = found as DocType;
    } else if (key === 'title') out.title = val;
    else if (key !== 'rev') out.extra.push(line);
  }
  out.body = lines.slice(end + 1).join('\n');
  return out;
}

/** Ghép lại Markdown gửi Go: front-matter type/title (+ dòng khác) rồi phần thân. Tiêu đề một dòng. */
export function composeDoc(p: DocParts): string {
  const title = p.title.replace(/\s+/g, ' ').trim();
  const head = ['---', `type: ${p.type}`, ...(title ? [`title: ${title}`] : []), ...p.extra, '---'];
  return `${head.join('\n')}\n${p.body}`;
}

/** Các mã neo {#…} đang có trong văn bản (cuối dòng). */
export function anchorIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const m = ANCHOR_RE.exec(line);
    if (m && m[1].trim()) ids.add(m[1].trim());
  }
  return ids;
}

/** Mã app vừa gán khi lưu: có trong bản Go trả về nhưng chưa có neo trong nội dung đã gửi. */
export function assignedIds(sent: string, saved: { requirements: Requirement[] }): string[] {
  const had = anchorIds(sent);
  return saved.requirements.map((r) => r.id).filter((id) => !had.has(id));
}

export type DiffKind = 'add' | 'del' | 'same';

/** Dòng diff của Go ("  " giữ, "+ " thêm, "- " bỏ) thành loại + nội dung. */
export function diffLines(diff: string): { kind: DiffKind; text: string }[] {
  if (diff === '') return [];
  const lines = diff.replace(/\n$/, '').split('\n');
  return lines.map((l) => {
    if (l.startsWith('+ ')) return { kind: 'add', text: l.slice(2) };
    if (l.startsWith('- ')) return { kind: 'del', text: l.slice(2) };
    return { kind: 'same', text: l.startsWith('  ') ? l.slice(2) : l };
  });
}

/** Mã yêu cầu cần sinh lại cho các ca bị ảnh hưởng: hợp các mã đã đổi (mã đã xoá không còn để biên dịch). */
export function regenReqs(cases: AffectedCase[]): string[] {
  return [...new Set(cases.flatMap((c) => c.reqs))].sort();
}

/** Danh sách mã gõ tay "REQ-1, AC-2" thành mảng không trùng. */
export function parseReqList(s: string): string[] {
  return [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

/** Số yêu cầu theo tài liệu. */
export function reqCountByDoc(reqs: Requirement[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reqs) out[r.doc] = (out[r.doc] ?? 0) + 1;
  return out;
}

/** Mã yêu cầu theo tên flow (từ ma trận độ phủ): flow lỗi có mã thì mở được ghi chú "nguồn có thể sai". */
export function flowReqs(cov: Pick<Coverage, 'reqs'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of cov.reqs) {
    for (const c of r.cases) {
      if (!c.flow) continue;
      const list = (out[c.flow] ??= []);
      if (!list.includes(r.id)) list.push(r.id);
    }
  }
  return out;
}

/** Tên flow đã lưu của một flow trong báo cáo: lượt chạy xác nhận ứng viên (thư mục/.candidate-<tên>) tính cho <tên>, như Go. */
export function savedFlowName(flow: string): string {
  const at = flow.lastIndexOf('/') + 1;
  const base = flow.slice(at);
  return flow.slice(0, at) + (base.startsWith('.candidate-') ? base.slice('.candidate-'.length) : base);
}

/** Mã yêu cầu nối với flow của một lượt chạy (rỗng = flow chưa truy vết). */
export const reqsOfFlow = (byFlow: Record<string, string[]>, flow: string) => byFlow[savedFlowName(flow)] ?? [];

export type RunState = 'passed' | 'failed' | 'never';

/** Kết quả chạy gần nhất của flow của ca. */
export const caseRunState = (c: CaseRef): RunState => c.last?.status ?? 'never';

export const RUN_STATE_LABEL: Record<RunState, string> = { passed: 'Đạt', failed: 'Lỗi', never: 'Chưa chạy' };

/** Lọc trạng thái của bảng độ phủ. */
export type CoverageStatus = '' | 'passed' | 'failed' | 'never' | 'stale' | 'nocase';

export const COVERAGE_STATUS: { key: CoverageStatus; label: string }[] = [
  { key: '', label: 'Mọi trạng thái' },
  { key: 'failed', label: 'Có ca lỗi' },
  { key: 'never', label: 'Có ca chưa chạy' },
  { key: 'passed', label: 'Mọi ca đạt' },
  { key: 'stale', label: 'Cần xem lại' },
  { key: 'nocase', label: 'Chưa có ca' },
];

/** Lọc dòng yêu cầu theo tài liệu ("" = mọi tài liệu) và trạng thái. */
export function filterCoverage(rows: ReqRow[], doc: string, status: CoverageStatus): ReqRow[] {
  return rows.filter((r) => {
    if (doc && r.doc !== doc) return false;
    switch (status) {
      case 'nocase':
        return r.cases.length === 0;
      case 'stale':
        return r.cases.some((c) => c.stale);
      case 'passed':
        return r.cases.length > 0 && r.cases.every((c) => caseRunState(c) === 'passed');
      case 'failed':
      case 'never':
        return r.cases.some((c) => caseRunState(c) === status);
      default:
        return true;
    }
  });
}

/** Lỗi của kho tài liệu: dữ liệu sai / không tìm thấy thì hiện câu chi tiết của Go (dòng, mã trùng), còn lại câu chung. */
export function docErrorText(e: unknown): string {
  const err = e as { code?: string; params?: Record<string, string | number> } | null;
  const detail = err?.params?.['chi tiết'];
  return (err?.code === 'invalid' || err?.code === 'not_found') && detail ? String(detail) : errorText(e);
}
