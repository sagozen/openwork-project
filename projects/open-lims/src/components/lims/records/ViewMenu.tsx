import { Badge, Button } from "@fluentui/react-components";
import { Checkmark16Regular } from "@fluentui/react-icons";
import { VIEW_GROUPS } from "@/lib/admin/records-view-data";
import type { RecordsView } from "@/lib/admin/records-view-state";

export function ViewMenu({
  view,
  onClose,
  onSaveNew,
  showCounts = true,
}: {
  view: RecordsView;
  onClose: () => void;
  onSaveNew: () => void;
  /** Tắt khi số phiếu của từng chế độ xem chưa có nguồn thật để hiển thị. */
  showCounts?: boolean;
}) {
  return (
    <>
      {VIEW_GROUPS.map((g) => {
        const items = view.allViews.filter((v) => v.group === g);
        if (!items.length) return null;
        return (
          <div key={g}>
            <div className="dlp-menugroup">{g}</div>
            {items.map((v) => (
              <button
                key={v.id}
                type="button"
                className="dlp-menuitem"
                aria-checked={v.id === view.state.viewId}
                role="menuitemradio"
                onClick={() => {
                  view.pickView(v);
                  onClose();
                }}
              >
                <span style={{ width: 16, color: "var(--foreground-brand)" }}>
                  {v.id === view.state.viewId ? <Checkmark16Regular /> : null}
                </span>
                <span style={{ flex: 1 }}>{v.name}</span>
                {view.defaultViewId === v.id ? (
                  <Badge appearance="tint" color="brand" size="small">
                    Mặc định
                  </Badge>
                ) : null}
                <span className="dlp-datagrid__secondary">{showCounts ? v.count || "" : ""}</span>
              </button>
            ))}
          </div>
        );
      })}
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          paddingTop: 6,
          marginTop: 6,
          display: "grid",
          gap: 2,
        }}
      >
        <Button appearance="subtle" onClick={onSaveNew}>
          Lưu thành chế độ xem mới…
        </Button>
        <Button
          appearance="subtle"
          onClick={() => {
            view.resetView();
            onClose();
          }}
        >
          Khôi phục mặc định
        </Button>
      </div>
    </>
  );
}
