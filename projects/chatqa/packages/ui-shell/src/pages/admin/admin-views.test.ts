import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import limits from '@contracts/limits.json';
import permissions from '@contracts/permissions.json';
import type { AdminDevice, AdminUser, PendingOp } from './admin-api';
import { avgPerCall, aiState, budgetPercent, ceilingVnd, hasRulesCeiling, maskedKey, modelLabel, monthNumber, parseCeilingPercent, PROVIDER_LABEL, usageLine, usd, vnd, type AiSettings } from './ai-format';
import { RulesCeiling } from './AiPanels';
import { freeAfterRevoke, leftText, offlineDays, seatSegments, usedText } from './devices-view';
import { GROUP_NOTE, MATRIX_COLUMNS, PERM_COPY, permCopy } from './matrix-copy';
import { oldestText, opText, pendingTitle, reasonText } from './pending-format';
import { createBody, createProblems, editImpact, editPatch, emptyForm, formFromUser, isDemotion, roleOptions, suggestTempPassword, appsBody } from './user-form';
import { adminTabOn } from './admin-tabs';
import { canUnlock, filterUsers, userTag, visibleUsers } from './users-view';
import { isPlainClick, routeOfHref } from './unsaved-guard';

const user = (over: Partial<AdminUser>): AdminUser => ({
  id: 'u', username: 'u', display_name: 'U', role: 'staff', status: 'active', apps: null, is_deployer: false, must_change_pw: false, temp_pw_expires_at: null,
  locked_at: null, temp_locked_until: null, last_login_at: null, last_device: null, created_at: 0, ...over,
});
const dev = (status: AdminDevice['status']): AdminDevice => ({ id: status, name: status, app_version: null, activated_at: 0, last_seen: 0, revoked: status === 'revoked' ? 1 : 0, revoked_at: null, key_hint: '', last_user_id: null, last_user_name: null, status });
const LIC = ['quote', 'lot', 'check', 'teach'] as const;

