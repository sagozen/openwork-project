// Chọn khung chat theo agent.engine trong agent.yaml: legacy = ChatPane cũ, adk = đội agent ADK.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ChatInput, ChatTranscript } from '../chat/ChatPane';
import { agentApi } from './bridge';
import { AgentChatProvider, AgentInput, AgentTranscript } from './AgentChatPane';

export type Engine = 'legacy' | 'adk';

const EngineCtx = createContext<Engine>('legacy');

/** Engine đang dùng; mặc định legacy cho tới khi đọc được cấu hình, nên máy chưa bật agent không đổi gì. */
export const useEngine = () => useContext(EngineCtx);

/**
 * Đọc agent.yaml một lần khi mở màn làm việc. `engine` truyền sẵn (test, hoặc nơi đã biết) bỏ qua lần đọc.
 * AgentChatProvider chỉ dựng khi engine là adk, để chế độ cũ không gọi gì thêm sang Go.
 */
export function EngineProvider({ children, engine: forced }: { children: ReactNode; engine?: Engine }) {
  const [engine, setEngine] = useState<Engine>(forced ?? 'legacy');
  useEffect(() => {
    if (forced) return setEngine(forced);
    let live = true;
    void agentApi.status().then(
      (s) => live && setEngine(s.enabled && s.engine === 'adk' ? 'adk' : 'legacy'),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [forced]);
  return (
    <EngineCtx.Provider value={engine}>
      <ChatSurfaceProvider engine={engine}>{children}</ChatSurfaceProvider>
    </EngineCtx.Provider>
  );
}

function ChatSurfaceProvider({ engine, children }: { engine: Engine; children: ReactNode }) {
  return engine === 'adk' ? <AgentChatProvider>{children}</AgentChatProvider> : <>{children}</>;
}

/** Khung chat dùng cho một engine: 'agent' = đội agent ADK, 'classic' = chat cũ. */
export const surfaceFor = (engine: Engine): 'agent' | 'classic' => (engine === 'adk' ? 'agent' : 'classic');

/** Khung giữa của route "/" : chat của engine đang chọn. */
export function ChatSurface() {
  return surfaceFor(useEngine()) === 'agent' ? <AgentTranscript /> : <ChatTranscript />;
}

/** Thanh lệnh dưới màn làm việc của engine đang chọn. */
export function ChatBar() {
  return surfaceFor(useEngine()) === 'agent' ? <AgentInput /> : <ChatInput />;
}
