import { extractRecommendedAction, type SubscribeProbeResult } from "./probeClient.js";

export interface JsonOutput {
  route: string;
  serverUrl: string | null;
  resourceUri: string;
  subscribed: boolean;
  notificationReceived: boolean;
  notificationCount: number;
  unsubscribed: boolean;
  errorCode: string | null;
  initialText: string | null;
  finalText: string | null;
  recommendedNextAction: string | null;
}

export function buildJsonOutput(result: SubscribeProbeResult, serverUrl: string, resourceUri: string): JsonOutput {
  return {
    route: result.route,
    serverUrl,
    resourceUri,
    subscribed: result.subscribed,
    notificationReceived: result.route === "subscription",
    notificationCount: result.notificationCount,
    unsubscribed: result.unsubscribed,
    errorCode: result.errorCode,
    initialText: result.initialText || null,
    finalText: result.finalText || null,
    recommendedNextAction: extractRecommendedAction(result.finalText),
  };
}

export function buildErrorJsonOutput(
  errorCode: string,
  serverUrl: string | null,
  resourceUri: string,
  recommendedNextAction: string | null = null,
): JsonOutput {
  return {
    route: "failed",
    serverUrl,
    resourceUri,
    subscribed: false,
    notificationReceived: false,
    notificationCount: 0,
    unsubscribed: false,
    errorCode,
    initialText: null,
    finalText: null,
    recommendedNextAction,
  };
}
