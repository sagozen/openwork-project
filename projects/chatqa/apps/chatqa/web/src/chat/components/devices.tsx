// DeviceGrid, DeviceCard, LiveScreen.
import { Battery, Globe, Smartphone } from 'lucide-react';
import { Button } from '@shell/components/ui';
import { deviceName, isWebDevice, isWebSetupProblem, webProblemText, webSubtitle } from '../../live/bridge';
import { WebSetupLink } from '../../live/DeviceList';
import { MetricsView } from '../../testing/MetricsPane';
import type { MetricsSummary } from '../../testing/bridge';
import { Card, Muted, StateBadge, type ChatActions } from './shared';

interface Device {
  id: string;
  platform: string;
  state: string;
  name?: string;
  model?: string;
  osVersion?: string;
  battery?: number;
  driver?: string;
  warm?: boolean;
  problem?: string;
}

function DeviceRow({ d, onSettings }: { d: Device; onSettings?: () => void }) {
  const web = isWebDevice(d);
  const Icon = web ? Globe : Smartphone;
  return (
    <li className="flex items-center gap-[8px] rounded-[8px] bg-muted-box px-[10px] py-[7px]">
      <Icon size={14} className="shrink-0 text-text-3" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px]/[16px] font-semibold text-text">{deviceName(d)}</p>
        <p className="truncate font-mono text-[11px]/[14px] text-text-3">
          {d.id} · {web ? webSubtitle(d) : `${d.platform} ${d.osVersion ?? ''}`}
          {d.problem ? ` · ${web ? webProblemText(d) : d.problem}` : ''}
        </p>
      </div>
      {onSettings && isWebSetupProblem(d) && <WebSetupLink onClick={onSettings} />}
      {d.battery !== undefined && d.battery >= 0 && (
        <span className="flex shrink-0 items-center gap-[3px] font-mono text-[11px]/[14px] text-text-2">
          <Battery size={12} />
          {d.battery}%
        </span>
      )}
      <StateBadge state={d.state} />
    </li>
  );
}

export function DeviceGrid({ data, actions }: { data: Device[]; actions?: ChatActions }) {
  const usable = data.filter((d) => d.state === 'ready' || d.state === 'connected').length;
  return (
    <Card title={`Thiết bị · ${usable}/${data.length} rảnh`}>
      {data.length === 0 ? (
        <Muted>Chưa có máy nào cắm vào máy tính này.</Muted>
      ) : (
        <ul className="grid gap-[6px] sm:grid-cols-2">
          {data.map((d) => (
            <DeviceRow key={d.id} d={d} onSettings={actions?.openSettings} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DeviceCard({ data, actions }: { data: { device: Device; metrics?: MetricsSummary }; actions: ChatActions }) {
  const d = data.device;
  return (
    <Card
      title={deviceName(d)}
      aside={
        actions.openLive ? (
          <Button size="sm" variant="secondary" onClick={() => actions.openLive?.(d.id)}>
            Xem trực tiếp
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => actions.runTool('device_screenshot', { id: d.id })}>
            Xem màn hình
          </Button>
        )
      }
    >
      <ul>
        <DeviceRow d={d} onSettings={actions.openSettings} />
      </ul>
      {data.metrics && <MetricsView summary={data.metrics} />}
    </Card>
  );
}

export function LiveScreen({ data, actions }: { data: { deviceId: string; png?: string; mime?: string; tree?: string }; actions: ChatActions }) {
  return (
    <Card
      title={`Màn hình · ${data.deviceId}`}
      aside={
        <span className="flex gap-[6px]">
          {actions.openLive && (
            <Button size="sm" variant="secondary" onClick={() => actions.openLive?.(data.deviceId)}>
              Xem trực tiếp
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => actions.runTool('device_screenshot', { id: data.deviceId })}>
            Chụp lại
          </Button>
        </span>
      }
    >
      {data.png ? (
        <img src={`data:${data.mime ?? 'image/png'};base64,${data.png}`} alt={`Màn hình ${data.deviceId}`} className="max-h-[420px] self-start rounded-[8px] border border-divider object-contain" />
      ) : data.tree ? (
        <pre className="max-h-[240px] overflow-auto rounded-[8px] bg-muted-box p-[8px] font-mono text-[10.5px]/[14px] text-text-2">{data.tree.slice(0, 4000)}</pre>
      ) : (
        <Muted>Ảnh màn hình không được lưu trong lịch sử.</Muted>
      )}
    </Card>
  );
}
