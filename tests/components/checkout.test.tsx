import { beforeEach, describe, expect, fireEvent, render, screen, vi, waitFor } from "vitest";
import React from "react";

import Checkout from "../../app/checkout/page";
import sendMail from "../../lib/sendmail";

vi.mock("../../lib/sendmail", () => ({
  default: vi.fn(),
}));

vi.mock("../../components/StellarCheckoutButton", () => ({
  default: ({ onSuccess }: { onSuccess: (result: { amountUsd: number }) => void }) => (
    <button type="button" data-testid="stellar-checkout-button" onClick={() => onSuccess({ amountUsd: 100 })}>
      Mock Stellar payment
    </button>
  ),
}));

vi.mock("../../components/StellarWalletButton", () => ({
  default: () => <div data-testid="stellar-wallet-button" />,
}));

vi.mock("../../components/StellarOrderWatch", () => ({
  default: ({ onEvent }: { onEvent: () => void }) => (
    <button type="button" data-testid="stellar-order-watch" onClick={onEvent}>
      Mock on-chain payment
    </button>
  ),
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

function fillContactDetails() {
  fireEvent.change(screen.getByLabelText("First Name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Last Name"), { target: { value: "Lovelace" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "Ada@example.com" } });
  fireEvent.change(screen.getByLabelText("Address"), { target: { value: "123 Main Street" } });
}

async function advanceToVerification() {
  vi.mocked(sendMail).mockResolvedValueOnce({ status: 200, text: "OK" });
  render(<Checkout />);
  fillContactDetails();
  fireEvent.click(screen.getByRole("button", { name: /send verification code/i }));
  await screen.findByRole("button", { name: /^verify email$/i });
}

async function advanceToPayment() {
  await advanceToVerification();
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "000042" } });
  fireEvent.click(screen.getByRole("button", { name: /^verify email$/i }));
  await screen.findByTestId("stellar-checkout-button");
}

describe("Checkout paid-completion integrity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Math, "random").mockReturnValue(0.000042);
    localStorage.clear();
    localStorage.setItem("cartItems", storedCartItems);
    localStorage.setItem("itemCount", "1");
    localStorage.setItem("totalPrice", "100");
  });

  it("does not collect raw card credentials or expose payment before contact verification", () => {
    render(<Checkout />);

    expect(screen.queryByLabelText(/card number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cvv/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not collect card numbers or CVVs/i)).toBeInTheDocument();
    expect(screen.queryByTestId("stellar-checkout-button")).not.toBeInTheDocument();
    expect(screen.queryByText(/payment confirmed/i)).not.toBeInTheDocument();
  });

  it("keeps the cart intact while the verification email is in flight", async () => {
    const request = pendingMail();
    vi.mocked(sendMail).mockReturnValueOnce(request.promise);

    render(<Checkout />);
    fillContactDetails();
    fireEvent.click(screen.getByRole("button", { name: /send verification code/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sending verification code/i })).toBeDisabled();
    });
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
    expect(screen.queryByTestId("stellar-checkout-button")).not.toBeInTheDocument();

    request.resolve({ status: 200, text: "OK" });
    await screen.findByRole("button", { name: /^verify email$/i });
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
  });

  it("treats a correct OTP as contact verification, not payment", async () => {
    await advanceToPayment();

    expect(screen.getByText(/amount due: \$100\.00/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment confirmed\./i)).not.toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
    expect(localStorage.getItem("itemCount")).toBe("1");
    expect(localStorage.getItem("totalPrice")).toBe("100");
  });

  it("clears the cart and shows completion only after Stellar payment success", async () => {
    await advanceToPayment();

    fireEvent.click(screen.getByTestId("stellar-checkout-button"));

    expect(await screen.findByRole("heading", { name: /payment confirmed/i })).toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBeNull();
    expect(localStorage.getItem("itemCount")).toBeNull();
    expect(localStorage.getItem("totalPrice")).toBeNull();
  });

  it("accepts the matching on-chain order event as an authoritative payment receipt", async () => {
    await advanceToPayment();

    fireEvent.click(screen.getByTestId("stellar-order-watch"));

    expect(await screen.findByRole("heading", { name: /payment confirmed/i })).toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBeNull();
  });

  it("keeps checkout at contact details when sending verification fails", async () => {
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("mail unavailable"));
    render(<Checkout />);
    fillContactDetails();

    fireEvent.click(screen.getByRole("button", { name: /send verification code/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /send verification code/i })).toBeEnabled();
    });
    expect(screen.queryByRole("button", { name: /^verify email$/i })).not.toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
  });

  it.each([
    { state: "missing cart", items: null, total: null },
    { state: "empty items with a stale positive total", items: "[]", total: "100" },
    { state: "items with a zero total", items: storedCartItems, total: "0" },
    { state: "items with a malformed total", items: storedCartItems, total: "not-a-number" },
  ])("keeps the empty-cart screen for $state", ({ items, total }) => {
    localStorage.clear();
    if (items !== null) localStorage.setItem("cartItems", items);
    if (total !== null) localStorage.setItem("totalPrice", total);

    render(<Checkout />);
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to shop/i })).toHaveAttribute("href", "/shop");
    expect(sendMail).not.toHaveBeenCalled();
  });
});
