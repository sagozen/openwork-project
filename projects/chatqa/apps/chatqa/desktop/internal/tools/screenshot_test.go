package tools

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"

	"deskcore/apperr"
)

// phoneShot: ảnh giả cỡ màn hình điện thoại, nửa trên trắng, nửa dưới đen, có một khối đỏ để kiểm màu sau khi nén.
// Mỗi điểm ảnh có nhiễu nhẹ cố định như ảnh chụp thật (ảnh phẳng tuyệt đối khiến PNG nhỏ bất thường).
func phoneShot(t *testing.T, w, h int, alpha uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			noise := uint8((x*7919 + y*104729 + x*y) % 9)
			c := color.NRGBA{245 + noise, 245 + noise, 245 + noise, alpha}
			switch {
			case y >= h/2:
				c = color.NRGBA{noise, noise, noise, alpha}
			case x < w/4 && y < h/4:
				c = color.NRGBA{245 + noise, noise, noise, alpha}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestEncodeShotDefaultsToSmallJPEG(t *testing.T) {
	src := phoneShot(t, 1170, 2532, 255)
	out, mime, err := encodeShot(src, shotOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if mime != mimeJPEG {
		t.Fatalf("mime = %s, muốn %s", mime, mimeJPEG)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("không giải mã được JPEG: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != defaultShotWidth || b.Dy() != 2532*defaultShotWidth/1170 {
		t.Errorf("kích thước = %dx%d, muốn %dx%d (giữ tỉ lệ)", b.Dx(), b.Dy(), defaultShotWidth, 2532*defaultShotWidth/1170)
	}
	if len(out) >= len(src) {
		t.Errorf("ảnh sau nén (%d byte) không nhỏ hơn ảnh gốc (%d byte)", len(out), len(src))
	}
	// Khối đỏ vẫn đỏ, nửa dưới vẫn đen: thu nhỏ trung bình không làm hỏng màu.
	if r, g, bl, _ := img.At(10, 10).RGBA(); r>>8 < 200 || g>>8 > 60 || bl>>8 > 60 {
		t.Errorf("khối đỏ bị đổi màu: %d %d %d", r>>8, g>>8, bl>>8)
	}
	if r, _, _, _ := img.At(b.Dx()/2, b.Dy()*3/4).RGBA(); r>>8 > 40 {
		t.Errorf("nửa dưới không còn đen: %d", r>>8)
	}
}

func TestEncodeShotNeverUpscalesAndHonorsMaxWidth(t *testing.T) {
	small := phoneShot(t, 400, 800, 255)
	out, mime, err := encodeShot(small, shotOpts{MaxWidth: 2000, Format: "png"})
	if err != nil || mime != mimePNG {
		t.Fatalf("mime = %s, err = %v", mime, err)
	}
	img, _ := png.Decode(bytes.NewReader(out))
	if img.Bounds().Dx() != 400 {
		t.Errorf("ảnh nhỏ bị phóng to thành %d px", img.Bounds().Dx())
	}

	big := phoneShot(t, 1000, 2000, 255)
	out, _, err = encodeShot(big, shotOpts{MaxWidth: 300, Format: "PNG"})
	if err != nil {
		t.Fatal(err)
	}
	img, _ = png.Decode(bytes.NewReader(out))
	if img.Bounds().Dx() != 300 || img.Bounds().Dy() != 600 {
		t.Errorf("kích thước = %v, muốn 300x600", img.Bounds())
	}

	// max_width quá nhỏ được nâng về mức tối thiểu để chữ còn đọc được.
	out, _, _ = encodeShot(big, shotOpts{MaxWidth: 10})
	jimg, _ := jpeg.Decode(bytes.NewReader(out))
	if jimg.Bounds().Dx() != minShotWidth {
		t.Errorf("max_width=10 cho ra %d px, muốn %d", jimg.Bounds().Dx(), minShotWidth)
	}
}

func TestEncodeShotFlattensTransparencyOnWhite(t *testing.T) {
	out, _, err := encodeShot(phoneShot(t, 300, 300, 0), shotOpts{})
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if r, g, b, _ := img.At(150, 250).RGBA(); r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Errorf("điểm trong suốt phải thành trắng, được %d %d %d", r>>8, g>>8, b>>8)
	}
}

func TestEncodeShotRejectsUnknownFormatAndKeepsForeignBytes(t *testing.T) {
	if _, _, err := encodeShot(phoneShot(t, 300, 300, 255), shotOpts{Format: "gif"}); err == nil || apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Errorf("format lạ phải báo lỗi tham số, được %v", err)
	}
	foreign := []byte("không phải PNG")
	out, mime, err := encodeShot(foreign, shotOpts{})
	if err != nil || mime != mimePNG || !bytes.Equal(out, foreign) {
		t.Errorf("dữ liệu lạ phải giữ nguyên: %q %s %v", out, mime, err)
	}
}

// Ảnh chỉ được đi một lần trong kết quả MCP: ở khối ảnh. Bản trong chữ và structuredContent bị client tính như chữ.
func TestCallResultSendsScreenshotOnlyAsImageBlock(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString([]byte("jpeg-bytes-giả-" + strings.Repeat("x", 4000)))
	res := CallResult(&Result{Kind: "LiveScreen", Data: screen{DeviceID: "emu-1", PNG: b64, Mime: mimeJPEG}}, nil)
	raw, _ := json.Marshal(res)
	if n := strings.Count(string(raw), b64); n != 1 {
		t.Fatalf("ảnh xuất hiện %d lần trong kết quả MCP, muốn đúng 1", n)
	}
	content := res["content"].([]map[string]any)
	if len(content) != 2 || content[1]["type"] != "image" || content[1]["mimeType"] != mimeJPEG || content[1]["data"] != b64 {
		t.Fatalf("khối ảnh sai: %+v", content)
	}
	if text := content[0]["text"].(string); !strings.Contains(text, `"deviceId":"emu-1"`) || strings.Contains(text, `"png"`) {
		t.Errorf("chữ phải còn mã thiết bị và không còn ảnh: %s", text)
	}

	// Kết quả cũ không có mime vẫn được hiểu là PNG.
	legacy := CallResult(&Result{Kind: "LiveScreen", Data: screen{DeviceID: "emu-1", PNG: "iVBORw0K"}}, nil)
	if got := legacy["content"].([]map[string]any)[1]["mimeType"]; got != mimePNG {
		t.Errorf("mime mặc định = %v, muốn %s", got, mimePNG)
	}
}

func TestScreenshotToolsExposeSizeParameters(t *testing.T) {
	r := Catalog(nil, nil, nil, nil)
	for _, name := range []string{"device_screenshot", "device_tap", "device_swipe"} {
		tool, ok := r.Get(name)
		if !ok {
			t.Fatalf("thiếu tool %s", name)
		}
		props, _ := tool.Schema["properties"].(map[string]any)
		for _, p := range []string{"max_width", "format"} {
			if _, ok := props[p]; !ok {
				t.Errorf("%s thiếu tham số %s", name, p)
			}
		}
	}
}
