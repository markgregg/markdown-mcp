import crypto from "crypto";

const AUTH_TOKEN_ENV = "MCP_AUTH_TOKEN";
const EXECUTION_PROFILE_ENV = "MCP_EXECUTION_PROFILE";

export interface SecurityDecision {
  authorized: boolean;
  profile: "strict" | "balanced" | "open";
  reason?: string;
}

export function authorizeRequest(token?: string): SecurityDecision {
  const configured = process.env[AUTH_TOKEN_ENV];
  const profile = getExecutionProfile();

  if (!configured) {
    return {
      authorized: true,
      profile,
    };
  }

  if (!token) {
    return {
      authorized: false,
      profile,
      reason: "Missing auth token",
    };
  }

  const left = Buffer.from(token);
  const right = Buffer.from(configured);

  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return {
      authorized: false,
      profile,
      reason: "Invalid auth token",
    };
  }

  return {
    authorized: true,
    profile,
  };
}

export function getExecutionProfile(): "strict" | "balanced" | "open" {
  const raw = (process.env[EXECUTION_PROFILE_ENV] || "balanced").toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "open") return "open";
  return "balanced";
}

export function canExecuteExamples(profile: "strict" | "balanced" | "open"): boolean {
  return profile !== "strict";
}

export function canWriteFiles(profile: "strict" | "balanced" | "open"): boolean {
  return profile !== "strict";
}

export function sanitizeToolInput(input: string): string {
  return input.trim().slice(0, 5000);
}
