// Ô 3 "Hoạt động": cảnh báo, task gần đây, lượt gửi webhook gần đây. Tải lại khi task đổi trạng thái hoặc Giám sát báo đổi.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertList } from '../chat/components/metrics';
import { DeliveryLog, TaskTimeline } from '../chat/components/runs';
import type { ChatActions } from '../chat/components/shared';
import { Empty } from '../workspace/Workspace';
import { monitorApi, onMonitorChange, type Alert, type Delivery, type Task } from './bridge';

export interface ActivityData {
  alerts: Alert[];
  tasks: Task[];
  deliveries: Delivery[];
}

/** Ô Hoạt động thuần (render và test độc lập). */
export function ActivityView({ data, actions }: { data: ActivityData; actions: ChatActions }) {
  if (data.alerts.length === 0 && data.tasks.length === 0 && data.deliveries.length === 0) {
    return <Empty title="Chưa có hoạt động" text="Task đang chạy, lượt gửi webhook và báo cáo sẽ hiện ở đây." />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[8px] overflow-y-auto p-[10px]" data-testid="activity">
      {data.alerts.length > 0 && <AlertList data={data.alerts} />}
      {data.tasks.length > 0 && <TaskTimeline data={data.tasks} actions={actions} />}
      {data.deliveries.length > 0 && <DeliveryLog data={data.deliveries} />}
    </div>
  );
}

export function ActivityPane({ actions }: { actions: ChatActions }) {
  const [data, setData] = useState<ActivityData>({ alerts: [], tasks: [], deliveries: [] });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(async () => {
    const [alerts, tasks, deliveries] = await Promise.all([
      monitorApi.alerts().catch(() => []),
      monitorApi.tasks(8).catch(() => []),
      monitorApi.deliveries(5).catch(() => []),
    ]);
    setData({ alerts, tasks, deliveries });
  }, []);
  useEffect(() => {
    void load();
    // Nhiều sự kiện liền nhau (từng bước của lượt chạy, từng lượt gửi): gộp thành một lần tải sau 500 ms.
    const off = onMonitorChange(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 500);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [load]);
  return <ActivityView data={data} actions={actions} />;
}
