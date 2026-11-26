package tower

import (
	"context"
	"sort"
	"strings"
	"testing"

	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	"deskcore/apperr"
)

// kindRig: rig có 3 điện thoại, app demo có YAML và login.spec.ts, và n hồ sơ trình duyệt (bộ chạy giả, bộ kiểm tra spec
// giả, bộ chạy spec trả ngay).
func kindRig(t *testing.T, profiles int) *rig {
	t.Helper()
	r := webRig(t)
	r.setFound(android("emu-1"), android("emu-2"), android("emu-3"))
	r.poll(t)
	writeSpec(t, r, "login.spec.ts")
	r.t.Engine.Flows.Specs = okSpecs{}
	r.t.Engine.SpecRunner = quickRunner{}
	for i := 0; i < profiles; i++ {
		p := webProfile()
		p.ID = []string{"web-a", "web-b", "web-c"}[i]
		if _, err := r.t.SaveProfile(context.Background(), p); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

// quickRunner: lượt playwright test giả đạt ngay.
type quickRunner struct{}

func (quickRunner) Run(_ context.Context, _ pw.Job, on func(pw.Event)) (pw.Result, error) {
	on(pw.Event{Type: pw.EventTest, Test: "t1", Title: "x", Status: "passed", DurationMs: 5})
	on(pw.Event{Type: pw.EventEnd, Status: "passed"})
	return pw.Result{Ended: true, Status: "passed"}, nil
}

func picked(t *testing.T, r *rig, req DispatchRequest) ([]string, error) {
	t.Helper()
	kinds, err := r.t.Engine.Flows.Kinds(req.App, req.Flows)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := r.t.pick(context.Background(), req, kinds)
	sort.Strings(ids)
	return ids, err
}

func TestPickCountsPerKind(t *testing.T) {
	r := kindRig(t, 3)
	ids, err := picked(t, r, DispatchRequest{App: "demo", Filter: DeviceFilter{Count: 2}})
	if err != nil || strings.Join(ids, ",") != "emu-1,emu-2,web-a,web-b" {
		t.Fatalf("mọi flow, count=2 = %v, %v (muốn 2 máy mỗi loại)", ids, err)
	}
	ids, err = picked(t, r, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml", "login.spec.ts"}, Filter: DeviceFilter{Count: 1}})
	if err != nil || strings.Join(ids, ",") != "emu-1,web-a" {
		t.Fatalf("flow trộn, count=1 = %v, %v", ids, err)
	}
	ids, err = picked(t, r, DispatchRequest{App: "demo", Filter: DeviceFilter{Platform: testengine.PlatformWeb}})
	if err != nil || strings.Join(ids, ",") != "web-a,web-b,web-c" {
		t.Fatalf("lọc web = %v, %v", ids, err)
	}
	if _, err := picked(t, r, DispatchRequest{App: "demo", Filter: DeviceFilter{Count: 4}}); apperr.CodeOf(err) != CodeNoDevice {
		t.Fatalf("count lớn hơn số máy của một loại: %v", err)
	}
	if _, err := picked(t, r, DispatchRequest{App: "demo", Filter: DeviceFilter{Platform: "desktop"}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("nền tảng lạ: %v", err)
	}
}

func TestPickNamedKindWithoutDeviceIsNoDevice(t *testing.T) {
	r := kindRig(t, 0)
	_, err := picked(t, r, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml", "login.spec.ts"}})
	if apperr.CodeOf(err) != CodeNoDevice || !strings.Contains(err.Error(), "web") {
		t.Fatalf("spec gọi tên mà không có hồ sơ trình duyệt: %v", err)
	}
	// Chạy mọi flow: loại không có máy bị bỏ, YAML vẫn chạy.
	ids, err := picked(t, r, DispatchRequest{App: "demo"})
	if err != nil || strings.Join(ids, ",") != "emu-1,emu-2,emu-3" {
		t.Fatalf("mọi flow không có hồ sơ = %v, %v", ids, err)
	}
}

func TestPickExplicitDeviceNeedsAFlowOfItsKind(t *testing.T) {
	r := kindRig(t, 1)
	if _, err := picked(t, r, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml"}, Devices: []string{"web-a"}}); apperr.CodeOf(err) != apperr.CodeInvalid {
		t.Fatalf("hồ sơ trình duyệt với flow YAML: %v", err)
	}
	if ids, err := picked(t, r, DispatchRequest{App: "demo", Devices: []string{"web-a", "emu-1"}}); err != nil || len(ids) != 2 {
		t.Fatalf("mọi flow trên máy chỉ định cả hai loại: %v, %v", ids, err)
	}
}

// Spec gọi tên mà chỉ chọn điện thoại: spec thành flow lỗi, task lỗi (không bao giờ "đạt" khi thiếu phần web).
func TestDispatchNamedSpecWithPhonesOnlyFailsTask(t *testing.T) {
	r := kindRig(t, 0)
	ctx := context.Background()
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml", "login.spec.ts"}, Devices: []string{"emu-1"}})
	if err != nil {
		t.Fatal(err)
	}
	done, _ := r.t.Wait(ctx, task.ID)
	if done.Status != TaskFailed || done.Passed != 1 || done.Failed != 1 {
		t.Fatalf("task = %+v", done)
	}
	card, err := r.t.Report(task.ID)
	if err != nil || len(card.Failures) != 1 || card.Failures[0].Flow != "login.spec.ts" || card.Failures[0].DeviceID != "" {
		t.Fatalf("thẻ báo cáo = %+v, %v", card.Failures, err)
	}
	if _, err := r.t.ReplayFailed(ctx, actor, task.ID); apperr.CodeOf(err) != CodeNoDevice {
		t.Fatalf("chạy lại flow web khi vẫn không có hồ sơ: %v", err)
	}
}

// Lịch giám sát gọi mọi flow lọc Android trên app có spec, máy chưa cài bộ chạy web: chỉ YAML chạy, không lỗi.
func TestDispatchAllFlowsAndroidIgnoresSpecsWithoutWebRuntime(t *testing.T) {
	r := newRig(t)
	r.setFound(android("emu-1"))
	r.poll(t)
	writeSpec(t, r, "login.spec.ts")
	if r.t.Engine.Web != nil {
		t.Fatal("rig phải không có bộ chạy web")
	}
	ctx := context.Background()
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Secrets: []string{"PASSWORD"}, Filter: DeviceFilter{Platform: testengine.PlatformAndroid}})
	if err != nil {
		t.Fatal(err)
	}
	done, _ := r.t.Wait(ctx, task.ID)
	if done.Status != TaskPassed || done.Passed != 2 || done.Failed != 0 {
		t.Fatalf("task = %+v", done)
	}
}

// Một task trộn: YAML trên điện thoại và spec trên hồ sơ trình duyệt chạy cùng lượt, count áp theo loại.
func TestDispatchMixedTaskRunsBothKinds(t *testing.T) {
	r := kindRig(t, 2)
	ctx := context.Background()
	task, err := r.t.Dispatch(ctx, actor, DispatchRequest{App: "demo", Flows: []string{"02_home.yaml", "login.spec.ts"}, Filter: DeviceFilter{Count: 2}})
	if err != nil {
		t.Fatal(err)
	}
	done, _ := r.t.Wait(ctx, task.ID)
	if done.Status != TaskPassed || done.Passed != 4 {
		t.Fatalf("task = %+v", done)
	}
	flows, _ := r.t.Engine.Metrics.FlowRuns(done.RunID)
	byDev := map[string]string{}
	for _, f := range flows {
		byDev[f.DeviceID] = f.Flow + "@" + f.Platform
	}
	if byDev["web-a"] != "login.spec.ts@web" || byDev["web-b"] != "login.spec.ts@web" || byDev["emu-1"] != "02_home.yaml@android" ||
		byDev["emu-2"] != "02_home.yaml@android" {
		t.Fatalf("flow theo thiết bị = %v", byDev)
	}
}
