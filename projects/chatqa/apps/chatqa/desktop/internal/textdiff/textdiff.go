// Package textdiff: so dòng và gộp ba chiều cho văn bản nhỏ (flow, tài liệu nghiệp vụ, tệp đồng bộ). Gói lá, không phụ
// thuộc gói nào trong app.
package textdiff

import (
	"strings"
)

// maxCells: bảng LCS lớn hơn n·m ô thì không so theo dòng nữa (tránh tốn bộ nhớ/CPU với tệp vài MB).
const maxCells = 4_000_000

// Dấu xung đột trong kết quả Merge3.
const (
	MarkerMine   = "<<<<<<< của tôi"
	MarkerSep    = "======="
	MarkerTheirs = ">>>>>>> của họ"
)

type opKind byte

const (
	opEqual opKind = iota
	opAdd
	opDel
)

type op struct {
	kind opKind
	i, j int // vị trí trong x (equal/del) và y (equal/add)
}

// lcsOps: so theo dãy con chung dài nhất, cùng thứ tự ưu tiên (+ trước - khi hoà) như bản so dòng cũ của testengine.
func lcsOps(x, y []string) []op {
	n, m := len(x), len(y)
	lcs := make([][]int32, n+1)
	for i := range lcs {
		lcs[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if x[i] == y[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	ops := make([]op, 0, max(n, m))
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && x[i] == y[j]:
			ops = append(ops, op{opEqual, i, j})
			i, j = i+1, j+1
		case j < m && (i == n || lcs[i][j+1] >= lcs[i+1][j]):
			ops = append(ops, op{opAdd, i, j})
			j++
		default:
			ops = append(ops, op{opDel, i, j})
			i++
		}
	}
	return ops
}

// commonEnds: số phần tử chung ở đầu và ở cuối (không chồng nhau).
func commonEnds(x, y []string) (pre, suf int) {
	for pre < len(x) && pre < len(y) && x[pre] == y[pre] {
		pre++
	}
	for suf < len(x)-pre && suf < len(y)-pre && x[len(x)-1-suf] == y[len(y)-1-suf] {
		suf++
	}
	return pre, suf
}

// Lines: diff theo dòng, mỗi dòng ra một dòng "  " (giữ), "+ " (thêm) hoặc "- " (bỏ). Văn bản lớn (n·m > maxCells)
// bỏ phần chung đầu/cuối rồi so theo khối (tiêu đề, mục danh sách, đoạn) thay vì theo dòng.
func Lines(a, b string) string {
	x, y := strings.Split(a, "\n"), strings.Split(b, "\n")
	var out strings.Builder
	if len(x)*len(y) <= maxCells {
		writeOps(&out, x, y, lcsOps(x, y))
		return out.String()
	}
	pre, suf := commonEnds(x, y)
	for _, l := range x[:pre] {
		out.WriteString("  " + l + "\n")
	}
	mx, my := x[pre:len(x)-suf], y[pre:len(y)-suf]
	if len(mx)*len(my) <= maxCells {
		writeOps(&out, mx, my, lcsOps(mx, my))
	} else {
		writeBlocks(&out, mx, my)
	}
	for _, l := range x[len(x)-suf:] {
		out.WriteString("  " + l + "\n")
	}
	return out.String()
}

func writeOps(out *strings.Builder, x, y []string, ops []op) {
	for _, o := range ops {
		switch o.kind {
		case opEqual:
			out.WriteString("  " + x[o.i] + "\n")
		case opAdd:
			out.WriteString("+ " + y[o.j] + "\n")
		default:
			out.WriteString("- " + x[o.i] + "\n")
		}
	}
}

// writeBlocks: so theo khối; còn quá lớn thì in bỏ hết rồi thêm hết.
func writeBlocks(out *strings.Builder, x, y []string) {
	bx, by := splitBlocks(x), splitBlocks(y)
	if len(bx)*len(by) > maxCells {
		writeLines(out, "- ", x)
		writeLines(out, "+ ", y)
		return
	}
	kx, ky := blockKeys(bx), blockKeys(by)
	for _, o := range lcsOps(kx, ky) {
		switch o.kind {
		case opEqual:
			writeLines(out, "  ", bx[o.i])
		case opAdd:
			writeLines(out, "+ ", by[o.j])
		default:
			writeLines(out, "- ", bx[o.i])
		}
	}
}

func writeLines(out *strings.Builder, prefix string, lines []string) {
	for _, l := range lines {
		out.WriteString(prefix + l + "\n")
	}
}

// splitBlocks: khối mới bắt đầu ở tiêu đề Markdown, mục danh sách cấp đầu, hoặc dòng có chữ đầu tiên sau dòng trống.
func splitBlocks(lines []string) [][]string {
	var blocks [][]string
	start, prevBlank := 0, false
	for i, l := range lines {
		blank := strings.TrimSpace(l) == ""
		if i > start && !blank && (prevBlank || isBlockStart(l)) {
			blocks = append(blocks, lines[start:i])
			start = i
		}
		prevBlank = blank
	}
	if start < len(lines) {
		blocks = append(blocks, lines[start:])
	}
	return blocks
}

func isBlockStart(l string) bool {
	return strings.HasPrefix(l, "#") || strings.HasPrefix(l, "- ") || strings.HasPrefix(l, "* ") || strings.HasPrefix(l, "+ ")
}

func blockKeys(blocks [][]string) []string {
	keys := make([]string, len(blocks))
	for i, b := range blocks {
		keys[i] = strings.Join(b, "\n")
	}
	return keys
}

// matchIndex: với mỗi phần tử của x, vị trí khớp trong y (-1 nếu không khớp). Quá lớn thì chỉ khớp phần chung đầu/cuối.
func matchIndex(x, y []string) []int {
	idx := make([]int, len(x))
	for i := range idx {
		idx[i] = -1
	}
	pre, suf := commonEnds(x, y)
	for i := 0; i < pre; i++ {
		idx[i] = i
	}
	for k := 1; k <= suf; k++ {
		idx[len(x)-k] = len(y) - k
	}
	mx, my := x[pre:len(x)-suf], y[pre:len(y)-suf]
	if len(mx)*len(my) <= maxCells {
		for _, o := range lcsOps(mx, my) {
			if o.kind == opEqual {
				idx[pre+o.i] = pre + o.j
			}
		}
	}
	return idx
}

// splitKeep: tách dòng, giữ ký tự xuống dòng ở cuối mỗi dòng (dòng cuối có thể không có).
func splitKeep(s string) []string {
	lines := strings.SplitAfter(s, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// Merge3 gộp ba chiều theo dòng: đoạn chỉ một bên đổi lấy bên đó, hai bên đổi giống nhau lấy một bản, hai bên đổi khác
// nhau thì bọc dấu MarkerMine / MarkerSep / MarkerTheirs và tính một xung đột.
func Merge3(base, mine, theirs string) (merged string, conflicts int) {
	b, m, t := splitKeep(base), splitKeep(mine), splitKeep(theirs)
	bm, bt := matchIndex(b, m), matchIndex(b, t)
	var out strings.Builder
	i, jm, jt := 0, 0, 0
	for i < len(b) || jm < len(m) || jt < len(t) {
		if i < len(b) && bm[i] == jm && bt[i] == jt {
			out.WriteString(b[i])
			i, jm, jt = i+1, jm+1, jt+1
			continue
		}
		// Điểm ổn định kế tiếp: dòng gốc khớp ở cả hai bên.
		ni, nm, nt := len(b), len(m), len(t)
		for k := i; k < len(b); k++ {
			if bm[k] >= jm && bt[k] >= jt {
				ni, nm, nt = k, bm[k], bt[k]
				break
			}
		}
		cb, cm, ct := b[i:ni], m[jm:nm], t[jt:nt]
		switch {
		case equalLines(cm, cb):
			writeChunk(&out, ct)
		case equalLines(ct, cb), equalLines(cm, ct):
			writeChunk(&out, cm)
		default:
			conflicts++
			out.WriteString(MarkerMine + "\n")
			writeChunk(&out, cm)
			ensureNewline(&out)
			out.WriteString(MarkerSep + "\n")
			writeChunk(&out, ct)
			ensureNewline(&out)
			out.WriteString(MarkerTheirs + "\n")
		}
		i, jm, jt = ni, nm, nt
	}
	return out.String(), conflicts
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func writeChunk(out *strings.Builder, lines []string) {
	for _, l := range lines {
		out.WriteString(l)
	}
}

func ensureNewline(out *strings.Builder) {
	if s := out.String(); s != "" && !strings.HasSuffix(s, "\n") {
		out.WriteString("\n")
	}
}
