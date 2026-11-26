package docs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"deskcore/apperr"
)

// Định dạng tài liệu: front-matter tối giản (type, title, rev; khoá khác giữ nguyên) rồi Markdown. Mã yêu cầu là neo
// {#ID} ở cuối dòng tiêu đề cấp 2–6 hoặc cuối dòng mục danh sách cấp đầu. Khối trong khối mã (``` / ~~~) không tính.

// MaxDocBytes: giới hạn một tài liệu.
const MaxDocBytes = 1 << 20

// Loại tài liệu.
const (
	TypePRD   = "PRD"
	TypeBRD   = "BRD"
	TypeURD   = "URD"
	TypeSRS   = "SRS"
	TypeAC    = "AC"
	TypeOther = "other"
)

// prefixByType: tiền tố mã tự gán theo loại tài liệu.
var prefixByType = map[string]string{TypePRD: "REQ", TypeSRS: "REQ", TypeBRD: "BR", TypeURD: "UR", TypeAC: "AC", TypeOther: "REQ"}

var (
	reqIDRe   = regexp.MustCompile(`^([A-Z][A-Z0-9]{0,9})-(\d{1,4})$`)
	anchorRe  = regexp.MustCompile(`\s*\{#([^}]*)\}\s*$`)
	headingRe = regexp.MustCompile(`^(#{1,6})(?:\s+(.*?))?\s*$`)
	listRe    = regexp.MustCompile(`^(?:[-*+]|\d{1,9}[.)])\s+(.*?)\s*$`)
	fenceRe   = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
)

// maxReqNumber: số lớn nhất của phần số trong mã (\d{1,4}).
const maxReqNumber = 9999

// Requirement: một mục yêu cầu có mã. Hash bỏ neo, khoảng trắng cuối dòng và dòng trống thừa nên sửa định dạng không đổi Hash.
type Requirement struct {
	ID    string `json:"id"`
	Doc   string `json:"doc"`
	Title string `json:"title"`
	Body  string `json:"body"`
	Hash  string `json:"hash"`
	Line  int    `json:"line"` // dòng của tiêu đề/mục trong tệp, tính từ 1
}

// Doc: một tài liệu nghiệp vụ. Markdown là toàn bộ tệp (kể cả front-matter).
type Doc struct {
	ID           string        `json:"id"`
	Type         string        `json:"type"`
	Title        string        `json:"title"`
	Rev          int           `json:"rev"`
	Markdown     string        `json:"markdown"`
	Requirements []Requirement `json:"requirements"`
}

// parsed: kết quả phân tích nội bộ, đủ để tự gán mã và dựng lại tệp.
type parsed struct {
	typ, title string
	rev        int
	hasType    bool
	hasTitle   bool
	extra      []string // dòng front-matter khác type/title/rev, giữ nguyên thứ tự
	body       []string // dòng sau front-matter
	bodyStart  int      // số dòng front-matter (kể cả hai dòng ---)
	reqs       []Requirement
	unanchored []int // chỉ số dòng body của tiêu đề cấp ≥2 chưa có neo
	h1         string
}

// Parse phân tích một tài liệu: kiểm front-matter, neo, giới hạn kích thước. Trùng mã không phải lỗi ở đây (Store.Save
// từ chối, Store.Requirements báo Duplicates).
func Parse(text string) (Doc, error) {
	p, err := parse(text)
	if err != nil {
		return Doc{}, err
	}
	return p.doc(text), nil
}

func (p *parsed) doc(text string) Doc {
	reqs := p.reqs
	if reqs == nil {
		reqs = []Requirement{}
	}
	return Doc{Type: p.typ, Title: p.title, Rev: p.rev, Markdown: text, Requirements: reqs}
}

func normalizeNewlines(s string) string {
	return strings.ReplaceAll(s, "\r\n", "\n")
}