describe('biểu mẫu người dùng', () => {
  it('mặc định chọn hết app đã kích hoạt và gửi apps = null ("mọi app")', () => {
    const f = { ...emptyForm([...LIC]), username: ' NguyenVy ', displayName: ' Nguyễn Thảo Vy ', password: 'Vy-7429-tam' };
    expect(f.apps).toEqual([...LIC]);
    expect(createBody(f, [...LIC])).toEqual({ username: 'nguyenvy', displayName: 'Nguyễn Thảo Vy', role: 'staff', apps: null, isDeployer: undefined, password: 'Vy-7429-tam' });
    expect(appsBody(['quote', 'check'], [...LIC])).toEqual(['quote', 'check']);
  });

  it('vai Vipo không có app nội bộ (BR-013)', () => {
    expect(createBody({ ...emptyForm([...LIC]), username: 'vipo.a', role: 'vipo', password: '12345678' }, [...LIC]).apps).toEqual([]);
  });

  it('kiểm tra trước khi gọi máy chủ: tên đăng nhập, mật khẩu tạm >= 8, Bên triển khai phải là Admin', () => {
    const base = { ...emptyForm([...LIC]), username: 'nguyenvy', password: 'Vy-7429-tam' };
    expect(createProblems(base)).toEqual({ username: null, password: null, deployer: null });
    expect(createProblems({ ...base, username: 'Vy' }).username).toBe('invalid_input');
    expect(createProblems({ ...base, username: 'có dấu' }).username).toBe('invalid_input');
    expect(createProblems({ ...base, password: 'ngan' }).password).toBe('weak_password');
    expect(createProblems({ ...base, isDeployer: true }).deployer).toBe('invalid_input');
    expect(createProblems({ ...base, isDeployer: true, role: 'admin' }).deployer).toBeNull();
  });

  it('sửa: chỉ gửi trường đổi; không đổi gì thì null', () => {
    const tl = user({ id: 'u-tran-lan', username: 'tranlan', display_name: 'Trần Lan', role: 'manager' });
    const f = formFromUser(tl, [...LIC]);
    expect(editPatch(tl, f, [...LIC])).toBeNull();
    expect(editPatch(tl, { ...f, displayName: 'Trần Thị Lan' }, [...LIC])).toEqual({ displayName: 'Trần Thị Lan' });
    expect(editPatch(tl, { ...f, role: 'staff', apps: ['quote', 'check', 'teach'] }, [...LIC])).toEqual({ role: 'staff', apps: ['quote', 'check', 'teach'] });
  });

  it('hạ vai và bỏ app => cần cảnh báo FR-009 (không chặn lưu)', () => {
    const tl = user({ role: 'manager' });
    const f = formFromUser(tl, [...LIC]);
    expect(editImpact(tl, f, [...LIC]).needsPreflight).toBe(false);
    expect(editImpact(tl, { ...f, role: 'staff' }, [...LIC])).toMatchObject({ demoted: true, needsPreflight: true });
    expect(editImpact(tl, { ...f, role: 'leader' }, [...LIC]).demoted).toBe(true);
    expect(editImpact(tl, { ...f, role: 'admin' }, [...LIC]).demoted).toBe(false);
    expect(editImpact(tl, { ...f, apps: ['quote', 'check', 'teach'] }, [...LIC])).toMatchObject({ demoted: false, removedApps: ['lot'], needsPreflight: true });
    expect(isDemotion('admin', 'manager')).toBe(true);
    expect(isDemotion('staff', 'vipo')).toBe(true);
    expect(isDemotion('vipo', 'staff')).toBe(false);
  });

  it('mật khẩu tạm gợi ý: tên cuối bỏ dấu + 4 số + "tam", luôn đủ 8 ký tự', () => {
    expect(suggestTempPassword('Nguyễn Thảo Vy', () => '7429')).toBe('Vy-7429-tam');
    expect(suggestTempPassword('Lê Hà', () => '5183')).toBe('Ha-5183-tam');
    expect(suggestTempPassword('', () => '0001')).toBe('Hs-0001-tam');
    expect(suggestTempPassword('Vy').length).toBeGreaterThanOrEqual(8);
    expect(suggestTempPassword('Vy')).toMatch(/^Vy-\d{4}-tam$/);
  });
});

describe('danh sách người dùng', () => {
  const list = [user({ id: 'a', role: 'admin' }), user({ id: 'b', role: 'staff', status: 'locked' }), user({ id: 'c', role: 'staff', status: 'temp_locked' }), user({ id: 'd', role: 'admin', is_deployer: true })];

  it('lọc theo vai và trạng thái', () => {
    expect(filterUsers(list, 'all', 'all')).toHaveLength(4);
    expect(filterUsers(list, 'admin', 'all').map((u) => u.id)).toEqual(['a', 'd']);
    expect(filterUsers(list, 'staff', 'locked').map((u) => u.id)).toEqual(['b']);
    expect(filterUsers(list, 'all', 'temp_locked').map((u) => u.id)).toEqual(['c']);
  });

  it('ChatQASoftware không bày tài khoản vai Vipo của HS Desk, HS Desk vẫn thấy', () => {
    const mixed = [user({ id: 'a', role: 'admin' }), user({ id: 'v', role: 'vipo' }), user({ id: 's', role: 'staff' })];
    expect(visibleUsers(mixed, 'chatqa').map((u) => u.id)).toEqual(['a', 's']);
    expect(visibleUsers(mixed, 'hsdesk').map((u) => u.id)).toEqual(['a', 'v', 's']);
    // Phiên cũ còn vai 'owner' (= admin) vẫn hiện.
    expect(visibleUsers([user({ id: 'o', role: 'owner' })], 'chatqa').map((u) => u.id)).toEqual(['o']);
  });

  it('tag dưới tên và mở khoá (không có Xoá)', () => {
    expect(userTag(list[3])).toBe('deployer');
    expect(userTag(list[1])).toBe('locked');
    expect(userTag(list[0])).toBeUndefined();
    expect(canUnlock(list[1])).toBe(true);
    expect(canUnlock(list[2])).toBe(false);
  });
});

