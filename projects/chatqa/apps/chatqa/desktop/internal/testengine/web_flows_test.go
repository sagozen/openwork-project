package testengine

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"chatqa/internal/pw"
	"deskcore/apperr"
)

func TestSpecGraphTitleHashAndCheapChecks(t *testing.T) {
	g := specGraph("/a", "/a/x.spec.ts", []byte("import { test } from './chatqa';\n\ntest.describe(\"Nhóm đăng nhập\", () => {});\ntest('sau', async () => {});\n"))
	if g.title != "Nhóm đăng nhập" || g.hash == "" || len(g.deps) != 0 || len(g.errs) != 0 {
		t.Fatalf("specGraph = %+v", g)
	}
	if h2 := specGraph("/a", "/a/x.spec.ts", []byte("khác")).hash; h2 == g.hash {
		t.Fatal("nội dung khác phải khác hash")
	}
	if g := specGraph("/a", "/a/x.spec.ts", []byte{0xc3}); len(g.errs) != 1 || g.errs[0].File != "x.spec.ts" {
		t.Fatalf("UTF-8 hỏng: %+v", g.errs)
	}
}

func TestFlowStoreValidateSpecMapsIssuesToFileAndLine(t *testing.T) {
	e, _ := newTestEngine(t)
	specs := &stubSpecs{}
	e.Flows.Specs = specs
	src := []byte(loginSpec)
	sf, err := e.Flows.ValidateSpec(context.Background(), "demo", "login.spec.ts", src, []string{"PASSWORD"}, []string{"app.test"})
	if err != nil || !reflect.DeepEqual(sf.EnvUsed, []string{"PASSWORD"}) || sf.Title != "đăng nhập web" || sf.Name != "login.spec.ts" {
		t.Fatalf("ValidateSpec = %+v, %v", sf, err)
	}
	fe := flowErrors(t, func() error {
		_, err := e.Flows.ValidateSpec(context.Background(), "demo", "./login.spec.ts", src, nil, nil)
		return err
	}())
	if len(fe) != 1 || fe[0].File != "login.spec.ts" || fe[0].Line != 8 || !strings.Contains(fe[0].Message, "PASSWORD") {
		t.Fatalf("lỗi = %+v", fe)
	}
	if _, err := e.Flows.ValidateSpec(context.Background(), "demo", "a.yaml", src, nil, nil); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("tên không phải spec: %v", err)
	}
	specs.ready = errNoWebRuntime()
	if _, err := e.Flows.ValidateSpec(context.Background(), "demo", "login.spec.ts", src, nil, nil); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("chưa cài bộ chạy: %v", err)
	}
}

func TestSpecSecretLiteralAndRisks(t *testing.T) {
	src := []byte("a\nb\nfill('x" + secretPassword + "')\n")
	err := specSecretLiteral("a.spec.ts", src, []string{secretPassword})
	fe, ok := err.(FlowErrors)
	if !ok || fe[0].Line != 3 || strings.Contains(fe.Error(), secretPassword) {
		t.Fatalf("bí mật dạng chữ: %v", err)
	}
	if err := specSecretLiteral("a.spec.ts", []byte("process.env.PASSWORD"), []string{secretPassword}); err != nil {
		t.Fatal(err)
	}
	risks := scanRiskSpec("await page.mouse.click(1, 2);\nawait page.locator('#x').nth(2).click();\nawait page.getByText('NV123456').click();\n")
	if len(risks) != 4 {
		t.Fatalf("rủi ro = %q", risks)
	}
	if r := scanRiskSpec("await page.getByRole('button', { name: 'Lưu' }).click();"); len(r) != 0 {
		t.Fatalf("spec sạch: %q", r)
	}
}

func TestEngineSpecsReadyScopeAndSidecarCall(t *testing.T) {
	e, _ := newTestEngine(t)
	v := engineSpecs{e}
	if err := v.Ready(); apperr.CodeOf(err) != pw.CodeRuntimeMissing {
		t.Fatalf("Web nil: %v", err)
	}
	rt, calls := fakeWebRuntime(t)
	sc := &pw.Sidecar{RT: rt, Log: t.Logf}
	t.Cleanup(func() { _ = sc.Close() })
	e.Web = &Web{RT: rt, Sidecar: sc}
	if err := v.Ready(); err != nil {
		t.Fatalf("bộ chạy đã cài: %v", err)
	}
	if _, err := e.Flows.SetEnv("demo", PlatformWeb, map[string]string{"BASE_PATH": "/v2"}); err != nil {
		t.Fatal(err)
	}
	e.WebProfiles = func() ([]pw.Profile, error) {
		return []pw.Profile{{BaseURL: "https://a.test", AllowedHosts: []string{"api.a.test"}}, {BaseURL: "https://a.test"}}, nil
	}
	names, hosts := v.Scope("demo")
	if !reflect.DeepEqual(names, []string{"BASE_PATH", "PASSWORD"}) || !reflect.DeepEqual(hosts, []string{"api.a.test", "a.test"}) {
		t.Fatalf("Scope = %v %v", names, hosts)
	}
	if _, err := v.ValidateSpec(context.Background(), []byte(loginSpec), nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := calls(); len(got) != 1 || !strings.HasPrefix(got[0], "validateSpec") {
		t.Fatalf("lệnh sidecar = %v", got)
	}
}
