// Nút "Chạy pipeline" trên màn Git impact: chạy pipeline sau deploy (diff → chọn flow → chạy iOS/Android → phân loại
// lỗi → báo cáo) bằng đội agent ADK rồi mở phiên đó ở khung chat. Chỉ hiện khi đang dùng engine adk.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Workflow } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { useOptionalAgentChat } from './AgentChatPane';

/** Phần vẽ thuần (test độc lập). */
export function PipelineButtonView({ disabled, busy, onRun }: { disabled: boolean; busy: boolean; onRun: () => void }) {
  return (
    <Button variant="secondary" disabled={disabled || busy} onClick={onRun} icon={<Workflow size={15} />} data-testid="run-pipeline">
      {busy ? 'Đang mở pipeline…' : 'Chạy pipeline'}
    </Button>
  );
}

/** Nút chạy pipeline cho repo + 2 commit đang nhập; lỗi báo qua onError (thường là toast của màn). */
export function PipelineButton({ repo, from, to, disabled, onError }: { repo: string; from: string; to: string; disabled: boolean; onError: (e: unknown) => void }) {
  const chat = useOptionalAgentChat();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!chat) return null;
  const run = async () => {
    setBusy(true);
    try {
      await chat.startPipeline(repo, from, to);
      navigate('/'); // khung chat hiện phiên pipeline đang chạy
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return <PipelineButtonView disabled={disabled} busy={busy} onRun={() => void run()} />;
}
