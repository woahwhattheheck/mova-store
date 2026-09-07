import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, fireEvent, screen } from "@testing-library/react";
import Toast from "../../components/Toast";

const advance = (milliseconds) => {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
};

describe("Toast display and exit lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits for the default display duration and the complete exit window", () => {
    const onClose = vi.fn();
    render(<Toast message="default" show={true} onClose={onClose} />);

    advance(2999);
    expect(screen.getByText("default")).toHaveClass("opacity-100");
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(screen.getByText("default")).toHaveClass("opacity-0");
    expect(onClose).not.toHaveBeenCalled();
    advance(299);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    advance(5000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("honors a custom display duration rather than closing after 300ms", () => {
    const onClose = vi.fn();
    render(
      <Toast message="long" show={true} onClose={onClose} time={7000} />,
    );

    advance(6999);
    expect(screen.getByText("long")).toHaveClass("opacity-100");
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(screen.getByText("long")).toHaveClass("opacity-0");
    advance(299);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still allows the exit animation when display time is zero", () => {
    const onClose = vi.fn();
    render(<Toast message="zero" show={true} onClose={onClose} time={0} />);

    advance(0);
    expect(screen.getByText("zero")).toHaveClass("opacity-0");
    expect(onClose).not.toHaveBeenCalled();
    advance(299);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close a fresh toast shown within the previous exit window", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { rerender } = render(
      <Toast message="A" show={true} onClose={onCloseA} time={3000} />,
    );

    // A is now exiting. B starts 100ms into that 300ms exit window.
    advance(3100);
    expect(onCloseA).not.toHaveBeenCalled();
    rerender(<Toast message="B" show={true} onClose={onCloseB} time={3000} />);
    advance(200);
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).not.toHaveBeenCalled();
    expect(screen.getByText("B")).toHaveClass("opacity-100");

    // B must still complete its own display and exit, not remain indefinitely.
    advance(2800);
    expect(screen.getByText("B")).toHaveClass("opacity-0");
    expect(onCloseB).not.toHaveBeenCalled();
    advance(300);
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });

  it("closes an immediately replaced toast after its own full duration", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { rerender } = render(
      <Toast message="A" show={true} onClose={onCloseA} />,
    );
    rerender(<Toast message="B" show={true} onClose={onCloseB} />);

    advance(3299);
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).not.toHaveBeenCalled();
    advance(1);
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });

  it("restarts for a new message even with the same callback and show flag", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Toast message="A" show={true} onClose={onClose} />,
    );

    advance(3100);
    rerender(<Toast message="B" show={true} onClose={onClose} />);
    expect(screen.getByText("B")).toHaveClass("opacity-100");
    advance(3299);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose after unmounting mid-exit", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Toast message="test" show={true} onClose={onClose} />,
    );

    advance(3100);
    expect(onClose).not.toHaveBeenCalled();
    unmount();
    advance(10000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels the display timer when unmounted before the exit phase", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Toast message="test" show={true} onClose={onClose} />,
    );

    advance(100);
    unmount();
    advance(10000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels a pending close when show becomes false during exit", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Toast message="test" show={true} onClose={onClose} />,
    );

    advance(3100);
    rerender(<Toast message="test" show={false} onClose={onClose} />);
    advance(10000);
    expect(screen.getByText("test")).toHaveClass("opacity-0");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not schedule a hidden toast but starts when it is shown", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Toast message="test" show={false} onClose={onClose} />,
    );

    advance(10000);
    expect(screen.getByText("test")).toHaveClass("opacity-0");
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Toast message="test" show={true} onClose={onClose} />);
    advance(3299);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restarts the display timer when the duration changes", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Toast message="test" show={true} onClose={onClose} time={3000} />,
    );

    advance(1000);
    rerender(
      <Toast message="test" show={true} onClose={onClose} time={6000} />,
    );
    advance(5999);
    expect(screen.getByText("test")).toHaveClass("opacity-100");
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(screen.getByText("test")).toHaveClass("opacity-0");
    advance(300);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels the old callback when only the callback changes during exit", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { rerender } = render(
      <Toast message="test" show={true} onClose={onCloseA} />,
    );

    advance(3100);
    rerender(<Toast message="test" show={true} onClose={onCloseB} />);
    advance(3300);
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });

  it("does not postpone the deadline on an unchanged rerender", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Toast message="test" show={true} onClose={onClose} />,
    );

    advance(1500);
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Toast message="test" show={true} onClose={onClose} />);
    advance(1799);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps one timer lifecycle under StrictMode setup and cleanup", () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Toast message="strict" show={true} onClose={onClose} />
      </StrictMode>,
    );

    expect(vi.getTimerCount()).toBe(1);
    advance(3299);
    expect(onClose).not.toHaveBeenCalled();
    advance(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the manual close callback", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Toast message="manual" show={true} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    advance(10000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
