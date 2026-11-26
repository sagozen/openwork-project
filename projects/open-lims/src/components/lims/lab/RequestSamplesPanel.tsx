import { Link } from "@tanstack/react-router";
import type { AnalysisTask } from "@/features/lab/types/lab";
import type { SampleDetail } from "@/features/reception/types";

const BLANK = "—";

export function RequestSamplesPanel({
  sample,
  tasks,
  requestCode,
}: {
  sample: SampleDetail;
  tasks: AnalysisTask[];
  requestCode?: string;
}) {
  return (
    <section className="dlp-card" style={{ padding: 16 }}>
      <h3>
        Hồ sơ {requestCode} · Mẫu {sample.code}
      </h3>
      <p>
        {sample.status.name} · {tasks.length} chỉ tiêu
      </p>
      <table className="dlp-datagrid">
        <thead>
          <tr>
            <th>Chỉ tiêu</th>
            <th>Người phụ trách</th>
            <th>Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.code}>
              <td>
                <Link to="/nhap-ket-qua" search={{ code: task.sampleCode ?? sample.code }}>
                  {task.parameter.name}
                </Link>
              </td>
              <td>{task.assignee?.fullName ?? BLANK}</td>
              <td>{task.status.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!tasks.length ? <p>Chưa có công việc phân tích.</p> : null}
      <p>Trị số được xem theo quyền tại màn kết quả mẫu hoặc phiếu đã phát hành.</p>
    </section>
  );
}
