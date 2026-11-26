package textdiff

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"
)

// referenceLineDiff: bản so dòng gốc (trước khi tách gói), dùng để chứng minh Lines giữ nguyên hành vi.
func referenceLineDiff(a, b string) string {
	x, y := strings.Split(a, "\n"), strings.Split(b, "\n")
	n, m := len(x), len(y)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
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
	var out strings.Builder
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && x[i] == y[j]:
			out.WriteString("  " + x[i] + "\n")
			i, j = i+1, j+1
		case j < m && (i == n || lcs[i][j+1] >= lcs[i+1][j]):
			out.WriteString("+ " + y[j] + "\n")
			j++
		default:
			out.WriteString("- " + x[i] + "\n")
			i++
		}
	}
	return out.String()
}

func TestLinesTable(t *testing.T) {
	cases := []struct{ a, b, want string }{
		{"a\nb\nc", "a\nB\nc", "  a\n+ B\n- b\n  c\n"},
		{"", "", "  \n"},
		{"a", "a\nb", "  a\n+ b\n"},
		{"a\nb", "b", "- a\n  b\n"},
		{"x", "y", "+ y\n- x\n"},
	}
	for _, c := range cases {
		if got := Lines(c.a, c.b); got != c.want {
			t.Errorf("Lines(%q, %q) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestLinesMatchesReferenceOnRandomInput(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	gen := func() string {
		n := r.Intn(12)
		lines := make([]string, n)
		for i := range lines {
			lines[i] = string(rune('a' + r.Intn(4)))
		}
		return strings.Join(lines, "\n")
	}
	for k := 0; k < 2000; k++ {
		a, b := gen(), gen()
		if got, want := Lines(a, b), referenceLineDiff(a, b); got != want {
			t.Fatalf("Lines(%q, %q) = %q, want %q", a, b, got, want)
		}
	}
}

// rebuild dựng lại hai bản từ diff để kiểm tính đúng của đường so theo khối.
func rebuild(d string) (a, b string) {
	var xa, xb []string
	for _, l := range strings.Split(strings.TrimSuffix(d, "\n"), "\n") {
		p, s := l[:2], l[2:]
		if p != "+ " {
			xa = append(xa, s)
		}
		if p != "- " {
			xb = append(xb, s)
		}
	}
	return strings.Join(xa, "\n"), strings.Join(xb, "\n")
}

func TestLinesLargeInputFallsBackToBlocks(t *testing.T) {
	var a, b strings.Builder
	for i := 0; i < 2000; i++ {
		fmt.Fprintf(&a, "## Mục %d {#REQ-%d}\nnội dung %d\n\n", i, i, i)
		if i%500 == 0 {
			fmt.Fprintf(&b, "## Mục %d {#REQ-%d}\nnội dung đã sửa %d\n\n", i, i, i)
		} else {
			fmt.Fprintf(&b, "## Mục %d {#REQ-%d}\nnội dung %d\n\n", i, i, i)
		}
	}
	start := time.Now()
	d := Lines(a.String(), b.String())
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("Lines chạy %v", el)
	}
	ga, gb := rebuild(d)
	if ga != a.String() || gb != b.String() {
		t.Fatal("diff theo khối không dựng lại được hai bản")
	}
	if !strings.Contains(d, "- nội dung 500\n") || !strings.Contains(d, "+ nội dung đã sửa 500\n") {
		t.Fatal("thiếu khối đã đổi")
	}
	if strings.Contains(d, "- nội dung 501\n") {
		t.Fatal("khối không đổi bị đánh dấu")
	}
}

func TestLinesHugeInputStillCorrect(t *testing.T) {
	// Mỗi dòng một khối (sau dòng trống) và không có dòng chung: rơi về bỏ hết rồi thêm hết.
	var a, b strings.Builder
	for i := 0; i < 2100; i++ {
		fmt.Fprintf(&a, "a%d\n\n", i)
		fmt.Fprintf(&b, "b%d\n\n", i)
	}
	d := Lines("head\n"+a.String()+"tail", "head\n"+b.String()+"tail")
	ga, gb := rebuild(d)
	if ga != "head\n"+a.String()+"tail" || gb != "head\n"+b.String()+"tail" {
		t.Fatal("diff không dựng lại được hai bản")
	}
	if !strings.HasPrefix(d, "  head\n") || !strings.HasSuffix(d, "  tail\n") {
		t.Fatal("phần chung đầu/cuối phải giữ nguyên")
	}
}

func TestMerge3(t *testing.T) {
	conflict := func(mine, theirs string) string {
		return MarkerMine + "\n" + mine + MarkerSep + "\n" + theirs + MarkerTheirs + "\n"
	}
	cases := []struct {
		name, base, mine, theirs, want string
		conflicts                      int
	}{
		{"không ai đổi", "a\nb\n", "a\nb\n", "a\nb\n", "a\nb\n", 0},
		{"chỉ tôi đổi", "a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n", "a\nB\nc\n", 0},
		{"chỉ họ đổi", "a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n", "a\nb\nC\n", 0},
		{"hai bên đổi giống nhau", "a\nb\n", "a\nX\n", "a\nX\n", "a\nX\n", 0},
		{"đổi ở hai chỗ rời nhau", "a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n", "A\nb\nc\nd\nE\n", 0},
		{"thêm ở hai chỗ rời nhau", "a\nb\nc\n", "a\nm\nb\nc\n", "a\nb\nc\nt\n", "a\nm\nb\nc\nt\n", 0},
		{"họ xoá, tôi giữ", "a\nb\nc\n", "a\nb\nc\n", "a\nc\n", "a\nc\n", 0},
		{"cùng dòng đổi khác nhau", "a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n",
			"a\n" + conflict("mine\n", "theirs\n") + "c\n", 1},
		{"tôi sửa, họ xoá", "a\nb\nc\n", "a\nB\nc\n", "a\nc\n", "a\n" + conflict("B\n", "") + "c\n", 1},
		{"cùng thêm ở cuối", "a\n", "a\nx\n", "a\ny\n", "a\n" + conflict("x\n", "y\n"), 1},
		{"hai xung đột", "a\nb\nc\nd\ne\n", "a\n1\nc\n3\ne\n", "a\n2\nc\n4\ne\n",
			"a\n" + conflict("1\n", "2\n") + "c\n" + conflict("3\n", "4\n") + "e\n", 2},
		{"gốc rỗng, hai bản khác", "", "x", "y", conflict("x\n", "y\n"), 1},
		{"thiếu xuống dòng cuối", "a\nb", "a\nb", "a\nB", "a\nB", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, n := Merge3(c.base, c.mine, c.theirs)
			if got != c.want || n != c.conflicts {
				t.Fatalf("Merge3 = %q (%d), want %q (%d)", got, n, c.want, c.conflicts)
			}
		})
	}
}
