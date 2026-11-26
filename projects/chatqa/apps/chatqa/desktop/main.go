package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"chatqa/internal/agent"
	"chatqa/internal/agentx/httpapi"
	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/live"
	cqmod "chatqa/internal/modules"
	"chatqa/internal/modules/agentchat"
	"chatqa/internal/modules/chat"
	cqmonitor "chatqa/internal/modules/monitor"
	cqtest "chatqa/internal/modules/test"
	mtools "chatqa/internal/modules/tools"
	cqtower "chatqa/internal/modules/tower"
	"chatqa/internal/monitor"
	"chatqa/internal/pw"
	"chatqa/internal/testengine"
	cqtools "chatqa/internal/tools"
	tw "chatqa/internal/tower"
	"chatqa/internal/tower/pool"
	"deskcore/applog"
	"deskcore/cloud"
	"deskcore/config"
	"deskcore/core"
	"deskcore/license"
	"deskcore/modules"
	"deskcore/offline"
	"deskcore/store"
	"deskcore/updater"
)

// UI nhúng sẵn (build từ ../web bằng `npm run build:desktop`). Luôn là đường lui nếu UI OTA lỗi.
//
//go:embed all:frontend/dist
var assets embed.FS

// App: struct bind cho UI => window.go.main.App.* (packages/ui-shell/src/platform/desktop.ts), cùng bộ hàm với HS Desk.
// Chỉ khai báo tường minh các hàm UI được gọi; logic nằm ở lõi dùng chung deskcore/core.
type App struct {
	c *core.App
}

func (a *App) GetState() (*core.AppState, error)                     { return a.c.GetState() }
func (a *App) ActivateLicense(key string) (*core.LicenseInfo, error) { return a.c.ActivateLicense(key) }
func (a *App) ChangePassword(current, next, confirm string) (*store.User, error) {
	return a.c.ChangePassword(current, next, confirm)
}
func (a *App) AuthState() core.AuthState            { return a.c.AuthState() }
func (a *App) AppStates() []core.AppItem            { return a.c.AppStates() }
func (a *App) ListReviewOps() ([]offline.Op, error) { return a.c.ListReviewOps() }
func (a *App) DismissRejected(id string) error      { return a.c.DismissRejected(id) }
func (a *App) Login(username, password string) (*store.User, error) {
	return a.c.Login(username, password)
}
func (a *App) Logout() (int, error)                           { return a.c.Logout() }
func (a *App) CallAPI(method, path, body string) (any, error) { return a.c.CallAPI(method, path, body) }
func (a *App) GoogleToken() (*cloud.GoogleToken, error)       { return a.c.GoogleToken() }
func (a *App) CheckUpdate() (*core.UpdateInfo, error)         { return a.c.CheckUpdate() }
func (a *App) ApplyUpdate(kind string) error                  { return a.c.ApplyUpdate(kind) }
func (a *App) UpdateStatus() *core.UpdateInfo                 { return a.c.UpdateStatus() }

// Đồng bộ (dùng chung). ChatQASoftware chưa có loại thao tác đồng bộ nào nhưng shell vẫn gọi các hàm này.
func (a *App) SyncStatus() offline.Status            { return a.c.SyncStatus() }
func (a *App) SyncNow() offline.Status               { return a.c.SyncNow() }
func (a *App) ListSyncIssues() ([]offline.Op, error) { return a.c.ListSyncIssues() }
func (a *App) ResolveSyncIssue(id string, keepMine bool) error {
	return a.c.ResolveSyncIssue(id, keepMine)
}

