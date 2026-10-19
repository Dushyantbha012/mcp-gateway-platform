import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "@/components/ThemeProvider";

function Probe() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <>
      <span data-testid="state">{`${theme}/${resolved}`}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
    </>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("defaults to the light theme", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("light/light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("applies and remembers an explicit choice", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByText("dark"));
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("mcp-gateway-theme")).toBe("dark");
    await act(async () => {});
    await user.click(screen.getByText("light"));
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("restores the stored theme on load", () => {
    localStorage.setItem("mcp-gateway-theme", "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("dark/dark");
    expect(document.documentElement).toHaveClass("dark");
  });
});
