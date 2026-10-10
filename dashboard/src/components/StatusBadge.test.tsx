import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBadge } from "./StatusBadge";

const renderBadge = (status: Parameters<typeof StatusBadge>[0]["status"], reason?: string) =>
  render(
    <TooltipProvider>
      <StatusBadge status={status} reason={reason} />
    </TooltipProvider>,
  );

describe("StatusBadge", () => {
  it.each([
    ["connected", "Connected"],
    ["unreachable", "Unreachable"],
    ["disabled", "Disabled"],
    ["unknown", "Checking…"],
  ] as const)("%s -> %s", (status, label) => {
    renderBadge(status);
    expect(screen.getByText(label)).toHaveAttribute("data-status", status);
  });

  it("exposes the unreachable reason to assistive tech", () => {
    renderBadge("unreachable", "connect ECONNREFUSED 10.0.0.1:3000");
    expect(
      screen.getByLabelText("Unreachable: connect ECONNREFUSED 10.0.0.1:3000"),
    ).toBeInTheDocument();
  });

  it("doesn't show a stale error for a disabled server", () => {
    // displayStatus on the gateway already says "disabled" even if the last check failed.
    renderBadge("disabled", "timed out after 500ms");
    expect(screen.queryByLabelText(/timed out/)).not.toBeInTheDocument();
  });
});
