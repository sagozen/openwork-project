// Xử lý văn bản ariaSnapshot({mode:'ai', boxes:true}): đổi [box=x,y,w,h] (px CSS) sang toạ độ chuẩn hoá
// theo viewport (cùng nghĩa với toạ độ tap trên điện thoại), lọc theo truy vấn và rút gọn khi quá dài.
// Định dạng snapshot không được đặc tả, nên chỉ đụng tới phần [box=...] và thụt lề.

const BOX = /\[box=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

// normalizeBoxes: hộp của phần tử trong iframe được Playwright tính theo khung iframe, nên cộng dồn gốc
// của các iframe tổ tiên (theo thụt lề) trước khi chia cho viewport. Phần tử ngoài màn hình cho giá trị
// ngoài 0..1, giữ nguyên để biết nó nằm đâu.
export function normalizeBoxes(text, width, height) {
  if (!(width > 0) || !(height > 0)) return text;
  const frames = []; // {indent, ox, oy}
  return String(text)
    .split('\n')
    .map((line) => {
      const indent = indentOf(line);
      while (frames.length && indent <= frames[frames.length - 1].indent) frames.pop();
      const m = BOX.exec(line);
      if (!m) return line;
      const top = frames[frames.length - 1] ?? { ox: 0, oy: 0 };
      const x = Number(m[1]) + top.ox;
      const y = Number(m[2]) + top.oy;
      const w = Number(m[3]);
      const h = Number(m[4]);
      if (/^\s*- iframe\b/.test(line)) frames.push({ indent, ox: x, oy: y });
      return line.replace(BOX, `[box=${round(x / width)},${round(y / height)},${round(w / width)},${round(h / height)}]`);
    })
    .join('\n');
}

// filterSnapshot: chỉ giữ dòng chứa query (không phân biệt hoa thường) cùng các dòng tổ tiên của chúng,
// để kết quả vẫn đọc được như một cây.
export function filterSnapshot(text, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return text;
  const lines = String(text).split('\n');
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(q)) continue;
    keep[i] = true;
    let indent = indentOf(lines[i]);
    for (let j = i - 1; j >= 0 && indent > 0; j--) {
      const ind = indentOf(lines[j]);
      if (ind < indent) {
        keep[j] = true;
        indent = ind;
      }
    }
  }
  return lines.filter((_, i) => keep[i]).join('\n');
}

// compactSnapshot: quá max ký tự thì chỉ giữ dòng có ref và tên (chuỗi trong ngoặc kép), rồi cắt cứng.
export function compactSnapshot(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  const kept = s
    .split('\n')
    .filter((l) => l.includes('[ref=') && l.includes('"'))
    .join('\n');
  if (kept.length <= max) return kept;
  return kept.slice(0, max) + '\n…';
}
