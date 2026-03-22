import { describe, test, expect } from "bun:test";
import { systemToolDefinitions } from "./system-tools.js";
import { toAnthropicTool } from "./tool-definition.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { AgentDependencies, ToolContext, WorkspaceStore } from "../types.js";
import type { UserStore } from "../users/store.js";

// --- 픽스처 ---

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    userId: "Uowner1234",
    role: "member",
    ...overrides,
  };
}

function makeWorkspace(overrides?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: "ws-001",
    name: "TestWorkspace",
    ownerId: "Uowner1234",
    gwsAuthenticated: false,
    createdAt: "2024-01-01T00:00:00Z",
    members: {
      Uowner1234: {
        role: "owner",
        joinedAt: "2024-01-01T00:00:00Z",
        invitedBy: "system",
      },
    },
    ...overrides,
  };
}

function makeDeps(overrides?: {
  ownedWorkspaces?: WorkspaceRecord[];
  createdWorkspace?: WorkspaceRecord;
  setDefaultCalls?: Array<{ userId: string; workspaceId: string }>;
  allWorkspaces?: WorkspaceRecord[];
  memberWorkspaces?: WorkspaceRecord[];
  getWorkspace?: (id: string) => WorkspaceRecord | undefined;
  getUserRole?: (wsId: string, userId: string) => "owner" | "member" | undefined;
  isSystemAdmin?: (userId: string) => boolean;
  lastWorkspaceId?: string;
}): AgentDependencies {
  const setDefaultCalls = overrides?.setDefaultCalls ?? [];
  const createdWs = overrides?.createdWorkspace ?? makeWorkspace();

  return {
    registry: { definitions: [], executors: new Map() },
    pendingActionStore: {} as AgentDependencies["pendingActionStore"],
    getGwsExecutors: async () => new Map(),
    workspaceStore: {
      getByOwner: () => overrides?.ownedWorkspaces ?? [],
      create: async () => createdWs,
      getAll: () => overrides?.allWorkspaces ?? [],
      getByMember: () => overrides?.memberWorkspaces ?? [],
      get: overrides?.getWorkspace ?? (() => undefined),
      getUserRole: overrides?.getUserRole ?? (() => undefined),
    } as unknown as WorkspaceStore,
    userStore: {
      setLastWorkspaceId: async (userId: string, workspaceId: string) => {
        setDefaultCalls.push({ userId, workspaceId });
      },
      getLastWorkspaceId: () => overrides?.lastWorkspaceId,
      isSystemAdmin: overrides?.isSystemAdmin ?? (() => false),
    } as unknown as UserStore,
  };
}

// --- 레지스트리 테스트 ---

