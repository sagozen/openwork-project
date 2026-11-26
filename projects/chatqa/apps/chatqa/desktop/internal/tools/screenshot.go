package tools

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"

	"deskcore/apperr"
)

// Ảnh màn hình đi vào ngữ cảnh của mô hình, nên mặc định thu nhỏ và nén JPEG; toạ độ tap/swipe theo tỉ lệ 0..1 nên
// không phụ thuộc kích thước ảnh. Cần ảnh nguyên vẹn thì truyền format=png và max_width đủ lớn.
const (
	defaultShotWidth = 720
	minShotWidth     = 160
	maxShotWidth     = 2400
	shotJPEGQuality  = 70

	mimePNG  = "image/png"
	mimeJPEG = "image/jpeg"
)

// shotOpts: tham số chung của mọi tool trả ảnh màn hình.
type shotOpts struct {
	MaxWidth int    `json:"max_width" desc:"Chiều ngang tối đa của ảnh (px); 0 = 720. Chỉ thu nhỏ, không phóng to"`
	Format   string `json:"format" desc:"jpeg (nhẹ, mặc định) hoặc png (nguyên vẹn, nặng hơn nhiều)"`
}

// encodeShot thu nhỏ ảnh PNG của driver về tối đa maxWidth px ngang rồi mã hoá theo format. Trả byte ảnh và mime.
func encodeShot(src []byte, o shotOpts) ([]byte, string, error) {
	format := strings.ToLower(strings.TrimSpace(o.Format))
	switch format {
	case "", "jpeg", "jpg":
		format = "jpeg"
	case "png":
	default:
		return nil, "", apperr.New(apperr.CodeInvalid, "format phải là jpeg hoặc png, không phải "+o.Format)
	}
	width := o.MaxWidth
	if width <= 0 {
		width = defaultShotWidth
	}
	width = min(max(width, minShotWidth), maxShotWidth)

	img, err := png.Decode(bytes.NewReader(src))
	if err != nil {
		// Driver trả định dạng lạ: giữ nguyên ảnh gốc thay vì làm hỏng lời gọi.
		return src, mimePNG, nil
	}
	if img.Bounds().Dx() > width {
		img = scaleToWidth(img, width)
	}
	var buf bytes.Buffer
	if format == "png" {
		if err := png.Encode(&buf, img); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), mimePNG, nil
	}
	if err := jpeg.Encode(&buf, flatten(img), &jpeg.Options{Quality: shotJPEGQuality}); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), mimeJPEG, nil
}

// flatten đặt ảnh lên nền trắng: JPEG không có kênh trong suốt.
func flatten(src image.Image) image.Image {
	b := src.Bounds()
	dst := image.NewRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := src.At(x, y).RGBA()
			// Giá trị đã nhân trước alpha: nền trắng cộng phần còn lại của alpha.
			rest := 0xffff - a
			dst.SetRGBA(x, y, color.RGBA{R: uint8((r + rest) >> 8), G: uint8((g + rest) >> 8), B: uint8((bl + rest) >> 8), A: 0xff})
		}
	}
	return dst
}

// scaleToWidth thu nhỏ bằng trung bình các điểm ảnh gốc rơi vào mỗi điểm ảnh đích (box filter), giữ tỉ lệ. Chữ nhỏ trên
// giao diện vẫn đọc được, khác lấy mẫu gần nhất làm nát nét chữ.
func scaleToWidth(src image.Image, width int) image.Image {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	height := max(sh*width/sw, 1)
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		y0, y1 := sb.Min.Y+dy*sh/height, sb.Min.Y+(dy+1)*sh/height
		y1 = max(y1, y0+1)
		for dx := 0; dx < width; dx++ {
			x0, x1 := sb.Min.X+dx*sw/width, sb.Min.X+(dx+1)*sw/width
			x1 = max(x1, x0+1)
			var r, g, b, a, n uint64
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					pr, pg, pb, pa := src.At(x, y).RGBA()
					r, g, b, a, n = r+uint64(pr), g+uint64(pg), b+uint64(pb), a+uint64(pa), n+1
				}
			}
			dst.SetRGBA(dx, dy, color.RGBA{R: uint8(r / n >> 8), G: uint8(g / n >> 8), B: uint8(b / n >> 8), A: uint8(a / n >> 8)})
		}
	}
	return dst
}
