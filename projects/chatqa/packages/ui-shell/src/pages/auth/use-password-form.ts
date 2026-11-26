import { useState, type FormEvent } from 'react';
import { platform } from '../../platform';
import { useSession } from '../../lib/session';
import { passwordView, validateNewPassword } from '../../lib/auth-ui';
import { useAction } from '../../lib/use-action';

/** Trạng thái và gửi form đổi mật khẩu, dùng chung cho màn bắt buộc và hộp tự đổi. Form giữ nguyên khi lỗi (E-007, 008, 020, 021, 024). */
export function usePasswordForm({ onDone, currentFromMemory }: { onDone?: () => void; currentFromMemory?: boolean }) {
  const { refresh, tempPassword } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<unknown>(null);

  // Màn bắt buộc: "mật khẩu hiện tại" là mật khẩu tạm vừa gõ ở màn đăng nhập (chỉ trong bộ nhớ). Mở lại app giữa chừng thì phải hỏi lại.
  const remembered = currentFromMemory ? tempPassword() : '';
  const needCurrent = !currentFromMemory || !remembered;

  // Enter và nút Lưu cùng gọi submit: đang gửi thì lần gọi tiếp bị bỏ qua (cờ trong useAction).
  const [send, busy] = useAction(async () => {
    const local = validateNewPassword(next, confirm);
    if (local) return setErr({ code: local });
    setErr(null);
    try {
      await platform.changePassword(needCurrent ? current : remembered, next, confirm);
      await refresh();
      onDone?.();
    } catch (e) {
      setErr(e);
    }
  });
  function submit(e?: FormEvent) {
    e?.preventDefault();
    return send();
  }

  const view = passwordView(err);
  return { current, next, confirm, setCurrent, setNext, setConfirm, busy, submit, view, needCurrent };
}
