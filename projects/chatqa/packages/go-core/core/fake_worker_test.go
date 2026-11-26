package core

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"deskcore/license"
)

// fakeSrv: Worker giả cho test lõi. Nhúng *httptest.Server nên dùng được .URL và .Close(); các trường điều khiển hành vi từng bài test.
type fakeSrv struct {
	*httptest.Server
	mu sync.Mutex

	GoogleTokenHits   int    // số lần máy xin token Google
	GoogleAccessToken string // token Google trả về ("" = "ya29.x"); đổi giữa chừng = admin nối lại tài khoản khác

	Tenant string
	// Tài khoản đăng nhập thử: username -> mật khẩu (mặc định mọi tên đều đăng nhập với mật khẩu "x").
	ForcedLoginErr     map[string]any // username -> body lỗi (kèm "status")
	MustChange         map[string]bool
	Roles              map[string]string
	Perms              map[string][]string
	Apps               map[string][]string
	SessionVersion     int
	ServerNow          func() int64
	Heartbeat          func() (int, map[string]any) // nil = mặc định hoạt động
	SyncVerdict        func(op map[string]any) map[string]any
	SyncDecisions      []map[string]any
	SyncCalls          []map[string]any
	SyncAuthHeaders    []string // Authorization của từng lần gọi /sync/ops
	LicenseApps        []string
	LicenseRefreshCode int // != 0: /license/refresh trả mã này kèm lỗi LicenseRefreshErr
	LicenseRefreshErr  string
	ChangePasswordErr  string
	SyncFirstAuthFail  bool     // lần gọi /sync/ops đầu tiên kèm phiên bị 401 session_expired
	LicensePrd         string   // prd trong token bản quyền ("" = token cũ không ghi sản phẩm)
	Products           []string // product máy gửi lên ở activate / refresh / login / heartbeat
}

func (f *fakeSrv) now() int64 {
	if f.ServerNow != nil {
		return f.ServerNow()
	}
	return time.Now().Unix()
}

func signToken(priv ed25519.PrivateKey, payload any) string {
	b, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(b)
	return body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(body)))
}