describe('bảng quyền: chữ hiển thị', () => {
  it('mọi quyền trong contract đều có chữ ngắn; chỉ 2 dòng đầu Quản trị khoá', () => {
    for (const p of permissions.permissions) expect(PERM_COPY[p.code], p.code).toBeDefined();
    expect(permissions.permissions.filter((p) => p.locked).map((p) => p.code)).toEqual(['admin.accounts', 'admin.drive']);
    expect(permissions.permissions.find((p) => p.code === 'admin.ai_budget')?.locked).toBe(false);
  });

  it('nhóm hiện đủ, ghi chú nhóm Quản trị đúng bản sau rà soát', () => {
    expect(MATRIX_COLUMNS.flat()).toEqual(permissions.groups);
    expect(GROUP_NOTE['Quản trị']).toBe('2 dòng đầu chỉ admin có');
    expect(PERM_COPY['work.do'].sub).toContain('sửa, gỡ bài học của mình khi Chưa rà soát. Xuất tệp chỉ người giữ lô.');
  });

  it('quyền mới chưa có chữ ngắn thì dùng nhãn đầy đủ của contract (không mất dòng)', () => {
    expect(permCopy('khong.co').label).toBe('khong.co');
    expect(permCopy('report.view').label).toBe('Xem báo cáo');
  });

  it('ChatQASoftware không bày vai Vipo và không có tab Chờ công nhận của HS Desk', () => {
    expect(roleOptions('chatqa').map((o) => o.key)).toEqual(['admin', 'manager', 'leader', 'staff']);
    expect(roleOptions('hsdesk').map((o) => o.key)).toContain('vipo');
    expect(adminTabOn('pending', 'chatqa')).toBe(false);
    expect(adminTabOn('pending', 'hsdesk')).toBe(true);
    expect(adminTabOn('users', 'chatqa')).toBe(true);
    expect(adminTabOn('drive', 'chatqa')).toBe(false);
    expect(adminTabOn('drive', 'hsdesk')).toBe(true);
  });
});

describe('máy & bản quyền', () => {
  it('thanh chỗ: 5 đang dùng, 1 quá hạn, 1 trống; máy thu hồi không chiếm chỗ', () => {
    const devices = [dev('in_use'), dev('in_use'), dev('in_use'), dev('in_use'), dev('in_use'), dev('offline_overdue'), dev('revoked')];
    expect(seatSegments(7, devices)).toEqual(['in_use', 'in_use', 'in_use', 'in_use', 'in_use', 'overdue', 'free']);
    expect(usedText({ used: 6, maxDevices: 7 })).toBe('Đã dùng 6/7 máy');
    expect(leftText({ used: 6, maxDevices: 7 })).toBe('còn 1 máy');
    expect(freeAfterRevoke({ used: 6, maxDevices: 7 })).toBe(2);
    expect(offlineDays(168)).toBe(7);
  });

  it('vượt số máy (dữ liệu lệch) vẫn vẽ đủ ô, không tràn âm', () => {
    expect(seatSegments(2, [dev('in_use'), dev('in_use'), dev('in_use')])).toHaveLength(3);
    expect(leftText({ used: 9, maxDevices: 7 })).toBe('còn 0 máy');
  });
});

