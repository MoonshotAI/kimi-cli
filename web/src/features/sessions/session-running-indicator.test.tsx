import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionRunningIndicator } from "./session-running-indicator";

describe("SessionRunningIndicator", () => {
  it("renders with the default accessible label", () => {
    render(<SessionRunningIndicator />);
    const indicator = screen.getByLabelText("Session is running");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute("title", "Session is running");
  });

  it("uses the <output> semantic element for live-region a11y", () => {
    render(<SessionRunningIndicator />);
    const indicator = screen.getByLabelText("Session is running");
    expect(indicator.tagName).toBe("OUTPUT");
  });

  it("applies the base indicator class and renders the core layer", () => {
    render(<SessionRunningIndicator />);
    const indicator = screen.getByLabelText("Session is running");
    expect(indicator).toHaveClass("session-running-indicator");

    const core = indicator.querySelector(".session-running-core");
    expect(core).not.toBeNull();
    expect(core).toHaveAttribute("aria-hidden", "true");
  });

  it("honors a custom label for both aria-label and title", () => {
    render(<SessionRunningIndicator label="Working on your request" />);
    const indicator = screen.getByLabelText("Working on your request");
    expect(indicator).toHaveAttribute("title", "Working on your request");
  });

  it("merges additional classNames without dropping the base class", () => {
    render(<SessionRunningIndicator className="ml-2 custom-thing" />);
    const indicator = screen.getByLabelText("Session is running");
    expect(indicator).toHaveClass("session-running-indicator");
    expect(indicator).toHaveClass("ml-2");
    expect(indicator).toHaveClass("custom-thing");
  });
});
