// hsrelease: công cụ của Pan để sinh khoá, ký bản cập nhật OTA và đóng gói UI.
//
//	go run ./cmd/hsrelease keygen                       sinh 2 cặp khoá (license + release)
//	go run ./cmd/hsrelease keygen -release-only -out <tệp>  chỉ sinh khoá ký bản cập nhật (mất khoá cũ, không đụng license)
//	go run ./cmd/hsrelease zip-ui ../desktop/frontend/dist ui-1.0.1.zip
//	go run ./cmd/hsrelease sign -key release.key <file> in sha256 + chữ ký (JSON)
//	go run ./cmd/hsrelease verify -pub <b64> -sig <b64> <file> kiểm chữ ký bản phát hành với khoá công khai (RELEASE_PUBLIC_KEY)
//	go run ./cmd/hsrelease verify-license -pub <b64> <token>
package main

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"deskcore/license"
	"deskcore/updater"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = keygen(os.Args[2:])
	case "sign":
		err = sign(os.Args[2:])
	case "zip-ui":
		if len(os.Args) != 4 {
			usage()
		}
		err = zipDir(os.Args[2], os.Args[3])
	case "verify":
		err = verifyRelease(os.Args[2:])
	case "verify-license":
		err = verifyLicense(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "lỗi:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "dùng: hsrelease keygen | sign -key release.key <file> | verify -pub <b64> -sig <b64> <file> | zip-ui <dir> <out.zip> | verify-license -pub <b64> <token>")
	os.Exit(2)
}

func keygen(args []string) error {
	fsFlags := flag.NewFlagSet("keygen", flag.ExitOnError)
	releaseOnly := fsFlags.Bool("release-only", false, "chỉ sinh khoá ký bản cập nhật (không đụng cặp khoá license, không in secret của Worker)")
	out := fsFlags.String("out", "release.key", "nơi ghi khoá ký (PEM, quyền 0600)")
	_ = fsFlags.Parse(args)

	relPub, relPriv, _ := ed25519.GenerateKey(rand.Reader)
	relPKCS8, _ := x509.MarshalPKCS8PrivateKey(relPriv)
	if _, err := os.Stat(*out); err == nil {
		return fmt.Errorf("%s đã tồn tại - không ghi đè", *out)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: relPKCS8})
	if err := os.WriteFile(*out, pemBytes, 0o600); err != nil {
		return err
	}
	if *releaseOnly {
		fmt.Printf("ReleasePublicKey = %q\n", base64.StdEncoding.EncodeToString(relPub))
		fmt.Printf("Đã ghi %s (khoá ký bản cập nhật). Cất offline, KHÔNG commit, KHÔNG đưa lên Worker.\n", *out)
		return nil
	}
	licPub, licPriv, _ := ed25519.GenerateKey(rand.Reader)
	licPKCS8, _ := x509.MarshalPKCS8PrivateKey(licPriv)
	fmt.Println("== Worker secret (wrangler secret put LICENSE_SIGNING_KEY) ==")
	fmt.Println(base64.StdEncoding.EncodeToString(licPKCS8))
	fmt.Println()
	fmt.Println("== Dán vào desktop/internal/config/keys.go ==")
	fmt.Printf("LicensePublicKey = %q\n", base64.StdEncoding.EncodeToString(licPub))
	fmt.Printf("ReleasePublicKey = %q\n", base64.StdEncoding.EncodeToString(relPub))
	fmt.Println()
	fmt.Printf("Đã ghi %s (khoá ký bản cập nhật). Cất offline, KHÔNG commit, KHÔNG đưa lên Worker.\n", *out)
	return nil
}

func loadReleaseKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("release.key không phải PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("không phải khoá Ed25519")
	}
	return priv, nil
}

func sign(args []string) error {
	fsFlags := flag.NewFlagSet("sign", flag.ExitOnError)
	keyPath := fsFlags.String("key", "release.key", "khoá ký")
	_ = fsFlags.Parse(args)
	if fsFlags.NArg() != 1 {
		usage()
	}
	priv, err := loadReleaseKey(*keyPath)
	if err != nil {
		return err
	}
	sha, size, err := updater.FileSHA256(fsFlags.Arg(0))
	if err != nil {
		return err
	}
	out := map[string]any{"sha256": sha, "sig": updater.SignDigest(priv, sha), "size": size}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

// zipDir đóng gói thư mục dist thành zip (đường dẫn dùng "/").
func zipDir(dir, out string) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()
	w := zip.NewWriter(f)
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() == ".gitkeep" {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		hdr := &zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate, Modified: time.Now()}
		zw, err := w.CreateHeader(hdr)
		if err != nil {
			return err
		}
		src, err := os.Open(p)
		if err != nil {
			return err
		}
		defer src.Close()
		_, err = io.Copy(zw, src)
		return err
	})
	if err != nil {
		return err
	}
	return w.Close()
}

// verifyRelease kiểm chữ ký của một tệp phát hành đúng như app kiểm khi OTA: sha256 của tệp, chữ ký trên sha256 đó.
func verifyRelease(args []string) error {
	fsFlags := flag.NewFlagSet("verify", flag.ExitOnError)
	pubB64 := fsFlags.String("pub", "", "release public key base64 (RELEASE_PUBLIC_KEY)")
	sigB64 := fsFlags.String("sig", "", "chữ ký base64 do sign in ra")
	_ = fsFlags.Parse(args)
	if fsFlags.NArg() != 1 {
		usage()
	}
	pub, err := license.DecodePublicKey(*pubB64)
	if err != nil {
		return err
	}
	sha, size, err := updater.FileSHA256(fsFlags.Arg(0))
	if err != nil {
		return err
	}
	if err := updater.VerifyDigest(pub, sha, *sigB64); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "sha256": sha, "size": size})
}

func verifyLicense(args []string) error {
	fsFlags := flag.NewFlagSet("verify-license", flag.ExitOnError)
	pubB64 := fsFlags.String("pub", "", "license public key base64")
	_ = fsFlags.Parse(args)
	if fsFlags.NArg() != 1 {
		usage()
	}
	pub, err := license.DecodePublicKey(*pubB64)
	if err != nil {
		return err
	}
	p, err := license.Verify(fsFlags.Arg(0), pub)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(p)
}