func parse(text string) (*parsed, error) {
	if len(text) > MaxDocBytes {
		return nil, apperr.New(apperr.CodeInvalid, fmt.Sprintf("tài liệu %d byte, quá giới hạn %d byte", len(text), MaxDocBytes))
	}
	lines := strings.Split(normalizeNewlines(text), "\n")
	p := &parsed{typ: TypeOther}
	if err := p.frontMatter(lines); err != nil {
		return nil, err
	}
	p.body = lines[p.bodyStart:]
	if err := p.requirements(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *parsed) frontMatter(lines []string) error {
	if len(lines) == 0 || strings.TrimRight(lines[0], " \t") != "---" {
		return nil
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if l := strings.TrimRight(lines[i], " \t"); l == "---" || l == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return apperr.New(apperr.CodeInvalid, "front-matter thiếu dòng đóng ---")
	}
	for i := 1; i < end; i++ {
		key, val, ok := strings.Cut(lines[i], ":")
		key, val = strings.TrimSpace(key), strings.TrimSpace(val)
		switch {
		case ok && key == "type":
			t, err := normalizeType(stripComment(val))
			if err != nil {
				return err
			}
			p.typ, p.hasType = t, true
		case ok && key == "title":
			p.title, p.hasTitle = val, true
		case ok && key == "rev":
			v := stripComment(val)
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				return apperr.New(apperr.CodeInvalid, fmt.Sprintf("rev %q phải là số nguyên không âm", v))
			}
			p.rev = n
		default:
			p.extra = append(p.extra, lines[i])
		}
	}
	p.bodyStart = end + 1
	return nil
}

