package runtime

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeMCPServerArg makes the test binary act as the fixture MCP server over stdio, so stdio tests start a real child
// process without any network or a server installed on the machine.
const fakeMCPServerArg = "chatqa-fake-mcp-server"

func TestMain(m *testing.M) {
	if slices.Contains(os.Args[1:], fakeMCPServerArg) {
		if err := (&fakeMCP{}).server().Run(context.Background(), &mcp.StdioTransport{}); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
