import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, vi } from "vitest";
import React from "react";

import Checkout from "../../app/checkout/page";
import sendMail from "../../lib/sendmail";

vi.mock("../../lib/sendmail", () => ({ default: vi.fn() }));

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const CART_DIGEST = "aa".repeat(32);
const MERCHANT_QUOTE = {
  orderId: `MQ1:${CART_DIGEST}:checkout-test`,
  orderIdHex: "11".repeat(32),
  cartDigestHex: CART_DIGEST,
  buyer: "GBUYER",
  tokenContractId: "CUSDC",
  tokenSymbol: "USDC",
  amountRaw: BigInt("1000000000"),
  authValidUntilLedger: 123456,
  transactionXdr: "test-xdr",
  registrationHash: "quote-registration",
};

vi.mock("../../components/StellarCheckoutButton", () => ({
  default: ({ onQuote, onSuccess }: any) => (
    <>
      <button type="button" data-testid="stellar-quote-button" onClick={() => onQuote(MERCHANT_QUOTE)}>
        Mock merchant quote
      </button>
      <button
        type="button"
        data-testid="stellar-checkout-button"
        onClick={() => {
          onQuote(MERCHANT_QUOTE);
          onSuccess({ amountUsd: 100, orderId: MERCHANT_QUOTE.orderId });
        }}
      >
        Mock Stellar payment
      </button>
    </>
  ),
}));

vi.mock("../../components/StellarWalletButton", () => ({
  default: () => <div data-testid="stellar-wallet-button" />,
}));

vi.mock("../../components/StellarOrderWatch", () => ({
  default: ({ onEvent }: any) => (
    <button type="button" data-testid="stellar-order-watch" onClick={onEvent}>
      Mock on-chain payment
    </button>
  ),
}));

const storedCartItems = JSON.stringify([
  { id: PRODUCT_ID, name: "Test item", price: 100, cartItemId: "cart-1" },
]);

function pendingMail() {
  let resolve!: (response: Awaited<ReturnType<typeof sendMail>>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Awaited<ReturnType<typeof sendMail>>>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fillContactDetails() {
  fireEvent.change(screen.getByLabelText("First Name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Last Name"), { target: { value: "Lovelace" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@sample.invalid" } });
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

describe("Checkout merchant-quoted paid completion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sendMail).mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0.000042);
    localStorage.clear();
    localStorage.setItem("cartItems", storedCartItems);
    localStorage.setItem("itemCount", "1");
    localStorage.setItem("totalPrice", "100");
  });

  it("does not expose payment before contact verification", () => {
    render(<Checkout />);
    expect(screen.queryByLabelText(/card number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cvv/i)).not.toBeInTheDocument();
    expect(screen.getByText(/does not collect card numbers or CVVs/i)).toBeInTheDocument();
    expect(screen.queryByTestId("stellar-checkout-button")).not.toBeInTheDocument();
  });

  it("keeps the cart intact while verification email is in flight", async () => {
    const request = pendingMail();
    vi.mocked(sendMail).mockReturnValueOnce(request.promise);
    render(<Checkout />);
    fillContactDetails();
    fireEvent.click(screen.getByRole("button", { name: /send verification code/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /sending verification code/i })).toBeDisabled());
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
    request.resolve({ status: 200, text: "OK" });
    await screen.findByRole("button", { name: /^verify email$/i });
  });

  it("treats OTP as contact verification, not payment authority", async () => {
    await advanceToPayment();
    expect(screen.getByText(/estimated cart subtotal: \$100\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/amount due and order ID are minted from the merchant-authorized quote/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment confirmed\./i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("stellar-order-watch")).not.toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
  });

  it("clears the cart only after payment success and displays merchant order id", async () => {
    await advanceToPayment();
    fireEvent.click(screen.getByTestId("stellar-checkout-button"));
    expect(await screen.findByRole("heading", { name: /payment confirmed/i })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(MERCHANT_QUOTE.orderId))).toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBeNull();
    expect(localStorage.getItem("itemCount")).toBeNull();
    expect(localStorage.getItem("totalPrice")).toBeNull();
  });

  it("arms recovery only after merchant quote exists", async () => {
    await advanceToPayment();
    expect(screen.queryByTestId("stellar-order-watch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("stellar-quote-button"));
    const watcher = await screen.findByTestId("stellar-order-watch");
    fireEvent.click(watcher);
    expect(await screen.findByRole("heading", { name: /payment confirmed/i })).toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBeNull();
  });

  it("stays at contact details when verification send fails", async () => {
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("mail unavailable"));
    render(<Checkout />);
    fillContactDetails();
    fireEvent.click(screen.getByRole("button", { name: /send verification code/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /send verification code/i })).toBeEnabled());
    expect(screen.queryByRole("button", { name: /^verify email$/i })).not.toBeInTheDocument();
    expect(localStorage.getItem("cartItems")).toBe(storedCartItems);
  });

  it.each([
    { state: "missing cart", items: null, total: null },
    { state: "empty items with stale positive total", items: "[]", total: "100" },
  ])("keeps empty-cart screen for $state", ({ items, total }) => {
    localStorage.clear();
    if (items !== null) localStorage.setItem("cartItems", items);
    if (total !== null) localStorage.setItem("totalPrice", total);
    render(<Checkout />);
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each(["0", "not-a-number"])("does not let browser total %s suppress a real cart", (total) => {
    localStorage.setItem("totalPrice", total);
    render(<Checkout />);
    expect(screen.queryByRole("heading", { name: "Your cart is empty" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contact details" })).toBeInTheDocument();
  });
});
