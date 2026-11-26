package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// SetAgentModel sets the model alias of one agent in agent.yaml.
func SetAgentModel(dataDir, agent, alias string) error {
	if !isKnownAgent(agent) {
		return fmt.Errorf("unknown agent %q", agent)
	}
	return edit(dataDir, func(root *yaml.Node) error {
		m := child(child(child(root, "agent", true), "agents", true), agent, true)
		setScalar(child(m, "model", true), alias)
		m.Style = yaml.FlowStyle // keeps the one-line "{ model: x }" form of the default file
		return nil
	})
}

// SetEngine switches between the legacy chat and the ADK agents.
func SetEngine(dataDir, engine string) error {
	return edit(dataDir, func(root *yaml.Node) error {
		setScalar(child(child(root, "agent", true), "engine", true), engine)
		return nil
	})
}

// SetEnabled turns the agent on or off.
func SetEnabled(dataDir string, enabled bool) error {
	v := "false"
	if enabled {
		v = "true"
	}
	return edit(dataDir, func(root *yaml.Node) error {
		n := child(child(root, "agent", true), "enabled", true)
		setScalar(n, v)
		n.Tag = "!!bool"
		return nil
	})
}

// edit changes the YAML tree (comments survive), validates the result with the same rules as Load, and replaces the
// file atomically with mode 0600. On any error the old file stays as it was.
func edit(dataDir string, fn func(root *yaml.Node) error) error {
	path := filepath.Join(dataDir, FileName)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		raw = defaultYAML
	} else if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return err
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 {
		return errors.New("agent.yaml is empty")
	}
	if err := fn(doc.Content[0]); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	if _, err := parse(buf.Bytes()); err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, FileName+".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// child returns the value node under key in a mapping, adding an empty mapping or scalar when create is set.
func child(n *yaml.Node, key string, create bool) *yaml.Node {
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	if !create {
		return nil
	}
	v := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, v)
	return v
}

func setScalar(n *yaml.Node, value string) {
	n.Kind, n.Tag, n.Value, n.Content, n.Style = yaml.ScalarNode, "!!str", value, nil, 0
}