// product: ChatQASoftware trên lõi dùng chung (contracts/products.json). CoreAPI đếm riêng với HS Desk,
// tăng mỗi khi đổi chữ ký / đường dẫn các hàm Go mà UI gọi (main.go + modules/*):
//
//	1: main.App.* + tower/test/monitor.Service.Status (khung, chưa có nghiệp vụ)
//	2: test.Service: flow, chạy, dừng, số đo, báo cáo, biên dịch, tự sửa, so sánh, biến bí mật, sổ LLM
//	3: tower.Service: thiết bị, task, sức khoẻ, ngân sách, cảnh báo, điều phối, chạy lại, dừng tất cả, chạm tay;
//	   CompileRequest/RepairRequest thêm confirmToken
//	4: tools.Service: List, Call (cùng danh mục tool với MCP), MCPStatus, EnableMCP, DisableMCP
//	5: chat.Service: Conversations, NewConversation, History, Send, RunTool, Cancel (sự kiện "chat:event")
//	6: tower.Service: TakeOver, HandBack, LiveWatch (sự kiện "live:frame"); Device thêm held
//	7: monitor.Service: Schedules, SaveSchedule, DeleteSchedule, Webhooks, CreateWebhook, SetWebhookEnabled, DeleteWebhook,
//	   Deliveries, Alerts, Uploads (sự kiện "monitor:change")
//	8: test.Service: OpenDiffFolder (mở thư mục chứa diff); GitDiff lưu <repo>_<ngày giờ>.json ở gốc git-impact
//	9: test.Service: LLMCall, ToolCalls, UsageEvents, Track, Insights, StepShot, Retention, SetRetention, ExportRun,
//	   ExportHistory; RunRequest/DispatchRequest thêm artifacts; StepRun thêm evidence; Event thêm at;
//	   OpenRunFolder, OpenRunReport, OpenExportsFolder, RevealFile; xuất ghi thẳng vào <dữ liệu>/exports (không hộp lưu);
//	   bỏ monitor.Service.Uploads và sự kiện webhook "report" (không gửi báo cáo lên Drive nữa)
//	10: tower.Service: BrowserProfiles, SaveBrowserProfile, DeleteBrowserProfile, WebRuntime, InstallWebRuntime, WebAction (event "web:runtime"); Device.rev; test.Service.ExportSpec, test.Service.StepText; SaveVerifiedRequest.script, CompileRequest.startPath
//	11: test.Service: Docs, Doc, SaveDoc, DeleteDoc, DocHistory, DocRevision, DocDiff, Requirements, Coverage, AffectedCases,
//	    AckCase, SetCaseReqs, Notes, AddNote, ResolveNote; CompileRequest.reqs; đồng bộ nhóm SyncConfig, SetSyncConfig,
//	    SetSyncCredentials, ClearSyncCredentials, TestSyncConnection, SyncStatus, SyncPush, SyncPull, SyncConflict,
//	    SyncResolve, SyncKeepMine, SyncTakeTheirs, ShareRun, TeamRuns, OpenTeamRun (sự kiện "test:sync")
//	12: agentchat.Service (chat với đội agent ADK): Status, Send, Cancel, Sessions, Session, DeleteSession, Image,
//	    SetModel, SetEngine, ReloadConfig (sự kiện "agent:event")
//	13: agentchat.Service.RunPipeline (pipeline sau deploy từ màn Git impact)
//	14: agentchat.Service: Approve, Respond (duyệt tool, trả lời bước duyệt của pipeline); Status.pending; SessionInfo.pending;
//	    Event thêm risk, consequence, payload, resolved
//	15: agentchat.Service: Drafts, ApplyDraft, DiscardDraft (bản nháp sửa flow của FlowFixer)
var product = config.Product{Code: "chatqa", Name: "ChatQASoftware", DirName: "ChatQASoftware", LogName: "chatqa.log", CoreAPI: 15}

