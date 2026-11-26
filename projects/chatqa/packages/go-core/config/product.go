package config

// Product: sản phẩm chạy trên lõi dùng chung (contracts/products.json). Mỗi app desktop gọi Use lúc khởi động,
// trước DataDir, applog và core.New.
type Product struct {
	// Code: mã trong contracts/products.json. Gửi lên Worker và phải khớp prd trong token bản quyền.
	Code string
	// Name: tên hiện cho người dùng.
	Name string
	// DirName: thư mục dữ liệu (%LOCALAPPDATA%\<DirName>, ~/Library/Application Support/<DirName>).
	DirName string
	// LogName: tệp log trong <DataDir>/logs.
	LogName string
	// CoreAPI tăng mỗi khi đổi chữ ký / đường dẫn các hàm Go mà UI gọi (main.go + modules/*).
	// UI OTA chỉ được áp dụng khi coreApi của UI == CoreAPI của exe. Mỗi sản phẩm đếm riêng.
	CoreAPI int
}

// DefaultProduct: token và dữ liệu cũ không ghi sản phẩm là của hsdesk (contracts/products.json "default").
const DefaultProduct = "hsdesk"

// Current: sản phẩm của exe đang chạy, do main của từng app đặt bằng Use (lõi không mặc định sản phẩm nào).
var Current Product

// Use đặt sản phẩm của exe.
func Use(p Product) { Current = p }
