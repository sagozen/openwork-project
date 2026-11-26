// licensecheck: kiểm tra license token máy đã nhận có khớp khoá công khai định build vào app không.
// Chỉ in "khớp" / "không khớp" cùng thông tin không bí mật (sản phẩm, hạn); không in khoá hay token.
//
//	go run deskcore/cmd/licensecheck -state "<thư mục dữ liệu>/state.json" -pub "$LICENSE_PUBLIC_KEY"
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"deskcore/license"
)

func main() {
	statePath := flag.String("state", "", "state.json của app (thư mục dữ liệu)")
	pubB64 := flag.String("pub", os.Getenv("LICENSE_PUBLIC_KEY"), "LicensePublicKey (base64); mặc định lấy từ biến LICENSE_PUBLIC_KEY")
	flag.Parse()

	pub, err := license.DecodePublicKey(*pubB64)
	if err != nil {
		fail("khoá công khai sai định dạng (phải là base64 của 32 byte)")
	}
	raw, err := os.ReadFile(*statePath)
	if err != nil {
		fail("không đọc được " + *statePath)
	}
	var st struct {
		LicenseToken string `json:"licenseToken"`
	}
	if json.Unmarshal(raw, &st) != nil || st.LicenseToken == "" {
		fail("state.json chưa có license token (chưa kích hoạt lần nào)")
	}
	p, err := license.Verify(st.LicenseToken, pub)
	if err != nil {
		fail("KHÔNG KHỚP: token do Worker ký không xác minh được bằng khoá công khai này")
	}
	fmt.Printf("KHỚP: sản phẩm %s, hết hạn %s\n", p.Product(), time.Unix(p.Exp, 0).Format("2006-01-02"))
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}
