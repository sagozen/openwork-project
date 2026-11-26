// Registry component chat theo loại kết quả tool (contracts/cqs-components.json). Dữ liệu được kiểm trước khi vẽ;
// không hợp lệ hoặc loại lạ thì hiện JSON dạng chữ.
import type { ComponentType } from 'react';
import { validateComponent } from '../schema';
import { CostConfirm, ErrorCard, FlowList, JsonFallback, YamlDiff } from './cards';
import { DeviceCard, DeviceGrid, LiveScreen } from './devices';
import { AlertList, BudgetMeter, MetricChart } from './metrics';
import { DeliveryLog, ReportCard, RunProgress, TaskTimeline } from './runs';
import type { ChatActions } from './shared';

export type { ChatActions } from './shared';
export { noActions } from './shared';
export { confirmCost } from './cards';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<{ data: any; actions: ChatActions }>;

export const COMPONENTS: Record<string, AnyComponent> = {
  DeviceGrid,
  DeviceCard,
  LiveScreen,
  TaskTimeline,
  RunProgress,
  MetricChart,
  CostConfirm,
  BudgetMeter,
  AlertList,
  DeliveryLog,
  ReportCard,
  YamlDiff,
  ErrorCard,
  FlowList,
};

export function ChatComponent({ kind, data, actions }: { kind: string; data: unknown; actions: ChatActions }) {
  const C = COMPONENTS[kind];
  const reason = C ? validateComponent(kind, data) : `chưa có component cho ${kind}`;
  if (!C || reason) return <JsonFallback kind={kind} data={data} reason={reason ?? ''} />;
  return <C data={data} actions={actions} />;
}
