import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders bold, lists, inline code and tables as elements, not literal markup", () => {
    const { container } = render(
      <Markdown>
        {
          "**Order 34** is `processing`\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        }
      </Markdown>,
    );
    expect(screen.getByText("Order 34").tagName).toBe("STRONG");
    expect(screen.getByText("processing").tagName).toBe("CODE");
    expect(within(screen.getAllByRole("list")[0]).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.textContent).not.toContain("**");
  });

  it("never renders raw HTML from the model or a tool result", () => {
    const { container } = render(
      <Markdown>{'<img src=x onerror="alert(1)"> <script>alert(1)</script> <b>hi</b>'}</Markdown>,
    );
    expect(container.querySelector("img, script, b")).toBeNull();
  });

  it("opens links in a new tab without opener, and drops javascript: links", () => {
    render(<Markdown>{"[ok](https://example.com) and [bad](javascript:alert(1))"}</Markdown>);
    const ok = screen.getByRole("link", { name: "ok" });
    expect(ok).toHaveAttribute("href", "https://example.com");
    expect(ok).toHaveAttribute("target", "_blank");
    expect(ok.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  });

  it("styles fenced code blocks as blocks and inline code as a chip", () => {
    const { container } = render(<Markdown>{'```json\n{"a": 1}\n```\n\nuse `x`'}</Markdown>);
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(screen.getByText("x").className).toContain("bg-muted");
  });
});