// Worker giả: activate / refresh / login / heartbeat / sync.
func fakeWorker(t *testing.T, priv ed25519.PrivateKey, tenant string) *fakeSrv {
	f := &fakeSrv{Tenant: tenant, SessionVersion: 1, LicenseApps: []string{"quote", "teach"},
		ForcedLoginErr: map[string]any{}, MustChange: map[string]bool{}, Roles: map[string]string{}, Perms: map[string][]string{}, Apps: map[string][]string{"chi-teach": {"teach"}}}
	issue := func(w http.ResponseWriter, dh string) {
		now := f.now()
		p := license.Payload{V: 1, Lic: "L1", Tenant: tenant, Dev: "D1", DH: dh, Apps: f.LicenseApps,
			MaxDevices: 3, Exp: now + 30*86400, RefreshBy: now + 7*86400, Iat: now, Prd: f.LicensePrd}
		_ = json.NewEncoder(w).Encode(map[string]any{"token": signToken(priv, p), "payload": p})
	}
	fail := func(w http.ResponseWriter, status int, body map[string]any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"ok":true}`)) })
	mux.HandleFunc("POST /api/v1/license/activate", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.Products = append(f.Products, in["product"])
		f.mu.Unlock()
		if in["licenseKey"] != "HSD-AAAAA-BBBBB-CCCCC-DDDDD" {
			fail(w, 403, map[string]any{"error": "license_not_found"})
			return
		}
		issue(w, in["deviceHash"])
	})
	mux.HandleFunc("POST /api/v1/license/refresh", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		code, msg := f.LicenseRefreshCode, f.LicenseRefreshErr
		f.mu.Unlock()
		if code != 0 {
			fail(w, code, map[string]any{"error": msg})
			return
		}
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.Products = append(f.Products, in["product"])
		f.mu.Unlock()
		issue(w, in["deviceHash"])
	})
	user := func(name string) map[string]any {
		role := f.Roles[name]
		if role == "" {
			role = "staff"
		}
		perms := f.Perms[name]
		if perms == nil {
			perms = map[string][]string{"staff": {"work.do"}, "vipo": {}}[role]
		}
		u := map[string]any{"id": "u-" + name, "tenant": tenant, "name": "Lan", "role": role, "perms": perms}
		if apps := f.Apps[name]; apps != nil {
			u["apps"] = apps
		} else if role == "vipo" {
			u["apps"] = []string{}
		}
		return u
	}
	session := func(name string) map[string]any {
		u := user(name)
		now := f.now()
		resp := map[string]any{"token": "sess", "exp": now + 12*3600, "user": u, "serverNow": now, "sessionVersion": f.SessionVersion, "mustChangePassword": f.MustChange[name]}
		if !f.MustChange[name] {
			resp["entitlement"] = signToken(priv, map[string]any{"v": 1, "typ": "ent", "uid": u["id"], "tid": tenant, "role": u["role"], "name": u["name"],
				"perms": u["perms"], "apps": u["apps"], "sv": f.SessionVersion, "iat": now})
		}
		return resp
	}
	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.Products = append(f.Products, in["product"])
		f.mu.Unlock()
		if in["client"] != "desktop" || in["deviceId"] != "D1" || in["deviceHash"] == "" {
			fail(w, 400, map[string]any{"error": "missing_fields"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if e, ok := f.ForcedLoginErr[in["username"]]; ok {
			body := e.(map[string]any)
			status := int(body["status"].(float64))
			delete(body, "status")
			fail(w, status, body)
			return
		}
		if in["password"] == "sai" {
			fail(w, 401, map[string]any{"error": "invalid_credentials"})
			return
		}
		_ = json.NewEncoder(w).Encode(session(in["username"]))
	})
	mux.HandleFunc("POST /api/v1/auth/refresh", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(session("lan"))
	})
	mux.HandleFunc("POST /api/v1/auth/change-password", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.ChangePasswordErr != "" {
			fail(w, 401, map[string]any{"error": f.ChangePasswordErr})
			return
		}
		f.SessionVersion++
		delete(f.MustChange, "lan")
		_ = json.NewEncoder(w).Encode(session("lan"))
	})
	mux.HandleFunc("POST /api/v1/auth/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		hb := f.Heartbeat
		f.mu.Unlock()
		status, body := 200, map[string]any{"active": true, "sessionVersion": f.SessionVersion, "permsVersion": 1, "appsVersion": 1, "licenseState": "ok", "licenseApps": f.LicenseApps}
		if hb != nil {
			status, body = hb()
		}
		body["serverNow"] = f.now()
		fail(w, status, body)
	})
	mux.HandleFunc("POST /api/v1/sync/ops", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Ops      []map[string]any `json:"ops"`
			Awaiting []string         `json:"awaiting"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.SyncAuthHeaders = append(f.SyncAuthHeaders, r.Header.Get("Authorization")+"|"+r.Header.Get("X-License-Token"))
		if f.SyncFirstAuthFail && r.Header.Get("Authorization") != "" {
			f.SyncFirstAuthFail = false
			fail(w, 401, map[string]any{"error": "session_expired"})
			return
		}
		results := []map[string]any{}
		for _, op := range in.Ops {
			f.SyncCalls = append(f.SyncCalls, op)
			v := map[string]any{"status": "accepted"}
			if f.SyncVerdict != nil {
				v = f.SyncVerdict(op)
			}
			v["opId"] = op["opId"]
			results = append(results, v)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"serverNow": f.now(), "results": results, "decisions": f.SyncDecisions})
	})
	mux.HandleFunc("POST /api/v1/google/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sess" || r.Header.Get("X-Device-Id") != "D1" {
			w.WriteHeader(403)
			_, _ = w.Write([]byte(`{"error":"device_not_licensed"}`))
			return
		}
		f.mu.Lock()
		f.GoogleTokenHits++
		tok := f.GoogleAccessToken
		f.mu.Unlock()
		if tok == "" {
			tok = "ya29.x"
		}
		_, _ = w.Write([]byte(`{"access_token":"` + tok + `","expires_at":` + jsonInt(time.Now().Unix()+3600) + `,"resources":{}}`))
	})
	f.Server = httptest.NewServer(mux)
	return f
}
