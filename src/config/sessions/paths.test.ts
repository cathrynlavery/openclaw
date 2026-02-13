import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
  validateSessionId,
} from "./paths.js";

describe("resolveStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const resolved = resolveStorePath("~/.openclaw/agents/{agentId}/sessions/sessions.json", {
      agentId: "research",
    });

    expect(resolved).toBe(
      path.resolve("/srv/openclaw-home/.openclaw/agents/research/sessions/sessions.json"),
    );
  });
});

describe("session path safety", () => {
  it("validates safe session IDs", () => {
    expect(validateSessionId("sess-1")).toBe("sess-1");
    expect(validateSessionId("ABC_123.hello")).toBe("ABC_123.hello");
  });

  it("validates session IDs with channel routing characters", () => {
    expect(validateSessionId("imessage:direct:+17189153805")).toBe("imessage:direct:+17189153805");
    expect(validateSessionId("imessage:direct:cathryn@littlemight.com")).toBe(
      "imessage:direct:cathryn@littlemight.com",
    );
    expect(validateSessionId("slack:direct:u06g8spt4bx:thread:1770948912.577419")).toBe(
      "slack:direct:u06g8spt4bx:thread:1770948912.577419",
    );
  });

  it("rejects unsafe session IDs", () => {
    expect(() => validateSessionId("../etc/passwd")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("a/b")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("a\\b")).toThrow(/Invalid session ID/);
    expect(() => validateSessionId("/abs")).toThrow(/Invalid session ID/);
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("rejects unsafe sessionFile candidates that escape the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "../../etc/passwd" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "/etc/passwd" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);

    expect(() =>
      resolveSessionFilePath("sess-1", { sessionFile: "/tmp/outside/file.jsonl" }, { sessionsDir }),
    ).toThrow(/within sessions directory/);
  });

  it("accepts absolute paths within the same agent sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/main/sessions/subdir/threaded-session.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(
      path.resolve("/tmp/openclaw/agents/main/sessions/subdir/threaded-session.jsonl"),
    );
  });

  it("accepts cross-agent absolute paths within another agent sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/default/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "/tmp/openclaw/agents/knox/sessions/uuid-1234.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve("/tmp/openclaw/agents/knox/sessions/uuid-1234.jsonl"));
  });

  it("rejects absolute paths under agents root that are not in a sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/default/sessions";

    expect(() =>
      resolveSessionFilePath(
        "sess-1",
        { sessionFile: "/tmp/openclaw/agents/knox/not-sessions/uuid-1234.jsonl" },
        { sessionsDir },
      ),
    ).toThrow(/within sessions directory/);
  });

  it("rejects absolute paths to agent config files under <agent>/agent/*", () => {
    const sessionsDir = "/tmp/openclaw/agents/default/sessions";

    expect(() =>
      resolveSessionFilePath(
        "sess-1",
        { sessionFile: "/tmp/openclaw/agents/knox/agent/auth-profiles.json" },
        { sessionsDir },
      ),
    ).toThrow(/within sessions directory/);
  });

  it("accepts sessionFile candidates within the sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    const resolved = resolveSessionFilePath(
      "sess-1",
      { sessionFile: "subdir/threaded-session.jsonl" },
      { sessionsDir },
    );

    expect(resolved).toBe(path.resolve(sessionsDir, "subdir/threaded-session.jsonl"));
  });

  it("uses agent sessions dir fallback for transcript path", () => {
    const resolved = resolveSessionTranscriptPath("sess-1", "main");
    expect(resolved.endsWith(path.join("agents", "main", "sessions", "sess-1.jsonl"))).toBe(true);
  });
});
