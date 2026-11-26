import { afterEach, describe, expect, it, vi } from 'vitest';
import { testApi } from '../testing/bridge';
import { parseReqList, reqCountByDoc } from './docs-api';

afterEach(() => vi.unstubAllGlobals());

/** Giả window.go.test.Service: mọi hàm ghi lại tên + tham số và trả kết quả đặt sẵn. */
function stubGo(results: Record<string, unknown>) {
  const calls: [string, unknown[]][] = [];
  const service = Object.fromEntries(
    Object.entries(results).map(([name, res]) => [
      name,
      (...a: unknown[]) => {
        calls.push([name, a]);
        return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
      },
    ]),
  );
  vi.stubGlobal('window', { go: { test: { Service: service } } });
  return calls;
}

describe('testApi cho tài liệu và truy vết', () => {
  it('gọi đúng hàm Go với đúng tham số', async () => {
    const calls = stubGo({
      Docs: null,
      Doc: { id: 'prd', type: 'PRD', title: 'T', rev: 1, markdown: '', requirements: null },
      SaveDoc: { id: 'prd', type: 'PRD', title: 'T', rev: 2, markdown: '', requirements: [] },
      DeleteDoc: null,
      DocHistory: null,
      DocRevision: 'nội dung',
      DocDiff: '+ a\n',
      Requirements: { reqs: null, duplicates: null },
      Coverage: { reqs: [{ id: 'REQ-001', doc: 'prd', title: 'x', cases: null }], untraced: null, duplicates: null },
      AffectedCases: [{ caseId: 'TC-1', title: 't', reqs: null, reason: 'removed' }],
      AckCase: null,
      SetCaseReqs: null,
      Notes: null,
      AddNote: { id: 'n1', req: 'REQ-001', runId: 'r1', flow: 'f.yaml', text: 'x', author: 'Lan', at: '', status: 'open' },
      ResolveNote: { id: 'n1', req: 'REQ-001', runId: 'r1', flow: 'f.yaml', text: 'x', author: 'Lan', at: '', status: 'resolved' },
      Compile: { sourceHash: 'h', cases: null },
    });
    expect(await testApi.docs('mexpress')).toEqual([]);
    expect((await testApi.doc('mexpress', 'prd')).requirements).toEqual([]);
    expect((await testApi.saveDoc('mexpress', 'prd', '# x')).rev).toBe(2);
    await testApi.deleteDoc('mexpress', 'prd');
    expect(await testApi.docHistory('mexpress', 'prd')).toEqual([]);
    expect(await testApi.docRevision('mexpress', 'prd', 0)).toBe('nội dung');
    expect(await testApi.docDiff('mexpress', 'prd', 1, 0)).toBe('+ a\n');
    expect(await testApi.requirements('mexpress')).toEqual({ reqs: [], duplicates: [] });
    expect(await testApi.coverage('mexpress')).toEqual({ reqs: [{ id: 'REQ-001', doc: 'prd', title: 'x', cases: [] }], untraced: [], duplicates: [] });
    expect(await testApi.affectedCases('mexpress')).toEqual([{ caseId: 'TC-1', title: 't', reqs: [], reason: 'removed' }]);
    await testApi.ackCase('mexpress', 'web:TC-k3x9p');
    await testApi.setCaseReqs('mexpress', 'TC-1', ['REQ-001']);
    expect(await testApi.notes('mexpress')).toEqual([]);
    expect((await testApi.addNote('mexpress', 'REQ-001', 'r1', 'f.yaml', 'x')).status).toBe('open');
    expect((await testApi.resolveNote('mexpress', 'n1')).status).toBe('resolved');
    const req = {
      app: 'mexpress',
      source: '',
      appId: 'com.x.app',
      device: { ID: 'R58', Platform: 'android', Driver: 'uiautomator2' },
      env: {},
      secrets: [],
      confirmToken: '',
      startPath: '',
      reqs: ['REQ-001'],
    };
    expect(await testApi.compile(req)).toEqual({ sourceHash: 'h', cases: [] });
    expect(calls).toEqual([
      ['Docs', ['mexpress']],
      ['Doc', ['mexpress', 'prd']],
      ['SaveDoc', ['mexpress', 'prd', '# x']],
      ['DeleteDoc', ['mexpress', 'prd']],
      ['DocHistory', ['mexpress', 'prd']],
      ['DocRevision', ['mexpress', 'prd', 0]],
      ['DocDiff', ['mexpress', 'prd', 1, 0]],
      ['Requirements', ['mexpress']],
      ['Coverage', ['mexpress']],
      ['AffectedCases', ['mexpress']],
      ['AckCase', ['mexpress', 'web:TC-k3x9p']],
      ['SetCaseReqs', ['mexpress', 'TC-1', ['REQ-001']]],
      ['Notes', ['mexpress']],
      ['AddNote', ['mexpress', 'REQ-001', 'r1', 'f.yaml', 'x']],
      ['ResolveNote', ['mexpress', 'n1']],
      ['Compile', [req]],
    ]);
  });

  it('lỗi Go thành ApiError có mã; vượt trần chi phí mang token để gọi lại', async () => {
    stubGo({ SaveDoc: new Error('permission_denied: cqs.run'), Compile: new Error('confirm_required: costVnd=31800,leftVnd=412000,token=abc123') });
    await expect(testApi.saveDoc('mexpress', 'prd', 'x')).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(testApi.compile({} as Parameters<typeof testApi.compile>[0])).rejects.toMatchObject({ code: 'confirm_required', params: { token: 'abc123' } });
  });

  it('core cũ chưa có hàm tài liệu: lỗi incompatible', async () => {
    stubGo({});
    await expect(testApi.docs('mexpress')).rejects.toMatchObject({ code: 'incompatible' });
  });
});

describe('tiện ích', () => {
  it('mã gõ tay và số yêu cầu theo tài liệu', () => {
    expect(parseReqList(' REQ-001, AC-02;REQ-001\nBR-3 ')).toEqual(['REQ-001', 'AC-02', 'BR-3']);
    expect(parseReqList('  ')).toEqual([]);
    expect(reqCountByDoc([{ doc: 'a' }, { doc: 'b' }, { doc: 'a' }] as Parameters<typeof reqCountByDoc>[0])).toEqual({ a: 2, b: 1 });
  });
});
