import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StellarCheckoutButton from "../../components/StellarCheckoutButton";

const {
  mockConnectWallet,
  mockCurrentAddress,
  mockRegisterMerchantQuoteFromWallet,
  mockPayWithStellar,
  WalletError,
} = vi.hoisted(() => {
  class WalletError extends Error {
    constructor(message, code = "WALLET_ERROR") {
      super(message);
      this.name = "WalletError";
      this.code = code;
    }
  }
  return {
    mockConnectWallet: vi.fn(),
    mockCurrentAddress: vi.fn(),
    mockRegisterMerchantQuoteFromWallet: vi.fn(),
    mockPayWithStellar: vi.fn(),
    WalletError,
  };
});

vi.mock("../../lib/stellar/freighter", () => ({
  connectWallet: (...args) => mockConnectWallet(...args),
  currentAddress: (...args) => mockCurrentAddress(...args),
  WalletError,
}));

vi.mock("../../lib/stellar/quote-client", () => ({
  registerMerchantQuoteFromWallet: (...args) => mockRegisterMerchantQuoteFromWallet(...args),
}));

vi.mock("../../lib/stellar/checkout", () => ({
  payWithStellar: (...args) => mockPayWithStellar(...args),
}));

const ADDR = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const ITEMS = [{ productId: PRODUCT_ID, quantity: 2 }];
const CART_DIGEST = "aa".repeat(32);
const ORDER_ID = `MQ1:${CART_DIGEST}:button-test`;
const TX_HASH = "0123456789abcdef".repeat(4);
const QUOTE = {
  orderId: ORDER_ID,
  orderIdHex: "11".repeat(32),
  cartDigestHex: CART_DIGEST,
  buyer: ADDR,
  tokenContractId: "CUSDC",
  tokenSymbol: "USDC",
  amountRaw: 123_400_000n,
  authValidUntilLedger: 424242,
  transactionXdr: "merchant-authorized-xdr",
  registrationHash: "quote-registration-hash",
};

function successResult(amountUsd = 12.34) {
  return {
    amountUsd,
    amountRaw: QUOTE.amountRaw,
    orderId: ORDER_ID,
    hash: TX_HASH,
    receipt: { ledger: 4242, orderId: QUOTE.orderIdHex, buyer: ADDR },
    simulation: null,
  };
}

function renderButton(props = {}) {
  return render(
    <StellarCheckoutButton items={ITEMS} displayAmountUsd={12.34} {...props} />
  );
}

afterEach(() => {
  vi.resetAllMocks();
  mockCurrentAddress.mockResolvedValue(null);
});

describe("StellarCheckoutButton", () => {
  it("is disabled while the disabled prop is set or there are no quote items", () => {
    mockCurrentAddress.mockResolvedValue(ADDR);
    const { rerender } = renderButton({ disabled: true });
    expect(screen.getByRole("button")).toBeDisabled();

    rerender(<StellarCheckoutButton items={[]} displayAmountUsd={12.34} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("registers an exact merchant quote before attempting payment", async () => {
    mockCurrentAddress.mockResolvedValue(ADDR);
    let resolveQuote;
    mockRegisterMerchantQuoteFromWallet.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuote = resolve;
        })
    );
    mockPayWithStellar.mockResolvedValue(successResult());
    const onQuote = vi.fn();
    const { container } = renderButton({ onQuote });

    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button"));
      await Promise.resolve();
    });

    expect(screen.getByRole("button")).toBeDisabled();
    expect(container.textContent).toContain("Requesting merchant-authorized quote");
    expect(mockRegisterMerchantQuoteFromWallet).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: ADDR, items: ITEMS })
    );
    expect(mockPayWithStellar).not.toHaveBeenCalled();

    await act(async () => {
      resolveQuote(QUOTE);
    });

    expect(onQuote).toHaveBeenCalledWith(QUOTE);
    expect(mockPayWithStellar).toHaveBeenCalledWith(
      expect.objectContaining({ quote: QUOTE, publicKey: ADDR })
    );
  });

  it("connects a missing wallet before requesting the merchant quote", async () => {
    mockCurrentAddress.mockResolvedValue(null);
    mockConnectWallet.mockResolvedValue(ADDR);
    mockRegisterMerchantQuoteFromWallet.mockResolvedValue(QUOTE);
    mockPayWithStellar.mockResolvedValue(successResult());

    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(mockConnectWallet).toHaveBeenCalledOnce();
    expect(mockRegisterMerchantQuoteFromWallet).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: ADDR, items: ITEMS })
    );
    expect(mockPayWithStellar).toHaveBeenCalledWith(
      expect.objectContaining({ quote: QUOTE, publicKey: ADDR })
    );
  });

  it("surfaces a WalletError from connectWallet and never requests or pays a quote", async () => {
    mockCurrentAddress.mockResolvedValue(null);
    mockConnectWallet.mockRejectedValue(
      new WalletError("Freighter extension not found", "FREIGHTER_NOT_FOUND")
    );

    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(screen.getByRole("alert").textContent).toBe("Freighter extension not found");
    expect(mockRegisterMerchantQuoteFromWallet).not.toHaveBeenCalled();
    expect(mockPayWithStellar).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("surfaces merchant quote rejection before payment", async () => {
    mockCurrentAddress.mockResolvedValue(ADDR);
    mockRegisterMerchantQuoteFromWallet.mockRejectedValue(
      new WalletError("Catalog pricing is being synchronized.", "CATALOG_NOT_SYNCHRONIZED")
    );

    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(screen.getByRole("alert").textContent).toBe("Catalog pricing is being synchronized.");
    expect(mockPayWithStellar).not.toHaveBeenCalled();
  });

  it("surfaces a WalletError from payWithStellar after quote registration", async () => {
    mockCurrentAddress.mockResolvedValue(ADDR);
    mockRegisterMerchantQuoteFromWallet.mockResolvedValue(QUOTE);
    mockPayWithStellar.mockRejectedValue(
      new WalletError("Insufficient balance", "WALLET_ERROR")
    );

    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(screen.getByRole("alert").textContent).toBe("Insufficient balance");
  });

  it("renders confirmed merchant order state and calls onQuote/onSuccess", async () => {
    mockCurrentAddress.mockResolvedValue(ADDR);
    mockRegisterMerchantQuoteFromWallet.mockResolvedValue(QUOTE);
    mockPayWithStellar.mockResolvedValue(successResult());
    const onQuote = vi.fn();
    const onSuccess = vi.fn();

    const { container } = renderButton({ onQuote, onSuccess });
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(screen.getByText("Payment confirmed ✓")).toBeTruthy();
    expect(container.textContent).toContain("Paid on ledger 4242");
    const link = screen.getByRole("link");
    expect(link.href).toBe(`https://stellar.expert/explorer/testnet/tx/${TX_HASH}`);
    expect(link.textContent).toBe(`${TX_HASH.slice(0, 12)}…`);
    expect(screen.getByText(`$12.34 USDC · order ${ORDER_ID}`)).toBeTruthy();
    expect(onQuote).toHaveBeenCalledOnce();
    expect(onQuote).toHaveBeenCalledWith(QUOTE);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(successResult());
  });
});
