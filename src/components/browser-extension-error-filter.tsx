"use client";

import { useEffect } from "react";

function getErrorText(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
  if (value && typeof value === "object") {
    const record = value as { message?: unknown; stack?: unknown };
    return `${typeof record.message === "string" ? record.message : ""}\n${
      typeof record.stack === "string" ? record.stack : ""
    }`;
  }
  return "";
}

function isMetaMaskInjectedError(value: unknown) {
  const text = getErrorText(value);
  return text.includes("Failed to connect to MetaMask") && text.includes("chrome-extension://");
}

export function BrowserExtensionErrorFilter() {
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isMetaMaskInjectedError(event.reason)) {
        event.preventDefault();
      }
    };

    const handleError = (event: ErrorEvent) => {
      if (isMetaMaskInjectedError(event.error) || isMetaMaskInjectedError(event.message)) {
        event.preventDefault();
      }
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleError);
    return () => {
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("error", handleError);
    };
  }, []);

  return null;
}
