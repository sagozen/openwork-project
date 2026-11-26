// Form nhận license miễn phí 1 năm: gửi email, Worker cấp công ty + license và gửi thông tin đăng nhập vào đúng email đó.
// Email đã đăng ký gửi lại khi license sắp hết hạn (hoặc đã hết) thì được gia hạn thêm 1 năm, Worker báo hạn mới qua thư.
import { useState, type FormEvent } from 'react';
import { CheckCircle2, Mail } from 'lucide-react';
import { PRODUCT } from '@product/product';

const ERRORS: Record<string, string> = {
  invalid_input: 'Kiểm tra lại họ tên và email (email phải đúng định dạng).',
  already_requested: 'Email này đã nhận license. Kiểm tra hộp thư (kể cả thư rác) hoặc liên hệ để được hỗ trợ.',
  rate_limited: 'Có quá nhiều yêu cầu từ mạng của bạn hôm nay. Thử lại sau.',
  email_unavailable: 'Chức năng gửi thư tạm chưa sẵn sàng. Vui lòng liên hệ để nhận license.',
  email_failed: 'Chưa gửi được thư. Kiểm tra email rồi thử lại sau ít phút.',
};

const day = (unixSec: number) => new Date(unixSec * 1000).toLocaleDateString('vi-VN');

export function TrialForm({ contact }: { contact: string }) {
  const [state, setState] = useState<{ kind: 'idle' | 'sending' } | { kind: 'done'; renewedUntil?: number } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const [sentTo, setSentTo] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') ?? '').trim();
    setState({ kind: 'sending' });
    try {
      const r = await fetch('/api/v1/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: PRODUCT.code, email, name: String(f.get('name') ?? ''), company: String(f.get('company') ?? '') }),
      });
      const data = (await r.json().catch(() => null)) as { error?: string; renewed?: boolean; expiresAt?: number; renewFrom?: number } | null;
      if (r.ok) {
        setSentTo(email);
        setState({ kind: 'done', renewedUntil: data?.renewed ? data.expiresAt : undefined });
        return;
      }
      const code = data?.error ?? '';
      if (code === 'already_requested' && data?.renewFrom) {
        setState({ kind: 'error', message: `Email này đã có license còn hạn. Gia hạn miễn phí được từ ngày ${day(data.renewFrom)}.` });
        return;
      }
      setState({ kind: 'error', message: ERRORS[code] ?? `Chưa gửi được yêu cầu. Liên hệ ${contact}.` });
    } catch {
      setState({ kind: 'error', message: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.' });
    }
  }

  if (state.kind === 'done') {
    return (
      <div role="status" className="flex items-start gap-[12px] rounded-[12px] bg-green-soft p-[18px] text-[13.5px]/[21px] text-text">
        <CheckCircle2 size={20} className="mt-[1px] shrink-0 text-green" />
        {state.renewedUntil ? (
          <p>
            Đã gia hạn license tới <b>{day(state.renewedUntil)}</b> và gửi thư xác nhận tới <b>{sentTo}</b>. License Key giữ nguyên.
          </p>
        ) : (
          <p>
            Đã gửi License Key và thông tin đăng nhập tới <b>{sentTo}</b>. Nếu chưa thấy thư sau vài phút, kiểm tra thư rác.
          </p>
        )}
      </div>
    );
  }

  const input = 'h-[42px] w-full rounded-[9px] bg-surface px-[12px] text-[14px] text-text shadow-[inset_0_0_0_1px_var(--color-border)] outline-none focus:shadow-[inset_0_0_0_2px_var(--color-accent)]';
  return (
    <form onSubmit={submit} className="grid gap-[12px] sm:grid-cols-2" noValidate>
      <label className="text-[12.5px]/[16px] font-semibold text-text-2">
        Họ tên
        <input name="name" required minLength={2} maxLength={80} autoComplete="name" className={`${input} mt-[5px]`} />
      </label>
      <label className="text-[12.5px]/[16px] font-semibold text-text-2">
        Email nhận license
        <input name="email" type="email" required maxLength={254} autoComplete="email" className={`${input} mt-[5px]`} />
      </label>
      <label className="text-[12.5px]/[16px] font-semibold text-text-2 sm:col-span-2">
        Công ty / đội kiểm thử (không bắt buộc)
        <input name="company" maxLength={80} autoComplete="organization" className={`${input} mt-[5px]`} />
      </label>
      <div className="flex flex-wrap items-center gap-[12px] sm:col-span-2">
        <button
          type="submit"
          disabled={state.kind === 'sending'}
          className="inline-flex h-[44px] items-center gap-[8px] rounded-[9px] bg-accent px-[20px] text-[14px]/[18px] font-semibold text-white transition-[filter] hover:brightness-95 disabled:opacity-60"
        >
          <Mail size={16} />
          {state.kind === 'sending' ? 'Đang gửi…' : 'Nhận license 1 năm miễn phí'}
        </button>
        {state.kind === 'error' ? (
          <p role="alert" className="text-[13px]/[19px] font-medium text-red">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