// stripComment bỏ chú thích "  # …" sau giá trị một từ (type, rev).
func stripComment(v string) string {
	if i := strings.Index(v, "#"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

func normalizeType(t string) (string, error) {
	if strings.EqualFold(t, TypeOther) || t == "" {
		return TypeOther, nil
	}
	u := strings.ToUpper(t)
	if _, ok := prefixByType[u]; !ok {
		return "", apperr.New(apperr.CodeInvalid, fmt.Sprintf("loại tài liệu %q không hợp lệ; dùng PRD, BRD, URD, SRS, AC hoặc other", t))
	}
	return u, nil
}

// lineInfo: phân loại một dòng body.
type lineInfo struct {
	level     int    // 1–6 với tiêu đề, 0 với mục danh sách cấp đầu, -1 với dòng khác
	text      string // chữ của tiêu đề/mục, đã bỏ neo
	anchor    string // mã trong neo
	hasAnchor bool
	inFence   bool
	blank     bool
	indented  bool
}

func classify(body []string) []lineInfo {
	info := make([]lineInfo, len(body))
	var fence string
	for i, l := range body {
		li := &info[i]
		li.level = -1
		li.blank = strings.TrimSpace(l) == ""
		li.indented = !li.blank && (l[0] == ' ' || l[0] == '\t')
		if m := fenceRe.FindStringSubmatch(l); m != nil {
			rest := l[strings.Index(l, m[1])+len(m[1]):]
			switch {
			case fence == "":
				fence = m[1]
				li.inFence = true
				continue
			case m[1][0] == fence[0] && len(m[1]) >= len(fence) && strings.TrimSpace(rest) == "":
				fence = ""
				li.inFence = true
				continue
			}
		}
		if fence != "" {
			li.inFence = true
			continue
		}
		var text string
		if m := headingRe.FindStringSubmatch(l); m != nil {
			li.level, text = len(m[1]), m[2]
		} else if m := listRe.FindStringSubmatch(l); m != nil {
			li.level, text = 0, m[1]
		} else {
			continue
		}
		if m := anchorRe.FindStringSubmatchIndex(text); m != nil {
			li.anchor, li.hasAnchor = text[m[2]:m[3]], true
			text = text[:m[0]]
		}
		li.text = strings.TrimSpace(text)
	}
	return info
}

func (p *parsed) requirements() error {
	info := classify(p.body)
	for i, li := range info {
		if li.level == 1 && p.h1 == "" {
			p.h1 = li.text
		}
		if li.level < 0 {
			continue
		}
		if !li.hasAnchor {
			if li.level >= 2 {
				p.unanchored = append(p.unanchored, i)
			}
			continue
		}
		line := p.bodyStart + i + 1
		if li.level == 1 {
			return apperr.New(apperr.CodeInvalid, fmt.Sprintf("dòng %d: tiêu đề cấp 1 là tên tài liệu, không gắn mã {#%s}", line, li.anchor))
		}
		if !reqIDRe.MatchString(li.anchor) {
			return apperr.New(apperr.CodeInvalid, fmt.Sprintf("dòng %d: mã %q sai dạng; mã yêu cầu dạng REQ-12 (chữ in hoa, gạch nối, 1–4 chữ số)", line, li.anchor))
		}
		end := blockEnd(info, i)
		block := p.body[i:end]
		p.reqs = append(p.reqs, Requirement{
			ID:    li.anchor,
			Title: li.text,
			Body:  strings.Trim(strings.Join(block[1:], "\n"), "\n"),
			Hash:  hashBlock(block),
			Line:  line,
		})
	}
	return nil
}

// blockEnd: khối tiêu đề kéo tới tiêu đề cùng cấp/cao hơn hoặc neo kế tiếp; khối mục danh sách là dòng đó và các dòng
// thụt lề con (dòng trống ở giữa vẫn thuộc khối nếu sau đó còn dòng thụt lề).
func blockEnd(info []lineInfo, i int) int {
	if info[i].level == 0 {
		end := i + 1
		for k := i + 1; k < len(info); k++ {
			if info[k].blank {
				continue
			}
			if !info[k].indented {
				break
			}
			end = k + 1
		}
		return end
	}
	for k := i + 1; k < len(info); k++ {
		if info[k].inFence {
			continue
		}
		if info[k].level >= 1 && info[k].level <= info[i].level {
			return k
		}
		if info[k].hasAnchor {
			return k
		}
	}
	return len(info)
}

// hashBlock: sha256 của khối đã chuẩn hoá (bỏ neo, bỏ khoảng trắng cuối dòng, gộp dòng trống liên tiếp, bỏ dòng trống đầu/cuối).
func hashBlock(block []string) string {
	var b strings.Builder
	blank := false
	for _, l := range block {
		l = strings.TrimRight(anchorRe.ReplaceAllString(l, ""), " \t")
		if l == "" {
			blank = b.Len() > 0
			continue
		}
		if blank {
			b.WriteString("\n")
			blank = false
		}
		b.WriteString(l)
		b.WriteString("\n")
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// splitID tách tiền tố và số của mã hợp lệ.
func splitID(id string) (string, int, bool) {
	m := reqIDRe.FindStringSubmatch(id)
	if m == nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(m[2])
	return m[1], n, err == nil
}

// assign gắn mã cho các tiêu đề chưa có neo; next[prefix] là số lớn nhất đã dùng trong cả app.
func (p *parsed) assign(next map[string]int) error {
	prefix := prefixByType[p.typ]
	for _, i := range p.unanchored {
		n := next[prefix] + 1
		if n > maxReqNumber {
			return apperr.New(apperr.CodeInvalid, fmt.Sprintf("hết số cho mã %s (tối đa %d); đổi tên bớt mã cũ", prefix, maxReqNumber))
		}
		next[prefix] = n
		p.body[i] = strings.TrimRight(p.body[i], " \t") + fmt.Sprintf(" {#%s-%03d}", prefix, n)
	}
	p.unanchored = nil
	return nil
}

// render dựng lại tệp: front-matter chuẩn rồi body nguyên văn.
func (p *parsed) render() string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "type: %s\n", p.typ)
	fmt.Fprintf(&b, "title: %s\n", p.title)
	fmt.Fprintf(&b, "rev: %d\n", p.rev)
	for _, l := range p.extra {
		b.WriteString(l + "\n")
	}
	b.WriteString("---\n")
	b.WriteString(strings.Join(p.body, "\n"))
	return b.String()
}
