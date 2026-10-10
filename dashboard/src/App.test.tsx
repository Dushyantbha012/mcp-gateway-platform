import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("scaffold smoke test", () => {
  it("resolves React + Vitest + Testing Library wiring for this package", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });
});
