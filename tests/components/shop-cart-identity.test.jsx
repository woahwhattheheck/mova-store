import React, { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import Products from "../../app/shop/page";
import ProductPage from "../../app/shop/[id]/page";
import { CartProvider } from "../../context/CartContext";

vi.mock("../../lib/products", () => ({
  listProducts: vi.fn().mockResolvedValue([]),
  getProductById: vi.fn().mockResolvedValue(null),
}));

const product = { id: "duplicate", name: "Test shoe", price: 25, img: "/shoe.png" };

describe.each([
  ["shop", () => <Products />],
  ["product detail", () => <ProductPage params={Promise.resolve({ id: product.id })} />],
])("%s cart row identity", (_name, page) => {
  let errors;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "cartItems",
      JSON.stringify([
        { ...product, cartItemId: "first-line" },
        { ...product, cartItemId: "second-line" },
      ])
    );
    localStorage.setItem("itemCount", "2");
    localStorage.setItem("totalPrice", "50");
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    errors.mockRestore();
  });

  it.each([0, 1])("preserves the surviving DOM row when removing duplicate %i", async (index) => {
    await act(async () => {
      render(
        <CartProvider>
          <Suspense fallback={<p>Loading product route</p>}>{page()}</Suspense>
        </CartProvider>
      );
    });
    if (_name === "product detail") {
      await screen.findByText("Error: Product not found");
    } else {
      await screen.findByText("Welcome to Mova Store");
    }
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    const buttons = screen.getAllByRole("button", { name: "Remove" });
    expect(buttons).toHaveLength(2);
    const survivor = buttons[1 - index].parentElement;
    fireEvent.click(buttons[index]);

    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove" }).parentElement).toBe(survivor);
    const saved = JSON.parse(localStorage.getItem("cartItems"));
    expect(saved.map((item) => item.cartItemId)).toEqual([
      index === 0 ? "second-line" : "first-line",
    ]);
    expect(localStorage.getItem("itemCount")).toBe("1");
    expect(localStorage.getItem("totalPrice")).toBe("25");
    expect(
      errors.mock.calls.filter((args) =>
        args.some((arg) => typeof arg === "string" && arg.includes("same key"))
      )
    ).toEqual([]);
  });
});
