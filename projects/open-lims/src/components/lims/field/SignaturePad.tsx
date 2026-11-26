/* Ô ký tay cho BM02 - vẽ bằng pointer events trên canvas. */
import { useEffect, useRef, useState } from "react";
import { Button, Label } from "@fluentui/react-components";

interface Props {
  label: string;
  required?: boolean;
  defaultSigned?: boolean;
  onSigned?: (image: Blob) => void;
  onClear?: () => void;
}

export function SignaturePad({
  label,
  required = false,
  defaultSigned = false,
  onSigned,
  onClear,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [signed, setSigned] = useState(defaultSigned);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "currentColor";
    if (defaultSigned) {
      ctx.beginPath();
      ctx.moveTo(24, rect.height - 22);
      ctx.bezierCurveTo(60, 12, 90, rect.height - 10, 124, 26);
      ctx.bezierCurveTo(150, 46, 168, 20, 196, 34);
      ctx.stroke();
    }
  }, [defaultSigned]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    setSigned(true);
    ref.current?.toBlob((blob) => {
      if (blob) onSigned?.(blob);
    }, "image/png");
  }

  function clear() {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setSigned(false);
    onClear?.();
  }

  return (
    <div className="dlp-sign">
      <div className="dlp-sign__head">
        <Label required={required}>{label}</Label>
        <span style={{ flex: 1 }} />
        {signed ? (
          <Button size="small" appearance="subtle" onClick={clear}>
            Ký lại
          </Button>
        ) : null}
      </div>
      <canvas
        ref={ref}
        className="dlp-sign__pad"
        data-signed={signed}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <div className="dlp-sign__hint">
        {signed ? "Đã ghi nhận nét ký" : "Dùng ngón tay ký trực tiếp lên khung"}
      </div>
    </div>
  );
}
