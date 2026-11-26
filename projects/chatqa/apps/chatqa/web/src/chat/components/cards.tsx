// CostConfirm, ErrorCard, YamlDiff, FlowList, JsonFallback.
import { useState, type ReactNode } from 'react';
import { Button } from '@shell/components/ui';
import { errorText } from '@shell/lib/session';
import { ApiError } from '@shell/platform';
import { Card, Muted, StateBadge, vnd, type ChatActions } from './shared';

export interface CostConfirmData {
  costVnd: number;
  leftVnd?: string | number;
  token: string;
  scope: 'chat' | 'tool';
  tool?: string;
  args?: Record<string, unknown>;
  conversationId?: string;
}

/** Xác nhận chi phí: lượt chat chạy tiếp với mã, hoặc tool chạy lại với confirm_token. */
export function confirmCost(d: CostConfirmData, actions: ChatActions) {
  if (d.scope === 'chat') actions.confirmChat(d.token);
  else if (d.tool) actions.runTool(d.tool, { ...(d.args ?? {}), confirm_token: d.token });
}

export function CostConfirm({ data, actions }: { data: CostConfirmData; actions: ChatActions }) {
  const [done, setDone] = useState<'yes' | 'no' | null>(null);
  const left = typeof data.leftVnd === 'number' ? vnd(data.leftVnd) : data.leftVnd && data.leftVnd !== '?' ? vnd(Number(data.leftVnd)) : 'chưa rõ';
  return (
    <Card title="Xác nhận chi phí AI" tone="warn">
      <p className="text-[12.5px]/[17px] text-text">
        {data.scope === 'chat' ? 'Lượt trả lời này' : `Lệnh ${data.tool}`} ước tính <b className="font-mono">{vnd(data.costVnd)}</b>, vượt trần mỗi thao tác. Ngân sách
        còn <b className="font-mono">{left}</b>.
      </p>
      {done ? (
        <Muted>{done === 'yes' ? 'Đã xác nhận.' : 'Đã bỏ qua.'}</Muted>
      ) : (
        <div className="flex gap-[8px]">
          <Button
            size="sm"
            onClick={() => {
              setDone('yes');
              confirmCost(data, actions);
            }}
          >
            Xác nhận và chạy
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDone('no')}>
            Bỏ qua
          </Button>
        </div>
      )}
    </Card>
  );
}

export function ErrorCard({ data }: { data: { code: string; message?: string } }) {
  const detail = data.message?.replace(new RegExp(`^${data.code}:?\\s*`), '');
  // E-011: chi tiết là mã quyền (vd cqs.run); câu báo lỗi dùng tên thao tác của quyền đó.
  const params: Record<string, string> = data.code === 'permission_denied' && detail ? { perm: detail } : {};
  return (
    <Card title="Không làm được" tone="error">
      <p className="text-[12.5px]/[17px] text-text">{errorText(new ApiError(data.code, 0, params))}</p>
      {detail && <p className="font-mono text-[11px]/[15px] text-text-3">{detail}</p>}
    </Card>
  );
}

interface YamlDiffData {
  flaky: boolean;
  attempts: unknown[] | null;
  diff?: { app: string; flow: string; before: string; after: string; diff: string; explanation: string; valid: boolean; verified: boolean; error?: string };
}

export function YamlDiff({ data, actions }: { data: YamlDiffData; actions: ChatActions }) {
  if (data.flaky || !data.diff) {
    return (
      <Card title="Tự sửa flow">
        <Muted>{data.flaky ? 'Flow đạt khi chạy lại: lỗi chập chờn, không cần sửa, không gọi AI.' : 'Không có bản sửa (lỗi do thiết bị hoặc môi trường).'}</Muted>
      </Card>
    );
  }
  const d = data.diff;
  return (
    <Card title={`Bản sửa đề xuất · ${d.flow}`} aside={<StateBadge state={d.verified ? 'passed' : d.valid ? 'failed' : 'error'} />}>
      <p className="text-[12.5px]/[17px] text-text">{d.explanation}</p>
      <pre className="max-h-[260px] overflow-auto rounded-[8px] bg-muted-box p-[8px] font-mono text-[11px]/[15px]">
        {d.diff.split('\n').map((l, i) => (
          <span key={i} className={l.startsWith('+ ') ? 'block text-green' : l.startsWith('- ') ? 'block text-red' : 'block text-text-2'}>
            {l || ' '}
          </span>
        ))}
      </pre>
      {d.error && <Muted>{d.error}</Muted>}
      {d.valid && d.verified && (
        <Button
          size="sm"
          className="self-start"
          onClick={() => actions.runTool('test_apply_repair', { app: d.app, flow: d.flow, before: d.before, after: d.after, explanation: d.explanation })}
        >
          Áp dụng bản sửa
        </Button>
      )}
    </Card>
  );
}

