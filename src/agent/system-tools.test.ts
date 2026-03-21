import { describe, test, expect } from "bun:test";
import { systemToolDefs, systemTools } from "./system-tools.js";
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
    gwsConfigDir: "data/workspaces/ws-001/gws-config",
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
}): AgentDependencies {
  const setDefaultCalls = overrides?.setDefaultCalls ?? [];
  const createdWs = overrides?.createdWorkspace ?? makeWorkspace();

  return {
    registry: { tools: [], executors: new Map() },
    pendingActionStore: {} as AgentDependencies["pendingActionStore"],
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
      isSystemAdmin: overrides?.isSystemAdmin ?? (() => false),
    } as unknown as UserStore,
  };
}

// --- 레지스트리 테스트 ---

describe("systemTools registry", () => {
  test("systemTools contains create_workspace", () => {
    expect(systemTools.has("create_workspace")).toBe(true);
  });

  test("systemToolDefs includes create_workspace definition", () => {
    const names = systemToolDefs.map((d) => d.name);
    expect(names).toContain("create_workspace");
  });

  test("systemTools and systemToolDefs are consistent", () => {
    for (const def of systemToolDefs) {
      expect(systemTools.has(def.name)).toBe(true);
      expect(systemTools.get(def.name)!.def).toBe(def);
    }
    expect(systemTools.size).toBe(systemToolDefs.length);
  });

  test("모든 시스템 도구에 strict: true + additionalProperties: false 설정", () => {
    for (const def of systemToolDefs) {
      expect(def.strict).toBe(true);
      expect(def.input_schema.additionalProperties).toBe(false);
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

    const entry = systemTools.get("create_workspace")!;
    const signal = await entry.handler({ name: "MyWorkspace", owner_user_id: null }, ctx, deps);

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

    const entry = systemTools.get("create_workspace")!;
    const signal = await entry.handler({ name: "  ", owner_user_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("empty");
  });

  test("일반 사용자 소유 제한: 8개 소유 시 거부", async () => {
    const existing = Array.from({ length: 8 }, (_, i) =>
      makeWorkspace({ id: `ws-${i}`, ownerId: "Uowner1234" }),
    );
    const deps = makeDeps({ ownedWorkspaces: existing });
    const ctx = makeContext({ userId: "Uowner1234" });

    const entry = systemTools.get("create_workspace")!;
    const signal = await entry.handler({ name: "NinthWS", owner_user_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
    expect(signal.toolResult).toContain("Maximum: 8");
  });

  test("이름 앞뒤 공백은 트리밍되어 생성 (owner_user_id null)", async () => {
    const setDefaultCalls: Array<{ userId: string; workspaceId: string }> = [];
    const createCalls: Array<{ name: string; ownerId: string }> = [];
    const createdWs = makeWorkspace({ id: "ws-trimmed", name: "Trimmed" });

    const deps: AgentDependencies = {
      registry: { tools: [], executors: new Map() },
      pendingActionStore: {} as AgentDependencies["pendingActionStore"],
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

    const entry = systemTools.get("create_workspace")!;
    await entry.handler({ name: "  Trimmed  ", owner_user_id: null }, makeContext(), deps);

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

    const entry = systemTools.get("create_workspace")!;
    await entry.handler({ name: "Delegated", owner_user_id: "Ua0000000000000000000000000000001" }, ctx, deps);

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

    const entry = systemTools.get("create_workspace")!;
    await entry.handler({ name: "AdminWS", owner_user_id: null }, ctx, deps);

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

    const entry = systemTools.get("create_workspace")!;
    await entry.handler({ name: "SelfWS", owner_user_id: "Ub0000000000000000000000000000002" }, ctx, deps);

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

    const entry = systemTools.get("create_workspace")!;
    const signal = await entry.handler({ name: "TooMany", owner_user_id: null }, ctx, deps);

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

    const entry = systemTools.get("create_workspace")!;
    const signal = await entry.handler(
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

    const entry = systemTools.get("create_workspace")!;
    const signal = await entry.handler(
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

    const entry = systemTools.get("list_workspaces")!;
    const signal = await entry.handler({}, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0].ownerId).toBe("Uowner1");
    expect(result.workspaces[0].workspaces[0]).toEqual({
      id: "ws-001", name: "WS1", createdAt: "2024-01-01T00:00:00Z",
    });
    // gwsConfigDir, memberCount 등 미포함
    expect(result.workspaces[0].workspaces[0].gwsConfigDir).toBeUndefined();
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

    const entry = systemTools.get("list_workspaces")!;
    const signal = await entry.handler({}, ctx, deps);
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

    const entry = systemTools.get("list_workspaces")!;
    const signal = await entry.handler({}, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.owned).toHaveLength(0);
    expect(result.member).toHaveLength(1);
  });

  test("빈 목록: owned/member 모두 빈 배열", async () => {
    const deps = makeDeps({ memberWorkspaces: [] });
    const ctx = makeContext({ role: "member" });

    const entry = systemTools.get("list_workspaces")!;
    const signal = await entry.handler({}, ctx, deps);
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

  test("admin 프로젝션: ownerId + gwsAuthenticated 포함, gwsConfigDir 제외", async () => {
    const ws = sharedWs();
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
      isSystemAdmin: (id) => id === "Uadmin001",
    });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-001");
    expect(result.ownerId).toBe("Uowner1234");
    expect(result.gwsAuthenticated).toBe(true);
    expect(result.memberCount).toBe(2);
    expect(result.members).toHaveLength(2);
    expect(result.gwsConfigDir).toBeUndefined();
  });

  test("owner 프로젝션: gwsAuthenticated 포함, ownerId 제외", async () => {
    const ws = sharedWs();
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Uowner1234", role: "owner", workspaceId: "ws-001" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-001");
    expect(result.gwsAuthenticated).toBe(true);
    expect(result.ownerId).toBeUndefined();
    expect(result.gwsConfigDir).toBeUndefined();
    expect(result.members).toHaveLength(2);
  });

  test("member 프로젝션: ownerId 포함, gwsAuthenticated 제외", async () => {
    const ws = sharedWs();
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-001" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Umember001", role: "member", workspaceId: "ws-001" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-001");
    expect(result.ownerId).toBe("Uowner1234");
    expect(result.gwsAuthenticated).toBeUndefined();
    expect(result.gwsConfigDir).toBeUndefined();
    expect(result.members).toHaveLength(2);
  });

  test("owner + workspace_id null: 현재 워크스페이스 폴백", async () => {
    const ws = makeWorkspace({ id: "ws-current", ownerId: "Uowner1234" });
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-current" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Uowner1234", role: "owner", workspaceId: "ws-current" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: null }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.id).toBe("ws-current");
  });

  test("미소속 + 미소유: 접근 거부", async () => {
    const ws = makeWorkspace({ id: "ws-other", ownerId: "Uother" });
    const deps = makeDeps({
      getWorkspace: (id) => (id === "ws-other" ? ws : undefined),
    });
    const ctx = makeContext({ userId: "Ustranger", role: "member", workspaceId: "ws-mine" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: "ws-other" }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
  });

  test("workspace_id null + workspaceId 미설정: 에러", async () => {
    const deps = makeDeps();
    const ctx = makeContext({ userId: "Uuser001", role: "member" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: null }, ctx, deps);

    expect(signal.toolResult).toContain("Error");
  });

  test("존재하지 않는 workspace_id: 에러", async () => {
    const deps = makeDeps({
      getWorkspace: () => undefined,
      isSystemAdmin: () => true,
    });
    const ctx = makeContext({ userId: "Uadmin001", role: "admin" });

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: "ws-nonexistent" }, ctx, deps);

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

    const entry = systemTools.get("get_workspace_info")!;
    const signal = await entry.handler({ workspace_id: "ws-001" }, ctx, deps);
    const result = JSON.parse(signal.toolResult);

    expect(result.members[0]).toEqual({
      userId: "Uowner1234",
      role: "owner",
      joinedAt: "2024-01-01T00:00:00Z",
      invitedBy: "system",
    });
  });
});
