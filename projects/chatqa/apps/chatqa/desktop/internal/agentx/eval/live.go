package eval

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"google.golang.org/adk/v2/model"

	"chatqa/internal/agentx/config"
	"chatqa/internal/agentx/models"
	"deskcore/cloud"
)

// LiveEnv is the environment variable that switches the eval to the real Worker.
const LiveEnv = "CHATQA_EVAL_LIVE"

// Live reaches the Worker as the signed-in app does: the Worker address, the user's session token and the device's
// licence headers. It spends the user's real AI budget.
type Live struct {
	Worker, Session, DeviceID, DeviceHash string
	// Models is the Worker alias each agent runs on (agent.yaml); empty = the built-in defaults.
	Models config.Config
}

// LiveFromEnv reads CHATQA_EVAL_WORKER, CHATQA_EVAL_SESSION, CHATQA_EVAL_DEVICE_ID and CHATQA_EVAL_DEVICE_HASH. The
// values are used only for the requests; nothing is written to a recording.
func LiveFromEnv() (Live, error) {
	l := Live{
		Worker:     strings.TrimSpace(os.Getenv("CHATQA_EVAL_WORKER")),
		Session:    strings.TrimSpace(os.Getenv("CHATQA_EVAL_SESSION")),
		DeviceID:   strings.TrimSpace(os.Getenv("CHATQA_EVAL_DEVICE_ID")),
		DeviceHash: strings.TrimSpace(os.Getenv("CHATQA_EVAL_DEVICE_HASH")),
		Models:     config.Defaults(),
	}
	if l.Worker == "" || l.Session == "" {
		return Live{}, errors.New("set CHATQA_EVAL_WORKER (Worker API address) and CHATQA_EVAL_SESSION (a signed-in session token)")
	}
	return l, nil
}

// Source is the LLMSource over the Worker: each agent gets the model alias agent.yaml gives it.
func (l Live) Source() (LLMSource, error) {
	c := cloud.New(l.Worker, "chatqa")
	c.HTTP = &http.Client{Timeout: 5 * time.Minute}
	c.Session = func() string { return l.Session }
	c.Device = func() (string, string) { return l.DeviceID, l.DeviceHash }
	f, err := models.NewFactory(c)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context, agentName string) (model.LLM, error) {
		return f.LLM(ctx, l.Models.ModelFor(agentName))
	}, nil
}