interface FlowInfo {
  app?: string;
  name: string;
  stale?: boolean;
  errors?: { file: string; line?: number; message: string }[] | null;
}

type FlowListData =
  | { app: string; flows: FlowInfo[] | null; secretNames?: string[] | null }
  | { app: string; valid: boolean }
  | { sourceHash: string; cases: { case: { id: string; title: string }; flow?: string; status: string; error?: string; risks?: string[] | null }[] | null }
  | (FlowInfo & { app: string; hash: string });

const CASE_STATE: Record<string, string> = { saved: 'passed', unchanged: 'ready', invalid: 'error', failed_verification: 'failed', error: 'error' };

/** flowAction: nút thêm cuối dòng của từng flow trong danh sách flow của app (màn Kiểm thử); chat không dùng. */
export function FlowList({ data, flowAction }: { data: FlowListData; flowAction?: (f: FlowInfo) => ReactNode }) {
  if ('cases' in data) {
    return (
      <Card title="Biên dịch tài liệu">
        <ul>
          {(data.cases ?? []).map((c) => (
            <li key={c.case.id} className="flex flex-col gap-[2px] border-t border-divider py-[5px] first:border-t-0">
              <span className="flex items-center gap-[8px] text-[12px]/[16px] text-text-2">
                <StateBadge state={CASE_STATE[c.status] ?? c.status} />
                <span className="min-w-0 flex-1 truncate">{c.case.title}</span>
                <span className="font-mono text-text-3">{c.flow}</span>
              </span>
              {c.error && <Muted>{c.error}</Muted>}
              {(c.risks ?? []).map((r) => (
                <Muted key={r}>Rủi ro: {r}</Muted>
              ))}
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  if ('valid' in data) {
    return (
      <Card title={`Kiểm tra flow · ${data.app}`}>
        <Muted>{data.valid ? 'Mọi flow hợp lệ.' : 'Có flow lỗi.'}</Muted>
      </Card>
    );
  }
  if ('hash' in data) {
    return (
      <Card title="Đã lưu flow">
        <Muted>
          {data.app}/{data.name}
        </Muted>
      </Card>
    );
  }
  const flows = data.flows ?? [];
  return (
    <Card title={`Flow · ${data.app}`}>
      <ul>
        {flows.map((f) => (
          <li key={f.name} className="flex items-center gap-[8px] border-t border-divider py-[4px] text-[12px]/[16px] first:border-t-0">
            <span className="min-w-0 flex-1 truncate font-mono text-text-2">{f.name}</span>
            {f.stale && <span className="text-[11px]/[14px] text-amber">flow con đã đổi</span>}
            {(f.errors ?? []).length > 0 && <span className="text-[11px]/[14px] text-red">{(f.errors ?? []).length} lỗi</span>}
            {flowAction?.(f)}
          </li>
        ))}
      </ul>
      {(data.secretNames ?? []).length > 0 && <Muted>Biến bí mật có sẵn: {(data.secretNames ?? []).join(', ')}</Muted>}
    </Card>
  );
}

/** Dữ liệu không khớp hợp đồng: hiện JSON dạng chữ, không bao giờ vẽ HTML. */
export function JsonFallback({ kind, data, reason }: { kind: string; data: unknown; reason: string }) {
  return (
    <Card title={`Kết quả ${kind}`}>
      <Muted>Không hiện được dạng thẻ ({reason}).</Muted>
      <pre className="max-h-[220px] overflow-auto rounded-[8px] bg-muted-box p-[8px] font-mono text-[11px]/[15px] text-text-2">{JSON.stringify(data, null, 2)}</pre>
    </Card>
  );
}