describe('thao tác chờ: chữ hiển thị', () => {
  const op = (over: Partial<PendingOp>): PendingOp => ({ id: 'a', user_id: 'u', user_name: null, user_locked: false, device_id: null, device_name: null, op: null, device_time: 100, created_at: 1, reason: 'demoted_offline', status: 'pending', decided_by_name: null, decided_at: null, ...over });

  it('lý do chờ theo mã của Worker', () => {
    expect(reasonText('demoted_offline').text).toBe('Bị hạ vai khi máy đang mất mạng');
    expect(reasonText('locked_offline').icon).toBe('locked');
    expect(reasonText('revoked_device').icon).toBe('device');
    expect(reasonText('lạ').text).toBe('lạ');
  });

  it('tên thao tác: ưu tiên mô tả của máy, nếu không thì tên quyền và app', () => {
    expect(opText({ perm: 'lot.criteria', app: 'lot', label: 'Gộp 12 dòng vào lô', object: 'LO-2611-021' })).toEqual({ name: 'Gộp 12 dòng vào lô', object: 'LO-2611-021' });
    expect(opText({ perm: 'report.view', app: 'check' })).toEqual({ name: 'Xem báo cáo', object: 'App 03 · Kiểm tra & khai báo' });
    expect(opText(null)).toEqual({ name: 'Thao tác', object: '' });
  });

  it('tiêu đề và dòng cũ nhất', () => {
    const t = (s: string) => Math.floor(new Date(`${s.replace(' ', 'T')}:00+07:00`).getTime() / 1000);
    expect(pendingTitle(3)).toBe('3 thao tác đang chờ');
    expect(pendingTitle(0)).toBe('Không có thao tác nào đang chờ');
    expect(oldestText([op({ device_time: t('2026-11-03 15:22') }), op({ device_time: t('2026-10-20 11:30') })])).toBe('Cũ nhất: 20/10 11:30');
    expect(oldestText([])).toBe('');
  });
});

describe('dịch vụ AI', () => {
  const s = (over: Partial<AiSettings> = {}): AiSettings => ({ provider: 'alibaba', providers: ['alibaba', 'fal'], model: 'flash', models: ['flash', 'plus'], hasKey: true, keyHint: '3f9a', budgetVnd: 500000, month: '2026-11', usage: { calls: 3920, tokens_in: 0, tokens_out: 0, cost_vnd: 186400, costVnd: 186400 }, ...over });

  it('số liệu như khung D7XS6', () => {
    expect(vnd(186400)).toBe('186.400');
    expect(vnd(500000)).toBe('500.000');
    expect(monthNumber('2026-11')).toBe('11');
    expect(avgPerCall(s().usage)).toBe(48);
    expect(Math.round(budgetPercent(186400, 500000))).toBe(37);
    expect(maskedKey('3f9a')).toBe('sk-••••••••••3f9a');
    expect(maskedKey('3f9a', 'fal')).toBe('••••••••••3f9a');
    expect(maskedKey(null)).toBe('Chưa có khoá');
  });

  it('nhãn gói đổi theo nhà cung cấp: Qwen bên Alibaba, model OpenRouter bên fal.ai', () => {
    expect(PROVIDER_LABEL.alibaba).toBe('Alibaba Cloud Model Studio · Qwen');
    expect(PROVIDER_LABEL.fal).toBe('fal.ai · OpenRouter');
    expect(modelLabel('alibaba', 'flash')).toBe('Qwen3-VL-Flash');
    expect(modelLabel('fal', 'flash')).toBe('Qwen3-VL 30B-A3B');
    expect(modelLabel('fal', 'plus')).toBe('Qwen3-VL 235B-A22B');
  });

  it('dòng lượt dùng: HS Desk đếm mặt hàng, ChatQASoftware đếm lượt gọi AI', () => {
    expect(usageLine(s().usage, 'hsdesk')).toBe('3.920 lượt phân tích · trung bình 48 VNĐ / mặt hàng');
    expect(usageLine(s().usage, 'chatqa')).toBe('3.920 lượt gọi AI · trung bình 48 VNĐ / lượt');
  });

  it('trạng thái: chưa có khoá, hết ngân sách, hoạt động', () => {
    expect(aiState(s()).label).toBe('Hoạt động');
    expect(aiState(s({ hasKey: false })).label).toBe('Chưa có khoá');
    expect(aiState(s({ usage: { ...s().usage, costVnd: 500000 } })).label).toBe('Hết ngân sách');
    // Model cloud (ChatQASoftware): chưa có khoá riêng vẫn chạy bằng credit; hết credit thì báo đỏ.
    const cloud = { active: true, creditUsd: 3, grantedUsd: 5, usedUsd: 2 };
    expect(aiState(s({ hasKey: false, cloud }))).toEqual({ tone: 'green', label: 'Model cloud' });
    expect(aiState(s({ hasKey: false, cloud: { ...cloud, creditUsd: 0 } }))).toEqual({ tone: 'red', label: 'Hết credit' });
    expect(aiState(s({ cloud: { ...cloud, active: false } })).label).toBe('Hoạt động');
    expect(usd(4.5)).toBe('$4.50');
    expect(budgetPercent(10, 0)).toBe(100);
  });
});

