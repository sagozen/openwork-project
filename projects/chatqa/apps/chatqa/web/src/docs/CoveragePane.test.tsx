import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Coverage } from '../testing/bridge';
import { caseReqs, CoverageView } from './CoveragePane';
import { filterCoverage, flowReqs, reqsOfFlow, savedFlowName } from './docs-api';

const cov: Coverage = {
  reqs: [
    {
      id: 'REQ-001',
      doc: 'prd-login',
      title: 'Đăng nhập OTP',
      cases: [
        { id: 'web:TC-k3x9p', title: 'OTP đúng', flow: '01_login.spec.ts', stale: false, last: { status: 'passed', runId: 'r1', at: '2026-11-19T02:00:00Z' } },
        { id: 'web:TC-a1b2c', title: 'OTP sai', flow: '02_otp_wrong.spec.ts', stale: true, last: { status: 'failed', runId: 'r2', at: '2026-11-19T02:05:00Z' } },
      ],
    },
    { id: 'REQ-002', doc: 'prd-login', title: 'Khoá sau 5 lần sai', cases: [{ id: 'TC-q7w8e', title: 'Khoá tài khoản', flow: '03_lock.yaml', stale: false }] },
    { id: 'AC-01', doc: 'ac-checkout', title: 'Thanh toán thẻ', cases: [] },
  ],
  untraced: [{ id: 'old-case-1', title: 'Ca cũ từ tài liệu tự do', flow: '09_legacy.yaml', stale: false }],
  duplicates: [],
};

describe('ma trận độ phủ', () => {
  it('đạt / lỗi / chưa chạy, nhãn cần xem lại, yêu cầu chưa có ca, ca chưa truy vết', () => {
    const html = renderToStaticMarkup(<CoverageView cov={cov} onGenerate={() => undefined} onEdit={() => undefined} />);
    expect(html).toContain('Độ phủ · 3 yêu cầu, 1 chưa có ca');
    expect(html).toMatch(/data-run="passed"[^>]*>Đạt<\/span>/);
    expect(html).toMatch(/data-run="failed"[^>]*>Lỗi<\/span>/);
    expect(html.match(/data-run="never"[^>]*>Chưa chạy<\/span>/g)).toHaveLength(2); // ca chưa chạy + ca chưa truy vết
    expect(html.match(/cần xem lại/g)).toHaveLength(1);
    expect(html).toContain('Chưa có ca kiểm thử');
    expect(html).toContain('Ca chưa truy vết · 1');
    expect(html).toContain('old-case-1 · 09_legacy.yaml');
    expect(html).toContain('Sinh ca kiểm thử');
    expect(html.match(/<\/svg>Sửa mã<\/button>/g)).toHaveLength(4); // 3 ca có mã + 1 ca chưa truy vết
  });

  it('không quyền chạy flow: không chọn, không sinh, không sửa mã', () => {
    const html = renderToStaticMarkup(<CoverageView cov={cov} />);
    expect(html).not.toContain('Sinh ca kiểm thử');
    expect(html).not.toMatch(/<\/svg>Sửa mã<\/button>/);
    expect(html).not.toContain('role="checkbox"');
  });

  it('đếm mã đã chọn trên nút sinh ca; dòng đang sửa hiện ô mã điền sẵn', () => {
    const html = renderToStaticMarkup(<CoverageView cov={cov} selected={['REQ-001', 'AC-01']} onGenerate={() => undefined} onEdit={() => undefined} editing="REQ-002/TC-q7w8e" />);
    expect(html).toContain('Sinh ca kiểm thử (2)');
    expect(html).toContain('aria-label="Mã yêu cầu của ca TC-q7w8e"');
    expect(html).toContain('value="REQ-002"');
  });

  it('lọc theo tài liệu và trạng thái', () => {
    const ids = (doc: string, s: Parameters<typeof filterCoverage>[2]) => filterCoverage(cov.reqs, doc, s).map((r) => r.id);
    expect(ids('', '')).toEqual(['REQ-001', 'REQ-002', 'AC-01']);
    expect(ids('ac-checkout', '')).toEqual(['AC-01']);
    expect(ids('', 'nocase')).toEqual(['AC-01']);
    expect(ids('', 'stale')).toEqual(['REQ-001']);
    expect(ids('', 'failed')).toEqual(['REQ-001']);
    expect(ids('', 'never')).toEqual(['REQ-002']);
    expect(ids('', 'passed')).toEqual([]);
    expect(ids('prd-login', 'nocase')).toEqual([]);
    const html = renderToStaticMarkup(<CoverageView cov={cov} docFilter="prd-login" statusFilter="nocase" />);
    expect(html).toContain('Không có yêu cầu nào khớp bộ lọc');
  });

  it('chưa có yêu cầu; mã trùng thì cảnh báo', () => {
    const empty = renderToStaticMarkup(<CoverageView cov={{ reqs: [], untraced: [], duplicates: [] }} />);
    expect(empty).toContain('Chưa có yêu cầu nào');
    expect(empty).toContain('Mọi ca đều nối với yêu cầu');
    expect(renderToStaticMarkup(<CoverageView cov={{ ...cov, duplicates: ['REQ-002'] }} />)).toContain('Mã yêu cầu bị trùng');
  });

  it('mã của ca và mã theo flow (cho ghi chú từ lượt chạy, kể cả lượt chạy xác nhận ứng viên)', () => {
    expect(caseReqs(cov, 'web:TC-k3x9p')).toEqual(['REQ-001']);
    const byFlow = flowReqs(cov);
    expect(byFlow['03_lock.yaml']).toEqual(['REQ-002']);
    expect(savedFlowName('sub/.candidate-01_login.spec.ts')).toBe('sub/01_login.spec.ts');
    expect(reqsOfFlow(byFlow, '.candidate-02_otp_wrong.spec.ts')).toEqual(['REQ-001']);
    expect(reqsOfFlow(byFlow, '09_legacy.yaml')).toEqual([]);
  });
});
