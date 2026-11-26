package license

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func sign(t *testing.T, priv ed25519.PrivateKey, p Payload) string {
	t.Helper()
	b, _ := json.Marshal(p)
	body := base64.RawURLEncoding.EncodeToString(b)
	return body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(body)))
}

func TestVerifyAndEvaluate(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1_800_000_000, 0)
	dh := HashMachineID("abc")
	p := Payload{V: 1, Lic: "L", DH: dh, Apps: []string{"quote", "teach"}, Exp: now.Unix() + 30*86400, RefreshBy: now.Unix() + 7*86400, Iat: now.Unix()}
	tok := sign(t, priv, p)

	got, err := Verify(tok, pub)
	if err != nil {
		t.Fatal(err)
	}
	if !got.HasApp("quote") || got.HasApp("lot") {
		t.Fatalf("apps sai: %v", got.Apps)
	}

	cases := []struct {
		at   time.Time
		dh   string
		want Status
	}{
		{now, dh, StatusValid},
		{now.Add(7 * time.Hour), dh, StatusNeedsRefresh},
		{now.Add(8 * 24 * time.Hour), dh, StatusOfflineExpired},
		{now.Add(31 * 24 * time.Hour), dh, StatusExpired},
		{now, HashMachineID("may-khac"), StatusInvalid},
	}
	for _, c := range cases {
		if s := Evaluate(got, c.dh, c.at); s != c.want {
			t.Errorf("at %v: got %s want %s", c.at, s, c.want)
		}
	}
}

func TestVerifyRejectsTampered(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	tok := sign(t, priv, Payload{V: 1, Apps: []string{"quote"}})
	forged := sign(t, priv, Payload{V: 1, Apps: []string{"quote", "lot", "check", "teach"}})
	// Ghép body giả với chữ ký thật
	body, _, _ := strings.Cut(forged, ".")
	_, sig, _ := strings.Cut(tok, ".")
	if _, err := Verify(body+"."+sig, pub); err == nil {
		t.Fatal("phải từ chối token bị sửa")
	}
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := Verify(tok, otherPub); err == nil {
		t.Fatal("phải từ chối khoá khác")
	}
}

func TestDeviceHashStable(t *testing.T) {
	if HashMachineID("ABC-1") != HashMachineID(" abc-1 ") {
		t.Fatal("hash phải ổn định")
	}
	if len(HashMachineID("x")) != 64 {
		t.Fatal("hash phải 64 hex")
	}
}

func TestPayloadProduct(t *testing.T) {
	if (&Payload{}).Product() != "hsdesk" {
		t.Fatal("token cũ không ghi sản phẩm phải là hsdesk")
	}
	if (&Payload{Prd: "chatqa"}).Product() != "chatqa" {
		t.Fatal("Product phải trả prd")
	}
}
