import { describe, test, expect } from "bun:test";
import {
  GmailScope,
  CalendarScope,
  DriveScope,
  IdentityScope,
  BASE_SCOPES,
  GWS_SERVICE_SCOPES,
  computeRequiredScopes,
  hasSufficientScopes,
  computeServiceStatus,
  type GwsServiceStatus,
} from "./google-scopes.js";

describe("scope 상수", () => {
  test("BASE_SCOPES는 identity scope 3개 포함", () => {
    expect(BASE_SCOPES).toContain(IdentityScope.OPENID);
    expect(BASE_SCOPES).toContain(IdentityScope.EMAIL);
    expect(BASE_SCOPES).toContain(IdentityScope.PROFILE);
    expect(BASE_SCOPES).toHaveLength(3);
  });
});

describe("computeRequiredScopes", () => {
  test("빈 도구 목록 → BASE_SCOPES만 반환", () => {
    const result = computeRequiredScopes([]);
    expect(result.sort()).toEqual([...BASE_SCOPES].sort());
  });

  test("도구 scope + BASE_SCOPES 합산", () => {
    const tools = [
      { requiredScopes: [GmailScope.MODIFY] },
      { requiredScopes: [CalendarScope.FULL] },
    ];
    const result = computeRequiredScopes(tools);
    expect(result).toContain(GmailScope.MODIFY);
    expect(result).toContain(CalendarScope.FULL);
    for (const s of BASE_SCOPES) {
      expect(result).toContain(s);
    }
  });

  test("중복 scope 제거", () => {
    const tools = [
      { requiredScopes: [GmailScope.MODIFY] },
      { requiredScopes: [GmailScope.MODIFY] },
    ];
    const result = computeRequiredScopes(tools);
    const gmailCount = result.filter((s) => s === GmailScope.MODIFY).length;
    expect(gmailCount).toBe(1);
  });

  test("커스텀 baseScopes 지정", () => {
    const tools = [{ requiredScopes: [DriveScope.FULL] }];
    const result = computeRequiredScopes(tools, ["custom-scope"]);
    expect(result).toContain("custom-scope");
    expect(result).toContain(DriveScope.FULL);
    expect(result).not.toContain(IdentityScope.OPENID);
  });

  test("모든 서비스 scope 합산", () => {
    const tools = [
      { requiredScopes: [GmailScope.MODIFY] },
      { requiredScopes: [CalendarScope.FULL] },
      { requiredScopes: [DriveScope.FULL] },
      { requiredScopes: [IdentityScope.OPENID, IdentityScope.EMAIL, IdentityScope.PROFILE] },
    ];
    const result = computeRequiredScopes(tools);
    expect(new Set(result).size).toBe(6); // 3 services + 3 identity (중복 제거)
  });
});

describe("hasSufficientScopes", () => {
  test("undefined granted + required 있음 → false", () => {
    expect(hasSufficientScopes(undefined, [GmailScope.MODIFY])).toBe(false);
  });

  test("undefined granted + required 없음 → true", () => {
    expect(hasSufficientScopes(undefined, [])).toBe(true);
  });

  test("모든 required scope 포함 → true", () => {
    const granted = "https://www.googleapis.com/auth/gmail.modify openid email profile";
    expect(hasSufficientScopes(granted, [GmailScope.MODIFY])).toBe(true);
  });

  test("required scope 부족 → false", () => {
    const granted = "openid email profile";
    expect(hasSufficientScopes(granted, [GmailScope.MODIFY])).toBe(false);
  });

  test("granted가 required의 상위집합 → true", () => {
    const granted = `${GmailScope.MODIFY} ${CalendarScope.FULL} ${DriveScope.FULL} openid email profile`;
    expect(hasSufficientScopes(granted, [GmailScope.MODIFY])).toBe(true);
  });

  test("빈 required → true", () => {
    expect(hasSufficientScopes("openid", [])).toBe(true);
  });

  test("빈 granted 문자열 + required 있음 → false", () => {
    expect(hasSufficientScopes("", [GmailScope.MODIFY])).toBe(false);
  });
});

// --- Phase 1: 서비스 상태 함수 ---

describe("GWS_SERVICE_SCOPES", () => {
  test("3개 서비스(Gmail, Calendar, Drive) 정의", () => {
    expect(Object.keys(GWS_SERVICE_SCOPES)).toEqual(["Gmail", "Calendar", "Drive"]);
  });

  test("각 서비스가 올바른 scope 참조", () => {
    expect(GWS_SERVICE_SCOPES.Gmail).toEqual([GmailScope.MODIFY]);
    expect(GWS_SERVICE_SCOPES.Calendar).toEqual([CalendarScope.FULL]);
    expect(GWS_SERVICE_SCOPES.Drive).toEqual([DriveScope.FULL]);
  });
});

describe("computeServiceStatus", () => {
  const FULL_SCOPE = `${GmailScope.MODIFY} ${CalendarScope.FULL} ${DriveScope.FULL} openid email profile`;

  test("전체 scope 부여 → 3개 서비스 모두 available", () => {
    const status = computeServiceStatus(FULL_SCOPE);
    expect(status.available).toEqual(["Gmail", "Calendar", "Drive"]);
    expect(status.unavailable).toEqual([]);
  });

  test("Gmail scope만 부여 → Gmail available, Calendar/Drive unavailable", () => {
    const status = computeServiceStatus(`${GmailScope.MODIFY} openid email profile`);
    expect(status.available).toEqual(["Gmail"]);
    expect(status.unavailable).toEqual(["Calendar", "Drive"]);
  });

  test("identity scope만 부여 → 3개 서비스 모두 unavailable", () => {
    const status = computeServiceStatus("openid email profile");
    expect(status.available).toEqual([]);
    expect(status.unavailable).toEqual(["Gmail", "Calendar", "Drive"]);
  });

  test("undefined → 3개 서비스 모두 unavailable", () => {
    const status = computeServiceStatus(undefined);
    expect(status.available).toEqual([]);
    expect(status.unavailable).toEqual(["Gmail", "Calendar", "Drive"]);
  });

  test("Calendar + Drive만 부여 → Gmail unavailable", () => {
    const status = computeServiceStatus(`${CalendarScope.FULL} ${DriveScope.FULL} openid email profile`);
    expect(status.available).toEqual(["Calendar", "Drive"]);
    expect(status.unavailable).toEqual(["Gmail"]);
  });
});