func main() {
	config.Use(product)
	modules.Use(cqmod.Catalog)
	// Vừa cập nhật exe: chờ tiến trình cũ thoát hẳn rồi mới mở cửa sổ.
	updater.WaitPIDFromArgs(os.Args[1:])
	dataDir := config.DataDir()
	// Lối vào stdio cho client MCP (Claude Desktop/Code chạy "ChatQASoftware --mcp"): chuyển sang app đang mở, không mở cửa sổ.
	// Đặt trước log ra file để stdout chỉ có JSON-RPC.
	if slices.Contains(os.Args[1:], "--mcp") {
		os.Exit(runMCPStdio(dataDir))
	}
	// CI: "ChatQASoftware --pipeline --repo R --from A [--to B] [--wait]" chạy pipeline sau deploy trên app đang mở, qua
	// API agent trên cổng MCP (cùng CHATQA_MCP_TOKEN). Mã thoát: httpapi.ExitOK và các mã cùng chỗ.
	if slices.Contains(os.Args[1:], "--pipeline") {
		os.Exit(runPipelineCLI(dataDir, os.Args[1:]))
	}
	logPath, closeLog := applog.Setup(dataDir, product.LogName)
	defer closeLog()
	// maestro-runner: tắt telemetry và chốt thư mục driver trước mọi lệnh gọi thư viện.
	if err := testengine.SetupProcess(filepath.Join(dataDir, "maestro-runner")); err != nil {
		log.Fatal(err)
	}
	// Bộ chạy trình duyệt: giữ khoá độc quyền suốt đời tiến trình, rồi mới giết tiến trình Node/trình duyệt mồ côi của
	// lần chạy trước (app sập, bị giết) và dọn phần cài dở, trước khi mở bất kỳ tiến trình con nào. Khoá cấp ở đây vì
	// khoá một phiên bản của Wails chỉ có hiệu lực trong wails.Run: mở app lần hai thì không đụng gì của lần một.
	webRT := &pw.Runtime{Dir: filepath.Join(dataDir, "playwright")}
	defer webRT.Release()
	if owner, n, err := webRT.Startup(); !owner && err != nil {
		log.Printf("bộ chạy trình duyệt: không giữ được khoá, bỏ qua dọn dẹp: %v", err)
	} else if !owner {
		log.Printf("bộ chạy trình duyệt: một phiên bản app khác đang giữ, bỏ qua dọn dẹp")
	} else if err != nil {
		log.Printf("bộ chạy trình duyệt: dọn tiến trình cũ/phiên bản cũ: %v", err)
	} else if n > 0 {
		log.Printf("bộ chạy trình duyệt: đã dừng %d tiến trình mồ côi", n)
	}
	sidecar := &pw.Sidecar{RT: webRT}
	drivers := testengine.NewPool()
	metrics, err := testengine.OpenMetrics(filepath.Join(dataDir, "testengine.db"))
	if err != nil {
		log.Printf("không mở được kho số đo kiểm thử: %v", err) // app vẫn chạy; Kiểm thử báo test_engine_unavailable
	}
	var engine *testengine.Engine
	if metrics != nil {
		defer metrics.Close()
		engine = testengine.NewEngine(dataDir, drivers, metrics, testengine.NewSecrets(dataDir, product.Name))
		engine.Web = &testengine.Web{RT: webRT, Sidecar: sidecar}
		drivers.OpenWeb = engine.OpenWeb
		webRT.InUse = func() bool { return sidecar.Running() || engine.WebBusy() }
		// stderr của Node đi qua che bí mật (mọi giá trị trong kho) trước khi vào log của app.
		sidecar.Scrub = func(line string) string { return testengine.Redact(line, engine.SecretValues()) }
		// Sidecar chết thì mọi phiên trình duyệt mất theo: bỏ driver web, trả máy web đang giữ (tháp ghi thêm sự kiện).
		sidecar.OnDown = func(gen int) { engine.WebDown(gen) }
	}
	var tower *tw.Tower
	if engine != nil {
		if store, err := tw.OpenStore(filepath.Join(dataDir, "tower.db")); err != nil {
			log.Printf("không mở được kho điều phối: %v", err)
		} else {
			defer store.Close()
			local := pool.NewLocal(engine, &pool.Discoverer{Preflight: engine.Preflight}, store)
			local.Profiles, local.WebReady = store, engine.WebReady // hồ sơ trình duyệt là thiết bị web
			engine.Web.Profile = store.BrowserProfile
			tower = tw.New(engine, store, local)
			sidecar.OnDown = tower.WebDown
			engine.Budget = tower.Guard // biên dịch/sửa từ mọi lối vào đều qua cổng ngân sách
		}
	}
	// agentLazy: đội agent ADK (dựng khi dùng lần đầu); cảnh báo của tháp đọc pipeline đang chờ duyệt từ đây.
	var agentLazy atomic.Pointer[agentrt.Lazy]
	var mon *monitor.Monitor
	if tower != nil {
		if ms, err := monitor.OpenStore(filepath.Join(dataDir, "monitor.db")); err != nil {
			log.Printf("không mở được kho giám sát: %v", err)
		} else {
			defer ms.Close()
			mon = monitor.New(ms, tower, engine.Secrets)
		}
	}
	if tower != nil {
		// Pipeline chờ duyệt hiện như một cảnh báo của máy: danh sách cảnh báo và webhook "alert" của Giám sát báo người duyệt.
		tower.ExtraAlerts = func() []tw.Alert {
			var out []tw.Alert
			if mon != nil {
				out = mon.ExtraAlerts()
			}
			return append(out, pipelineAlerts(agentLazy.Load())...)
		}
	}
	log.Printf("%s %s (%s) khởi động, log: %s", product.Name, config.Version, config.Platform, logPath)

	// Trước khi hiện cửa sổ: áp dụng bản exe đã tải sẵn ("Để sau"), hoặc quay về bản cũ nếu bản mới lỗi.
	if bin, err := updater.Current(); err == nil {
		relPub, _ := license.DecodePublicKey(config.ReleasePublicKey)
		if updater.OnLaunch(bin, updater.OpenBootGuard(dataDir), config.Version, relPub, bin.Relaunch) {
			return
		}
	}

	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	ui := updater.NewSwitchFS(dist, config.Version)
	ui.LoadOTA(dataDir, product.CoreAPI, config.Version) // dùng UI OTA nếu có và hợp lệ

	// Chưa có kho cục bộ (nil = hàng đợi trong bộ nhớ): dữ liệu chạy thử, flow, số đo sẽ có kho SQLite riêng của ChatQASoftware.
	var mcp *cqtools.Server
	var history *agent.History
	if tower != nil {
		mcp = &cqtools.Server{Handler: &cqtools.Handler{Version: config.Version}, Store: tower.Store}
		if history, err = agent.OpenHistory(filepath.Join(dataDir, "chat.db")); err != nil {
			log.Printf("không mở được lịch sử chat: %v", err)
		} else {
			defer history.Close()
		}
	}
	hub := &agent.Hub{}
	var appCtx context.Context
	// wailsCtx: context của cửa sổ cho sự kiện phát từ goroutine của Service (đặt ở OnStartup).
	var wailsCtx atomic.Pointer[context.Context]
	emit := func(event string, data any) {
		if ctx := wailsCtx.Load(); ctx != nil {
			runtime.EventsEmit(*ctx, event, data)
		}
	}
	// onRunEnd: tự chia sẻ evidence khi lượt xong; newModules gắn (mỗi lần dựng module), goroutine lượt chạy đọc.
	var onRunEnd atomic.Pointer[func(runID string)]
	c, err := core.New(ui, dataDir, config.APIBase, config.LicensePublicKey, config.ReleasePublicKey, nil,
		newModules(dataDir, engine, tower, mon, mcp, history, hub, emit, &onRunEnd, &agentLazy))
	if err != nil {
		log.Fatal(err)
	}
	app := &App{c: c}
	// Lịch sử sử dụng (chỉ trên máy) và dọn dữ liệu cũ theo số ngày giữ; dừng khi thoát app.
	retentionCtx, stopRetention := context.WithCancel(context.Background())
	defer stopRetention()
	if metrics != nil {
		if err := metrics.RecordUsage(time.Now(), "app_start", map[string]any{"version": config.Version, "platform": config.Platform}, nil); err != nil {
			log.Printf("lịch sử sử dụng: %v", err)
		}
		engine.StartRetention(retentionCtx)
	}

	err = wails.Run(&options.App{
		Title:            product.Name,
		Width:            1440,
		Height:           920,
		MinWidth:         1100,
		MinHeight:        680,
		BackgroundColour: &options.RGBA{R: 248, G: 250, B: 252, A: 255},
		AssetServer:      &assetserver.Options{Assets: ui},
		OnStartup: func(ctx context.Context) {
			appCtx = ctx
			wailsCtx.Store(&ctx)
			c.Reload = func() { runtime.WindowReloadApp(ctx) }
			c.Quit = func() { runtime.Quit(ctx) }
			c.Emit = func(event string, data any) { runtime.EventsEmit(ctx, event, data) }
			if engine != nil {
				engine.OnEvent = func(ev testengine.Event) {
					runtime.EventsEmit(ctx, "test:event", ev)
					if fn := onRunEnd.Load(); ev.Kind == "run_end" && fn != nil {
						(*fn)(ev.RunID) // không chặn: đẩy evidence chạy nền
					}
				}
				engine.Web.OnRuntime = func(ev testengine.WebRuntimeEvent) { runtime.EventsEmit(ctx, "web:runtime", ev) }
			}
			if tower != nil {
				tower.OnFleet = func(d []pool.Device) { runtime.EventsEmit(ctx, "tower:fleet", d) }
				tower.OnTask = func(t tw.Task) {
					runtime.EventsEmit(ctx, "tower:task", t)
					if mon != nil {
						mon.OnTask(t) // sự kiện webhook
					}
				}
				if tower.Live != nil {
					tower.Live.Emit = func(f live.Frame) { runtime.EventsEmit(ctx, "live:frame", f) }
				}
				tower.Start(ctx)
				if mon != nil {
					mon.OnChange = func() { runtime.EventsEmit(ctx, "monitor:change", nil) }
					mon.Start(ctx)
				}
			}
			hub.Set(func(e agent.Event) { runtime.EventsEmit(ctx, "chat:event", e) })
			if mcp != nil {
				if err := mcp.Start(); err != nil { // đã bật từ lần trước: mở lại cổng
					log.Printf("mcp: %v", err)
				}
			}
			c.Startup(ctx)
			drivers.StartReaper(ctx)
		},
		// Thoát app: dừng agent trên mọi thiết bị, không để phiên driver hay cổng forward nào sống sót.
		OnShutdown: func(context.Context) {
			stopRetention()
			if lz := agentLazy.Load(); lz != nil {
				lz.Close()
			}
			if metrics != nil {
				if err := metrics.RecordUsage(time.Now(), "app_stop", map[string]any{"version": config.Version}, nil); err != nil {
					log.Printf("lịch sử sử dụng: %v", err)
				}
			}
			if mcp != nil {
				_ = mcp.Stop()
			}
			if engine != nil {
				engine.StopAll(3 * time.Second)
			}
			drivers.CloseAll(3 * time.Second)
			_ = sidecar.Close() // sau CloseAll: phiên trình duyệt đã đóng, giờ dừng tiến trình Node
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "chatqa-3e8a51d4-desktop",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) {
				// Mở lần 2 => đưa cửa sổ hiện có lên trước
				if appCtx != nil {
					runtime.WindowUnminimise(appCtx)
					runtime.WindowShow(appCtx)
				}
			},
		},
		// Mỗi phân hệ 1 Service => UI gọi window.go.<pkg>.Service.<Hàm>.
		// Thêm app mới: thêm Service vào newModules + tăng product.CoreAPI (docs/ADD_APP.md).
		Bind:    append([]interface{}{app}, c.Modules...),
		Windows: &windows.Options{Theme: windows.Light},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// newModules: tạo Service các phân hệ ChatQASoftware. Mọi hàm của Service tự chặn theo bản quyền và quyền người dùng (RequireApp/RequirePerm).
// engine/tower nil = Kiểm thử/Điều phối báo test_engine_unavailable; engine gọi Claude qua Worker bằng d.AIMessages.
// Danh mục tool dựng trên chính các Service này, nên chat trong app và MCP đi qua cùng kiểm tra quyền và ngân sách.
// emit phát sự kiện Wails (đồng bộ nhóm "test:sync"); onRunEnd nhận hàm tự chia sẻ evidence để gắn vào run_end.
func newModules(dataDir string, engine *testengine.Engine, tower *tw.Tower, mon *monitor.Monitor, mcp *cqtools.Server, history *agent.History, hub *agent.Hub,
	emit func(event string, data any), onRunEnd *atomic.Pointer[func(runID string)], agentLazy *atomic.Pointer[agentrt.Lazy]) core.ModuleFactory {
	return func(d core.ModuleDeps) []any {
		if engine != nil {
			engine.LLM = d.AIMessages
		}
		// Giá trị bí mật hiện có (biến của flow và khoá ký webhook): chỉ để che trong kết quả tool và chat, không gửi đi đâu.
		secrets := func() []string {
			if engine == nil {
				return nil
			}
			return engine.SecretValues()
		}
		syncDeps := cqtest.SyncDeps{Tenant: sessionTenant(d.Host), Emit: emit}
		towerSvc, testSvc, monitorSvc := cqtower.New(d.Host, tower), cqtest.New(d.Host, engine, syncDeps), cqmonitor.New(d.Host, mon)
		hook := cqtest.RunEndHook(testSvc)
		onRunEnd.Store(&hook)
		if mon != nil {
			// Lịch chạy dưới tên người đang đăng nhập, khi bản quyền còn bật Giám sát và Kiểm thử và người đó còn quyền chạy
			// và quyền lịch (tài khoản bị khoá, mất quyền: không chạy).
			mon.Gate = func() (offline.Actor, error) {
				for _, app := range []modules.Code{cqmod.Monitor, cqmod.Test} {
					if err := d.Host.RequireApp(app); err != nil {
						return offline.Actor{}, err
					}
				}
				for _, p := range []string{modules.PermCQRun, modules.PermCQAutomations} {
					if err := d.Host.RequirePerm(p); err != nil {
						return offline.Actor{}, err
					}
				}
				return d.Host.WorkingActor()
			}
		}
		var registry *cqtools.Registry
		chatDeps := chat.Deps{Hub: hub}
		if tower != nil && mcp != nil {
			registry = cqtools.Catalog(towerSvc, testSvc, monitorSvc, tower.Pool)
			registry.Secrets = secrets
			registry.Journal = func(c testengine.ToolCall) {
				if err := engine.Metrics.RecordToolCall(c); err != nil {
					log.Printf("sổ tool: %v", err)
				}
			}
			mcp.Handler.Registry = registry
			if lz := newAgentRuntime(dataDir, d, registry, engine, tower); lz != nil {
				agentLazy.Store(lz)
			}
			mcp.Owner = func() (string, error) {
				a, err := d.Host.WorkingActor()
				return a.UserID, err
			}
			if history != nil {
				chatDeps = newChatDeps(d, engine, tower, registry, history, hub, secrets)
			}
		}
		if mcp != nil {
			mcp.SetAgent(newAgentHTTP(dataDir, d, agentLazy.Load(), emit))
		}
		return []any{towerSvc, testSvc, monitorSvc, mtools.New(d.Host, registry, mcp), chat.New(d.Host, chatDeps), agentchat.New(d.Host, agentLazy.Load(), dataDir, emit)}
	}
}

// stateReader: host đọc được trạng thái phiên (core.App đáp ứng).
type stateReader interface {
	GetState() (*core.AppState, error)
}

// sessionTenant: tổ chức của phiên đăng nhập (store.User.Tenant) cho prefix bucket đồng bộ nhóm; "" = chưa đăng nhập
// hoặc phiên hết hạn khi có mạng. GetState kiểm tra mạng (tới 2 giây) và có thể làm mới bản quyền, nên kết quả có tổ chức
// được nhớ ngắn hạn: màn Đồng bộ và công cụ MCP gọi liên tục mà không phải chờ lần nào cũng thế.
func sessionTenant(h modules.Host) func() string {
	sr, ok := h.(stateReader)
	if !ok {
		return func() string { return "" }
	}
	const keep = 30 * time.Second
	var (
		mu     sync.Mutex
		tenant string
		at     time.Time
	)
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		if tenant != "" && time.Since(at) < keep {
			return tenant
		}
		st, err := sr.GetState()
		if err != nil || st == nil || st.User == nil {
			tenant = ""
			return ""
		}
		tenant, at = st.User.Tenant, time.Now()
		return tenant
	}
}

// newChatDeps dựng agent chat: Claude qua Worker (stream), cổng ngân sách của tháp, sổ LLM của engine, lệnh ngắn
// trên thiết bị và flow hiện có. Giá trị bí mật chỉ dùng để che nếu người dùng lỡ gõ vào chat.
func newChatDeps(d core.ModuleDeps, engine *testengine.Engine, tower *tw.Tower, registry *cqtools.Registry, history *agent.History, hub *agent.Hub, secrets func() []string) chat.Deps {
	fleet := func() []pool.Device {
		devs, _ := tower.Fleet(d.Host.Context())
		return devs
	}
	a := agent.New(d.AIMessagesStream, registry, tower.Guard, engine.Metrics)
	a.Secrets = secrets
	a.Context = func(context.Context) string {
		var usable []string
		for _, dev := range fleet() {
			if dev.Usable() {
				usable = append(usable, fmt.Sprintf("%s (%s %s)", dev.ID, dev.Platform, dev.Model))
			}
		}
		return fmt.Sprintf("<context>Giờ: %s. Máy rảnh: %d %v.</context>", time.Now().Format("2006-01-02 15:04"), len(usable), usable)
	}
	resolver := &agent.Resolver{Fleet: fleet, Flows: func() map[string][]string {
		out := map[string][]string{}
		apps, _ := engine.Flows.Apps()
		for _, app := range apps {
			infos, _ := engine.Flows.List(app)
			for _, f := range infos {
				out[app] = append(out[app], f.Name)
			}
		}
		return out
	}}
	return chat.Deps{Agent: a, History: history, Resolver: resolver, Registry: registry, Hub: hub, Secrets: secrets}
}

// mcpBase: địa chỉ máy chủ HTTP cục bộ của app (cổng MCP đã lưu, mặc định DefaultMCPPort).
func mcpBase(dataDir string) (string, error) {
	store, err := tw.OpenStore(filepath.Join(dataDir, "tower.db"))
	if err != nil {
		return "", err
	}
	port := store.Setting("mcp.port")
	store.Close()
	if port == "" {
		port = strconv.Itoa(cqtools.DefaultMCPPort)
	}
	return "http://127.0.0.1:" + port, nil
}

// runMCPStdio: chuyển MCP qua stdio sang máy chủ HTTP cục bộ của app đang mở. Token lấy từ CHATQA_MCP_TOKEN.
func runMCPStdio(dataDir string) int {
	base, err := mcpBase(dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "chatqa --mcp:", err)
		return 1
	}
	token := os.Getenv("CHATQA_MCP_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "chatqa --mcp: đặt CHATQA_MCP_TOKEN bằng token hiện trong ChatQASoftware (Bật MCP)")
		return 2
	}
	if err := cqtools.RunStdio(os.Stdin, os.Stdout, base+"/mcp", token); err != nil {
		fmt.Fprintln(os.Stderr, "chatqa --mcp:", err)
		return 1
	}
	return 0
}

// runPipelineCLI: "--pipeline" cho CI, gửi sang API agent của app đang mở (cần MCP bật, agent.http.enabled và
// CHATQA_MCP_TOKEN). Mã thoát (httpapi.ExitOK...ExitTimeout): 0 xong hoặc đã chạy, 1 lỗi, 2 sai tham số hoặc thiếu
// token, 3 có flow lỗi, 4 chờ duyệt, 5 hết giờ chờ.
func runPipelineCLI(dataDir string, args []string) int {
	cli, err := httpapi.ParseCLI(args, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "chatqa --pipeline:", err)
		return httpapi.ExitUsage
	}
	token := os.Getenv("CHATQA_MCP_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "chatqa --pipeline: đặt CHATQA_MCP_TOKEN bằng token hiện trong ChatQASoftware (Bật MCP)")
		return httpapi.ExitUsage
	}
	base, err := mcpBase(dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "chatqa --pipeline:", err)
		return httpapi.ExitError
	}
	return httpapi.RunCLI(context.Background(), httpapi.Client{Base: base, Token: token}, cli, os.Stdout, os.Stderr)
}