describe("systemToolDefinitions registry", () => {
  test("create_workspace 포함", () => {
    const names = systemToolDefinitions.map((d) => d.name);
    expect(names).toContain("create_workspace");
  });

  test("8개 도구 정의", () => {
    expect(systemToolDefinitions).toHaveLength(8);
  });

  test("모든 정의에 strict: true 설정", () => {
    for (const def of systemToolDefinitions) {
      expect(def.strict).toBe(true);
    }
  });

  test("toAnthropicTool 변환: additionalProperties: false", () => {
    for (const def of systemToolDefinitions) {
      const tool = toAnthropicTool(def);
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });
});

// --- create_workspace 핸들러 테스트 ---

describe("create_workspace handler", () => {
  test("성공: 워크스페이스 생성 + lastWorkspaceId 설정", async () => {
    const setDefaultCalls: Array<{ userId: string; workspaceId: string }> = [];
    const createdWs = makeWorkspace({ id: "ws-new", name: "MyWorkspace" });
    const deps = makeDeps({ ownedWorkspaces: [], createdWorkspace: createdWs, setDefaultCalls });
    const ctx = makeContext({ userId: "Unewuser0001" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const signal = await def.handler({ name: "MyWorkspace", owner_user_id: null }, ctx, deps);

    const result = JSON.parse(signal.toolResult);
    expect(result.workspaceId).toBe("ws-new");
    expect(result.name).toBe("MyWorkspace");
    expect(result.message).toContain("created successfully");

    // lastWorkspaceId 설정 확인
    expect(setDefaultCalls).toHaveLength(1);
    expect(setDefaultCalls[0]).toEqual({
      userId: "Unewuser0001",
      workspaceId: "ws-new",
    });
  });

  test("이름 검증 실패: 빈 이름", async () => {
    const deps = makeDeps();
    const ctx = makeContext();

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const signal = await def.handler({ name: "  ", owner_user_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("empty");
  });

  test("일반 사용자 소유 제한: 8개 소유 시 거부", async () => {
    const existing = Array.from({ length: 8 }, (_, i) =>
      makeWorkspace({ id: `ws-${i}`, ownerId: "Uowner1234" }),
    );
    const deps = makeDeps({ ownedWorkspaces: existing });
    const ctx = makeContext({ userId: "Uowner1234" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const signal = await def.handler({ name: "NinthWS", owner_user_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("Maximum: 8");
  });

  test("이름 앞뒤 공백은 트리밍되어 생성 (owner_user_id null)", async () => {
    const setDefaultCalls: Array<{ userId: string; workspaceId: string }> = [];
    const createCalls: Array<{ name: string; ownerId: string }> = [];
    const createdWs = makeWorkspace({ id: "ws-trimmed", name: "Trimmed" });

    const deps: AgentDependencies = {
      registry: { definitions: [], executors: new Map() },
      pendingActionStore: {} as AgentDependencies["pendingActionStore"],
      getGwsExecutors: async () => new Map(),
      workspaceStore: {
        getByOwner: () => [],
        create: async (name: string, ownerId: string) => {
          createCalls.push({ name, ownerId });
          return createdWs;
        },
      } as unknown as WorkspaceStore,
      userStore: {
        setLastWorkspaceId: async (userId: string, workspaceId: string) => {
          setDefaultCalls.push({ userId, workspaceId });
        },
        isSystemAdmin: () => false,
      } as unknown as UserStore,
    };

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    await def.handler({ name: "  Trimmed  ", owner_user_id: null }, makeContext(), deps);

    expect(createCalls[0]!.name).toBe("Trimmed");
  });

  test("admin + owner_user_id 지정: 대상 사용자를 owner로 생성", async () => {
    const setDefaultCalls: Array<{ userId: string; workspaceId: string }> = [];
    const createCalls: Array<{ name: string; ownerId: string }> = [];
    const createdWs = makeWorkspace({ id: "ws-delegated", name: "Delegated" });

    const deps = makeDeps({
      ownedWorkspaces: [],
      setDefaultCalls,
      isSystemAdmin: (id) => id === "Uadmin001",
    });
    // getByOwner를 대상 사용자 기준으로 호출하므로 mock을 오버라이드
    (deps.workspaceStore as any).getByOwner = () => [];
    (deps.workspaceStore as any).create = async (name: string, ownerId: string) => {
      createCalls.push({ name, ownerId });
      return createdWs;
    };
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    await def.handler({ name: "Delegated", owner_user_id: "Ua0000000000000000000000000000001" }, ctx, deps);

    // owner는 대상 사용자
    expect(createCalls[0]!.ownerId).toBe("Ua0000000000000000000000000000001");
    // lastWorkspaceId는 대상 사용자에게 설정
    expect(setDefaultCalls[0]!.userId).toBe("Ua0000000000000000000000000000001");
  });

  test("admin + owner_user_id null: 자기 자신을 owner로 생성", async () => {
    const createCalls: Array<{ name: string; ownerId: string }> = [];
    const createdWs = makeWorkspace({ id: "ws-admin", name: "AdminWS" });

    const deps = makeDeps({
      ownedWorkspaces: [],
      isSystemAdmin: (id) => id === "Uadmin001",
    });
    (deps.workspaceStore as any).create = async (name: string, ownerId: string) => {
      createCalls.push({ name, ownerId });
      return createdWs;
    };
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    await def.handler({ name: "AdminWS", owner_user_id: null }, ctx, deps);

    expect(createCalls[0]!.ownerId).toBe("Uadmin001");
  });

  test("일반 사용자 + owner_user_id 지정: 무시, 자기 소유로 생성", async () => {
    const createCalls: Array<{ name: string; ownerId: string }> = [];
    const createdWs = makeWorkspace({ id: "ws-self", name: "SelfWS" });

    const deps = makeDeps({ ownedWorkspaces: [] });
    (deps.workspaceStore as any).create = async (name: string, ownerId: string) => {
      createCalls.push({ name, ownerId });
      return createdWs;
    };
    const ctx = makeContext({ userId: "Uregular001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    await def.handler({ name: "SelfWS", owner_user_id: "Ub0000000000000000000000000000002" }, ctx, deps);

    // owner_user_id 무시, 자기 자신이 owner
    expect(createCalls[0]!.ownerId).toBe("Uregular001");
  });

  test("admin 소유 제한: 64개 소유 시 거부", async () => {
    const existing = Array.from({ length: 64 }, (_, i) =>
      makeWorkspace({ id: `ws-${i}`, ownerId: "Uadmin001" }),
    );
    const deps = makeDeps({
      ownedWorkspaces: existing,
      isSystemAdmin: (id) => id === "Uadmin001",
    });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const signal = await def.handler({ name: "TooMany", owner_user_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("Maximum: 64");
  });

  test("admin + owner_user_id 지정: 대상 사용자에 일반 사용자 제한(8) 적용", async () => {
    const deps = makeDeps({ isSystemAdmin: (id) => id === "Uadmin001" });
    const getByOwnerCalls: string[] = [];
    (deps.workspaceStore as any).getByOwner = (ownerId: string) => {
      getByOwnerCalls.push(ownerId);
      // 대상이 이미 8개 소유 중 → 일반 사용자 제한 도달
      return Array.from({ length: 8 }, (_, i) => makeWorkspace({ id: `ws-${i}`, ownerId }));
    };
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const signal = await def.handler(
      { name: "WS", owner_user_id: "Ua0000000000000000000000000000001" },
      ctx,
      deps,
    );

    // getByOwner는 대상 사용자 기준으로 호출
    expect(getByOwnerCalls[0]).toBe("Ua0000000000000000000000000000001");
    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("Maximum: 8");
  });

  test("admin + owner_user_id 형식 불량: 에러", async () => {
    const deps = makeDeps({ isSystemAdmin: (id) => id === "Uadmin001" });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const signal = await def.handler(
      { name: "WS", owner_user_id: "invalid-id" },
      ctx,
      deps,
    );

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("Invalid LINE userId");
  });
});

// --- list_workspaces 핸들러 테스트 ---

describe("list_workspaces handler", () => {
  test("admin: owner별 그룹화, id/name/createdAt만 포함", async () => {
    const ws1 = makeWorkspace({ id: "ws-001", name: "WS1", ownerId: "Uowner1", createdAt: "2024-01-01T00:00:00Z" });
    const ws2 = makeWorkspace({ id: "ws-002", name: "WS2", ownerId: "Uowner2", createdAt: "2024-02-01T00:00:00Z" });
    const deps = makeDeps({
      allWorkspaces: [ws1, ws2],
      isSystemAdmin: (id) => id === "Uadmin001",
    });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "list_workspaces")!;
    const signal = await def.handler({}, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0].ownerId).toBe("Uowner1");
    expect(result.workspaces[0].workspaces[0]).toEqual({
      id: "ws-001", name: "WS1", createdAt: "2024-01-01T00:00:00Z",
    });
    // memberCount 등 미포함
    expect(result.workspaces[0].workspaces[0].memberCount).toBeUndefined();
  });

  test("일반 사용자: 소유 + 소속 분리 반환", async () => {
    const ownedWs = makeWorkspace({ id: "ws-own", name: "MyWS", ownerId: "Uuser001", createdAt: "2024-01-01T00:00:00Z" });
    const memberWs = makeWorkspace({
      id: "ws-other",
      name: "OtherWS",
      ownerId: "Uother",
      members: {
        Uother: { role: "owner", joinedAt: "2024-01-01T00:00:00Z", invitedBy: "system" },
        Uuser001: { role: "member", joinedAt: "2024-03-01T00:00:00Z", invitedBy: "Uother" },
      },
    });
    const deps = makeDeps({ memberWorkspaces: [ownedWs, memberWs] });
    const ctx = makeContext({ userId: "Uuser001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "list_workspaces")!;
    const signal = await def.handler({}, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.owned).toHaveLength(1);
    expect(result.owned[0]).toEqual({
      id: "ws-own", name: "MyWS", createdAt: "2024-01-01T00:00:00Z",
    });

    expect(result.member).toHaveLength(1);
    expect(result.member[0]).toEqual({
      id: "ws-other", name: "OtherWS", joinedAt: "2024-03-01T00:00:00Z", ownerId: "Uother",
    });
  });

  test("소속만 있는 경우: owned 빈 배열, member 있음", async () => {
    const memberWs = makeWorkspace({
      id: "ws-other",
      name: "OtherWS",
      ownerId: "Uother",
      members: {
        Uother: { role: "owner", joinedAt: "2024-01-01T00:00:00Z", invitedBy: "system" },
        Uuser001: { role: "member", joinedAt: "2024-03-01T00:00:00Z", invitedBy: "Uother" },
      },
    });
    const deps = makeDeps({ memberWorkspaces: [memberWs] });
    const ctx = makeContext({ userId: "Uuser001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "list_workspaces")!;
    const signal = await def.handler({}, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.owned).toHaveLength(0);
    expect(result.member).toHaveLength(1);
  });

  test("빈 목록: owned/member 모두 빈 배열", async () => {
    const deps = makeDeps({ memberWorkspaces: [] });
    const ctx = makeContext({ role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "list_workspaces")!;
    const signal = await def.handler({}, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.owned).toHaveLength(0);
    expect(result.member).toHaveLength(0);
  });
});

// --- get_workspace_info 핸들러 테스트 ---

describe("get_workspace_info handler", () => {
  const sharedWs = () =>
    makeWorkspace({
      id: "ws-001",
      name: "WS1",
      ownerId: "Uowner1234",
      gwsAuthenticated: true,
      members: {
        Uowner1234: { role: "owner", joinedAt: "2024-01-01T00:00:00Z", invitedBy: "system" },
        Umember001: { role: "member", joinedAt: "2024-02-01T00:00:00Z", invitedBy: "Uowner1234" },
      },
    });

  test("admin 프로젝션: ownerId + gwsAuthenticated 포함", async () => {
    const ws = sharedWs();
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
      isSystemAdmin: (id) => id === "Uadmin001",
    });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-001");
    expect(result.ownerId).toBe("Uowner1234");
    expect(result.gwsAuthenticated).toBe(true);
    expect(result.memberCount).toBe(2);
    expect(result.members).toHaveLength(2);
  });

  test("owner 프로젝션: gwsAuthenticated 포함, ownerId 제외", async () => {
    const ws = sharedWs();
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Uowner1234", role: "owner", workspaceId: "ws-001" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-001");
    expect(result.gwsAuthenticated).toBe(true);
    expect(result.ownerId).toBeUndefined();
    expect(result.members).toHaveLength(2);
  });

  test("member 프로젝션: ownerId 포함, gwsAuthenticated 제외", async () => {
    const ws = sharedWs();
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Umember001", role: "member", workspaceId: "ws-001" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-001");
    expect(result.ownerId).toBe("Uowner1234");
    expect(result.gwsAuthenticated).toBeUndefined();
    expect(result.members).toHaveLength(2);
  });

  test("owner + workspace_id null: 현재 워크스페이스 폴백", async () => {
    const ws = makeWorkspace({ id: "ws-current", ownerId: "Uowner1234" });
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-current" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Uowner1234", role: "owner", workspaceId: "ws-current" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: null }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-current");
  });

  test("미소속 + 미소유: 접근 거부", async () => {
    const ws = makeWorkspace({ id: "ws-other", ownerId: "Uother" });
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-other" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Ustranger", role: "member", workspaceId: "ws-mine" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: "ws-other" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
  });

  test("workspace_id null + workspaceId 미설정: 에러", async () => {
    const deps = makeDeps();
    const ctx = makeContext({ userId: "Uuser001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
  });

  test("존재하지 않는 workspace_id: 에러", async () => {
    const deps = makeDeps({
      getWorkspace: () => undefined,
      isSystemAdmin: () => true,
    });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: "ws-nonexistent" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("not found");
  });

  test("members 배열에 userId, role, joinedAt, invitedBy 포함", async () => {
    const ws = makeWorkspace({
      id: "ws-001",
      ownerId: "Uowner1234",
      members: {
        Uowner1234: { role: "owner", joinedAt: "2024-01-01T00:00:00Z", invitedBy: "system" },
      },
    });
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Uowner1234", role: "owner", workspaceId: "ws-001" });

    const def = systemToolDefinitions.find((d) => d.name === "get_workspace_info")!;
    const signal = await def.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.members[0]).toEqual({
      userId: "Uowner1234",
      role: "owner",
      joinedAt: "2024-01-01T00:00:00Z",
      invitedBy: "system",
    });
  });
});

// --- enter_workspace 핸들러 테스트 ---

describe("enter_workspace handler", () => {
  test("성공: workspace_id 지정 → lastWorkspaceId 설정 + 결과 반환", async () => {
    const ws = makeWorkspace({ id: "ws-001", name: "MyClub" });
    const setDefaultCalls: Array<{ userId: string; workspaceId: string }> = [];
    const deps = makeDeps({
      getWorkspace: (id) => id === "ws-001" ? ws : undefined,
      getUserRole: (wsId, userId) => wsId === "ws-001" && userId === "Uuser001" ? "owner" : undefined,
      setDefaultCalls,
    });
    const ctx = makeContext({ userId: "Uuser001", workspaceId: undefined, role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "enter_workspace")!;
    const signal = await def.handler({ workspace_id: "ws-001" }, ctx, deps);

    const result = JSON.parse(signal.toolResult);
    expect(result.workspaceId).toBe("ws-001");
    expect(result.name).toBe("MyClub");
    expect(result.role).toBe("owner");

    expect(setDefaultCalls).toHaveLength(1);
    expect(setDefaultCalls[0]).toEqual({ userId: "Uuser001", workspaceId: "ws-001" });
  });

  test("성공: workspace_id null → lastWorkspaceId 폴백", async () => {
    const ws = makeWorkspace({ id: "ws-last", name: "LastUsed" });
    const setDefaultCalls: Array<{ userId: string; workspaceId: string }> = [];
    const deps = makeDeps({
      getWorkspace: (id) => id === "ws-last" ? ws : undefined,
      getUserRole: () => "member",
      lastWorkspaceId: "ws-last",
      setDefaultCalls,
    });
    const ctx = makeContext({ userId: "Uuser001", workspaceId: undefined, role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "enter_workspace")!;
    const signal = await def.handler({ workspace_id: null }, ctx, deps);

    const result = JSON.parse(signal.toolResult);
    expect(result.workspaceId).toBe("ws-last");
    expect(setDefaultCalls).toHaveLength(1);
  });

  test("실패: workspace_id null + lastWorkspaceId 없음", async () => {
    const deps = makeDeps();
    const ctx = makeContext({ userId: "Uuser001", workspaceId: undefined, role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "enter_workspace")!;
    const signal = await def.handler({ workspace_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("No workspace specified");
  });

  test("실패: 존재하지 않는 워크스페이스", async () => {
    const deps = makeDeps({ getWorkspace: () => undefined });
    const ctx = makeContext({ userId: "Uuser001", workspaceId: undefined, role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "enter_workspace")!;
    const signal = await def.handler({ workspace_id: "ws-nonexistent" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("not found");
  });

  test("실패: 미소속 워크스페이스 접근", async () => {
    const ws = makeWorkspace({ id: "ws-other" });
    const deps = makeDeps({
      getWorkspace: (id) => id === "ws-other" ? ws : undefined,
      getUserRole: () => undefined,
    });
    const ctx = makeContext({ userId: "Uuser001", workspaceId: undefined, role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "enter_workspace")!;
    const signal = await def.handler({ workspace_id: "ws-other" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("access");
  });
});

// --- invite_member 핸들러 테스트 ---

describe("invite_member handler", () => {
  test("성공: owner가 멤버 초대 + 결과 반환", async () => {
    const ws = makeWorkspace({ id: "ws-001", name: "MyClub", ownerId: "Uowner1234" });
    const inviteCalls: Array<{ wsId: string; userId: string; invitedBy: string }> = [];
    const deps = makeDeps({
      getWorkspace: (id) => id === "ws-001" ? ws : undefined,
    });
    (deps.workspaceStore as any).inviteMember = async (wsId: string, userId: string, invitedBy: string) => {
      inviteCalls.push({ wsId, userId, invitedBy });
    };
    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });

    const def = systemToolDefinitions.find((d) => d.name === "invite_member")!;
    const signal = await def.handler(
      { user_id: "Ua0000000000000000000000000000001", workspace_id: null },
      ctx, deps,
    );

    const result = JSON.parse(signal.toolResult);
    expect(result.invitedUserId).toBe("Ua0000000000000000000000000000001");
    expect(result.workspaceName).toBe("MyClub");
    expect(inviteCalls).toHaveLength(1);
  });

  test("실패: 잘못된 LINE userId", async () => {
    const deps = makeDeps();
    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });

    const def = systemToolDefinitions.find((d) => d.name === "invite_member")!;
    const signal = await def.handler(
      { user_id: "invalid-id", workspace_id: null },
      ctx, deps,
    );

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("Invalid LINE userId");
  });

  test("실패: 비소유자 초대 시도", async () => {
    const ws = makeWorkspace({ id: "ws-001", ownerId: "Uowner1234" });
    const deps = makeDeps({
      getWorkspace: (id) => id === "ws-001" ? ws : undefined,
    });
    const ctx = makeContext({ userId: "Umember001", workspaceId: "ws-001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "invite_member")!;
    const signal = await def.handler(
      { user_id: "Ua0000000000000000000000000000001", workspace_id: "ws-001" },
      ctx, deps,
    );

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("owner");
  });

  test("실패: 워크스페이스 미소유 + workspace_id null + context에도 없음", async () => {
    const deps = makeDeps({ ownedWorkspaces: [] });
    (deps.workspaceStore as any).getByOwner = () => [];
    const ctx = makeContext({ userId: "Uuser001", workspaceId: undefined, role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "invite_member")!;
    const signal = await def.handler(
      { user_id: "Ua0000000000000000000000000000001", workspace_id: null },
      ctx, deps,
    );

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("do not own");
  });
});

// --- approve_action / reject_action 핸들러 테스트 ---

describe("approve_action handler", () => {
  test("실패: 존재하지 않는 pending action", async () => {
    const deps = makeDeps();
    (deps.pendingActionStore as any).get = () => undefined;
    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });

    const def = systemToolDefinitions.find((d) => d.name === "approve_action")!;
    const signal = await def.handler({ action_id: "nonexistent" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("not found");
  });

  test("실패: 비오너 승인 시도", async () => {
    const deps = makeDeps({
      getUserRole: () => "member",
    });
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-001",
      workspaceId: "ws-001",
      requesterId: "Umember001",
      toolName: "calendar_create",
      toolInput: {},
      status: "pending",
      createdAt: "2024-01-01T00:00:00Z",
      requestContext: "test",
    });
    const ctx = makeContext({ userId: "Umember001", workspaceId: "ws-001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "approve_action")!;
    const signal = await def.handler({ action_id: "pa-001" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("owner");
  });

  test("실패: 이미 처리된 액션", async () => {
    const deps = makeDeps({ getUserRole: () => "owner" });
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-done", workspaceId: "ws-001", requesterId: "Umember001",
      toolName: "calendar_create", toolInput: {}, status: "approved",
      createdAt: "2024-01-01T00:00:00Z", requestContext: "test",
    });
    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });

    const def = systemToolDefinitions.find((d) => d.name === "approve_action")!;
    const signal = await def.handler({ action_id: "pa-done" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("already been approved");
  });

  test("성공: 승인 + GWS 실행 + 요청자 알림", async () => {
    const executedTools: string[] = [];

    const deps = makeDeps({
      getUserRole: (wsId, userId) => {
        if (userId === "Uowner1234") return "owner";
        if (userId === "Umember001") return "member";
        return undefined;
      },
    });
    // PendingActionStore mock
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-001", workspaceId: "ws-001", requesterId: "Umember001",
      toolName: "calendar_create", toolInput: { summary: "Meeting" }, status: "pending",
      createdAt: "2024-01-01T00:00:00Z", requestContext: "일정 추가해줘",
    });
    (deps.pendingActionStore as any).approve = async () => ({
      id: "pa-001", workspaceId: "ws-001", requesterId: "Umember001",
      toolName: "calendar_create", toolInput: { summary: "Meeting" }, status: "approved",
      createdAt: "2024-01-01T00:00:00Z", requestContext: "일정 추가해줘",
      resolvedAt: new Date().toISOString(), resolvedBy: "Uowner1234",
    });
    // UserStore mock — 요청자 active
    (deps.userStore as any).get = (userId: string) =>
      userId === "Umember001" ? { status: "active", invitedBy: "self", invitedAt: "" } : undefined;
    // GWS executor를 registry에 등록 (getGwsExecutors 대신 registry 경유)
    deps.registry.executors.set("calendar_create", async (input) => {
      executedTools.push("calendar_create");
      return JSON.stringify({ ok: true });
    });

    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });
    const def = systemToolDefinitions.find((d) => d.name === "approve_action")!;
    const signal = await def.handler({ action_id: "pa-001" }, ctx, deps);

    const result = JSON.parse(signal.toolResult);
    expect(result.status).toBe("approved");
    expect(result.executionError).toBeNull();
  });

  test("성공: 요청자 비활성 → 자동 거절", async () => {
    const deps = makeDeps({
      getUserRole: (wsId, userId) => {
        if (userId === "Uowner1234") return "owner";
        if (userId === "Umember001") return "member";
        return undefined;
      },
    });
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-002", workspaceId: "ws-001", requesterId: "Umember001",
      toolName: "calendar_create", toolInput: {}, status: "pending",
      createdAt: "2024-01-01T00:00:00Z", requestContext: "test",
    });
    let rejectedId: string | undefined;
    (deps.pendingActionStore as any).reject = async (id: string) => {
      rejectedId = id;
      return { id, status: "rejected" };
    };
    // 요청자 inactive
    (deps.userStore as any).get = () => ({ status: "inactive", invitedBy: "self", invitedAt: "" });

    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });
    const def = systemToolDefinitions.find((d) => d.name === "approve_action")!;
    const signal = await def.handler({ action_id: "pa-002" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("no longer a member");
    expect(rejectedId).toBe("pa-002");
  });
});

describe("reject_action handler", () => {
  test("실패: 존재하지 않는 pending action", async () => {
    const deps = makeDeps();
    (deps.pendingActionStore as any).get = () => undefined;
    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });

    const def = systemToolDefinitions.find((d) => d.name === "reject_action")!;
    const signal = await def.handler({ action_id: "nonexistent", reason: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("not found");
  });

  test("실패: 비오너 거절 시도", async () => {
    const deps = makeDeps({
      getUserRole: () => "member",
    });
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-001",
      workspaceId: "ws-001",
      requesterId: "Umember001",
      toolName: "calendar_create",
      toolInput: {},
      status: "pending",
      createdAt: "2024-01-01T00:00:00Z",
      requestContext: "test",
    });
    const ctx = makeContext({ userId: "Umember001", workspaceId: "ws-001", role: "member" });

    const def = systemToolDefinitions.find((d) => d.name === "reject_action")!;
    const signal = await def.handler({ action_id: "pa-001", reason: "not now" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("owner");
  });

  test("실패: 이미 처리된 액션", async () => {
    const deps = makeDeps({ getUserRole: () => "owner" });
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-done", workspaceId: "ws-001", requesterId: "Umember001",
      toolName: "calendar_create", toolInput: {}, status: "rejected",
      createdAt: "2024-01-01T00:00:00Z", requestContext: "test",
    });
    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });

    const def = systemToolDefinitions.find((d) => d.name === "reject_action")!;
    const signal = await def.handler({ action_id: "pa-done", reason: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("already been rejected");
  });

  test("성공: 거절 + 요청자 알림", async () => {
    const deps = makeDeps({ getUserRole: () => "owner" });
    (deps.pendingActionStore as any).get = () => ({
      id: "pa-003", workspaceId: "ws-001", requesterId: "Umember001",
      toolName: "calendar_create", toolInput: {}, status: "pending",
      createdAt: "2024-01-01T00:00:00Z", requestContext: "일정 추가해줘",
    });
    let rejectedWith: { id: string; reason?: string } | undefined;
    (deps.pendingActionStore as any).reject = async (id: string, by: string, reason?: string) => {
      rejectedWith = { id, reason };
      return {
        id, workspaceId: "ws-001", requesterId: "Umember001",
        toolName: "calendar_create", toolInput: {}, status: "rejected",
        createdAt: "2024-01-01T00:00:00Z", requestContext: "일정 추가해줘",
        resolvedAt: new Date().toISOString(), resolvedBy: by, rejectionReason: reason,
      };
    };

    const ctx = makeContext({ userId: "Uowner1234", workspaceId: "ws-001", role: "owner" });
    const def = systemToolDefinitions.find((d) => d.name === "reject_action")!;
    const signal = await def.handler({ action_id: "pa-003", reason: "not needed" }, ctx, deps);

    const result = JSON.parse(signal.toolResult);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("not needed");
    expect(rejectedWith?.id).toBe("pa-003");
    expect(rejectedWith?.reason).toBe("not needed");
  });
});

// --- ToolDefinition (새 구조) 테스트 ---

describe("systemToolDefinitions (Zod)", () => {
  const expectedNames = [
    "create_workspace", "list_workspaces", "get_workspace_info",
    "enter_workspace", "invite_member",
    "approve_action", "reject_action", "authenticate_gws",
  ];

  test("8개 도구 모두 포함", () => {
    const names = systemToolDefinitions.map((d) => d.name);
    for (const name of expectedNames) {
      expect(names).toContain(name);
    }
    expect(systemToolDefinitions.length).toBe(8);
  });

  test("모든 도구에 strict: true 설정", () => {
    for (const def of systemToolDefinitions) {
      expect(def.strict).toBe(true);
    }
  });

  test("Zod → JSON Schema 라운드트립: 구조 검증", () => {
    for (const def of systemToolDefinitions) {
      const tool = toAnthropicTool(def);

      expect(tool.name).toBe(def.name);
      expect(tool.description).toBe(def.description);
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  test("create_workspace: nullable owner_user_id 스키마", () => {
    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    const tool = toAnthropicTool(def);
    const props = tool.input_schema.properties as Record<string, Record<string, unknown>>;

    // owner_user_id는 nullable
    const ownerProp = props.owner_user_id!;
    const hasNullable =
      (Array.isArray(ownerProp.anyOf) &&
        (ownerProp.anyOf as Array<Record<string, unknown>>).some(
          (s) => s.type === "null",
        )) ||
      ownerProp.nullable === true;
    expect(hasNullable).toBe(true);
  });

  test("Zod 스키마 검증: create_workspace 유효 입력", () => {
    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    expect(def.inputSchema.safeParse({ name: "Test", owner_user_id: null }).success).toBe(true);
    expect(def.inputSchema.safeParse({ name: "Test", owner_user_id: "U12345" }).success).toBe(true);
  });

  test("Zod 스키마 검증: create_workspace 무효 입력", () => {
    const def = systemToolDefinitions.find((d) => d.name === "create_workspace")!;
    expect(def.inputSchema.safeParse({}).success).toBe(false);
    expect(def.inputSchema.safeParse({ name: 123 }).success).toBe(false);
  });

  test("Zod 스키마 검증: list_workspaces 빈 스키마", () => {
    const def = systemToolDefinitions.find((d) => d.name === "list_workspaces")!;
    expect(def.inputSchema.safeParse({}).success).toBe(true);
  });

  test("Zod 스키마 검증: approve_action 유효/무효", () => {
    const def = systemToolDefinitions.find((d) => d.name === "approve_action")!;
    expect(def.inputSchema.safeParse({ action_id: "pa-001" }).success).toBe(true);
    expect(def.inputSchema.safeParse({}).success).toBe(false);
  });

  test("Zod 스키마 검증: reject_action nullable reason", () => {
    const def = systemToolDefinitions.find((d) => d.name === "reject_action")!;
    expect(def.inputSchema.safeParse({ action_id: "pa-001", reason: null }).success).toBe(true);
    expect(def.inputSchema.safeParse({ action_id: "pa-001", reason: "not needed" }).success).toBe(true);
  });
});