describe('trần cho chạy thử và kiểm trùng quy tắc', () => {
  const s = (over: Partial<AiSettings> = {}): AiSettings => ({ provider: 'alibaba', providers: ['alibaba', 'fal'], model: 'flash', models: ['flash'], hasKey: true, keyHint: null, budgetVnd: 500000, month: '2026-11', usage: { calls: 0, tokens_in: 0, tokens_out: 0, cost_vnd: 0, costVnd: 0 }, rulesBudgetPercent: 20, rulesBudgetPercentDefault: limits.rulesAiBudgetPercent, ...over });

  it('chỉ nhận số nguyên 1..100', () => {
    expect(parseCeilingPercent('1')).toBe(1);
    expect(parseCeilingPercent(' 100 ')).toBe(100);
    for (const bad of ['0', '101', '-5', '12.5', '12,5', 'abc', '']) expect(parseCeilingPercent(bad), bad).toBeNull();
  });

  it('chỉ HS Desk có sổ quy tắc; số tiền theo % ngân sách tháng', () => {
    expect(hasRulesCeiling('hsdesk')).toBe(true);
    expect(hasRulesCeiling('chatqa')).toBe(false);
    expect(ceilingVnd(500000, 20)).toBe(100000);
    expect(limits.rulesAiBudgetPercent).toBe(20);
  });

  it('đang dùng mặc định: nhãn "mặc định", không có "Về mặc định"; đặt riêng thì có "Về mặc định (20%)"', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const def = renderToStaticMarkup(createElement(RulesCeiling, { settings: s(), onSave }));
    expect(def).toContain('Trần cho chạy thử và kiểm trùng quy tắc (% ngân sách tháng)');
    expect(def).toContain('20%');
    expect(def).toContain('≈ 100.000 VNĐ / tháng');
    expect(def).toContain('mặc định');
    expect(def).not.toContain('Về mặc định');
    const own = renderToStaticMarkup(createElement(RulesCeiling, { settings: s({ rulesBudgetPercent: 35 }), onSave }));
    expect(own).toContain('35%');
    expect(own).toContain('Về mặc định (20%)');
  });
});

describe('chặn rời trang khi còn thay đổi chưa lưu', () => {
  it('đích điều hướng từ liên kết (BrowserRouter và HashRouter)', () => {
    expect(routeOfHref('http://x.test/cai-dat/may', 'http://x.test')).toBe('/cai-dat/may');
    expect(routeOfHref('http://x.test/#/cai-dat/may', 'http://x.test')).toBe('/cai-dat/may');
    expect(routeOfHref('/luu-tru?a=1', 'http://x.test')).toBe('/luu-tru?a=1');
  });

  it('liên kết ngoài hoặc mở tab mới không bị chặn', () => {
    expect(routeOfHref('https://khac.test/x', 'http://x.test')).toBeNull();
    expect(routeOfHref('/cai-dat/may', 'http://x.test', '_blank')).toBeNull();
  });

  it('bấm kèm phím bổ trợ hoặc không phải chuột trái thì bỏ qua', () => {
    expect(isPlainClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(isPlainClick({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isPlainClick({ button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
  });
});
