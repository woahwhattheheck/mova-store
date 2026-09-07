import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import Checkout from "../../app/checkout/page";
import sendMail from "../../lib/sendmail";

vi.mock("../../lib/sendmail", () => ({
  default: vi.fn(),
}));

vi.mock("../../components/StellarCheckoutButton", () => ({
  default: () => <div data-testid="stellar-checkout-button" />,
}));

vi.mock("../../components/StellarWalletButton", () => ({
  default: () => <div data-testid="stellar-wallet-button" />,
}));

vi.mock("../../components/StellarOrderWatch", () => ({
  default: () => <div data-testid="stellar-order-watch" />,
}));

const storedCartItems = JSON.stringify([{ id: "checkout-fixture", name: "Test item", price: 100 }]);

function pendingMail() {
  let resolve!: (response: Awaited<ReturnType<typeof sendMail>>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Awaited<ReturnType<typeof sendMail>>>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }
  );
  return { promise, resolve, reject };
}

describe("Checkout page submission states", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    // Checkout hydrates directly from these keys, not from CartContext.
    localStorage.setItem("cartItems", storedCartItems);
    localStorage.setItem("itemCount", "1");
    localStorage.setItem("totalPrice", "100");
  });

  it("disables the stage-1 submit button while sendMail request is in flight", async () => {
    const request = pendingMail();
    vi.mocked(sendMail).mockReturnValueOnce(request.promise);

    const { container } = render(<Checkout />);

    const form = container.querySelector("form")!;
    expect(form).toBeInTheDocument();

    const submitBtn = screen.getByRole("button", { name: /submit/i });
    expect(submitBtn).toBeEnabled();

    // Submit form
    fireEvent.submit(form);

    // Button should now be disabled and show "Submitting..."
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /submitting\.\.\./i })).toBeDisabled();
    });

    // Submitting again while in-flight or clicking
    fireEvent.submit(form);
    expect(sendMail).toHaveBeenCalledTimes(1);

    // Resolve the promise
    request.resolve({ status: 200, text: "OK" });

    // Transitions to stage 2 (Confirm OTP)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();
    });
  });

  it("enables stage-2 confirmation after the OTP email is sent", async () => {
    vi.mocked(sendMail).mockResolvedValueOnce({ status: 200, text: "OK" });

    const { container } = render(<Checkout />);

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    expect(confirmBtn).toBeEnabled();
  });

  it("re-enables submission after a failed email and allows one pending retry", async () => {
    const firstRequest = pendingMail();
    const retry = pendingMail();
    vi.mocked(sendMail)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(retry.promise);

    const { container } = render(<Checkout />);
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: /submitting\.\.\./i })).toBeDisabled();

    firstRequest.reject(new Error("Email service unavailable"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^submit$/i })).toBeEnabled();
    });
    expect(screen.queryByRole("button", { name: /^confirm$/i })).not.toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);

    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: /submitting\.\.\./i })).toBeDisabled();
    fireEvent.submit(form);
    expect(sendMail).toHaveBeenCalledTimes(2);

    retry.resolve({ status: 200, text: "OK" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^confirm$/i })).toBeEnabled();
    });
  });

  it("allows another submission after going back from confirmation", async () => {
    const nextRequest = pendingMail();
    vi.mocked(sendMail)
      .mockResolvedValueOnce({ status: 200, text: "OK" })
      .mockReturnValueOnce(nextRequest.promise);

    const { container } = render(<Checkout />);
    fireEvent.submit(container.querySelector("form")!);
    fireEvent.click(await screen.findByRole("button", { name: /go back/i }));

    expect(screen.getByRole("button", { name: /^submit$/i })).toBeEnabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /submitting\.\.\./i })).toBeDisabled();

    nextRequest.resolve({ status: 200, text: "OK" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^confirm$/i })).toBeEnabled();
    });
  });

  it.each([
    { state: "missing cart", items: null, total: null },
    { state: "empty items with a stale positive total", items: "[]", total: "100" },
    { state: "items with a zero total", items: storedCartItems, total: "0" },
  ])("keeps the empty-cart screen for $state", ({ items, total }) => {
    localStorage.clear();
    if (items !== null) localStorage.setItem("cartItems", items);
    if (total !== null) localStorage.setItem("totalPrice", total);

    const { container } = render(<Checkout />);
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to shop/i })).toHaveAttribute("href", "/shop");
    expect(container.querySelector("form")).not.toBeInTheDocument();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
