import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/products", () => ({
  createProduct: vi.fn(),
  getProductById: vi.fn(),
  updateProduct: vi.fn(),
  uploadProductImage: vi.fn(),
}));

import AddProductForm from "../../app/admin/AddProductForm";
import EditProductForm from "../../app/admin/EditProductForm";
import {
  createProduct,
  getProductById,
  updateProduct,
  uploadProductImage,
} from "../../lib/products";
import { validatePrice } from "../../lib/validation";

const createProductMock = vi.mocked(createProduct);
const getProductByIdMock = vi.mocked(getProductById);
const updateProductMock = vi.mocked(updateProduct);
const uploadProductImageMock = vi.mocked(uploadProductImage);

function attachImage(container: HTMLElement, name = "shoe.png") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["image-bytes"], name, { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe("product price validation", () => {
  it.each([
    ["0", "0.00"],
    ["12.5", "12.50"],
    ["12.50", "12.50"],
    ["1000000", "1000000.00"],
    [12.5, "12.50"],
  ])("accepts cent-precision price %s", (price, sanitized) => {
    expect(validatePrice(price)).toEqual({ isValid: true, sanitized });
  });

  it.each(["12junk", "Infinity", "NaN", "12.345", "1e3", Infinity, NaN])(
    "rejects malformed or non-finite price %s",
    (price) => {
      expect(validatePrice(price)).toEqual({
        isValid: false,
        error: "Please enter a valid price",
      });
    }
  );
});

describe("admin product form validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadProductImageMock.mockResolvedValue("https://cdn.example.test/product.png");
    createProductMock.mockResolvedValue({ id: "new-product" } as never);
    updateProductMock.mockResolvedValue({ id: "product-1" } as never);
    getProductByIdMock.mockResolvedValue({
      id: "product-1",
      name: "Existing Product",
      price: 25,
      img: "https://cdn.example.test/existing.png",
    } as never);
  });

  it("rejects a negative add-product price before upload or persistence", async () => {
    const onProductAdded = vi.fn();
    const { container } = render(<AddProductForm onProductAdded={onProductAdded} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Running Shoe" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-1" } });
    attachImage(container);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(await screen.findByText("Price cannot be negative")).toBeInTheDocument();
    expect(uploadProductImageMock).not.toHaveBeenCalled();
    expect(createProductMock).not.toHaveBeenCalled();
    expect(onProductAdded).not.toHaveBeenCalled();
  });

  it.each(["12junk", "Infinity", "12.345"])(
    "rejects invalid add-product price %s before upload or persistence",
    async (price) => {
      const onProductAdded = vi.fn();
      const { container } = render(<AddProductForm onProductAdded={onProductAdded} />);

      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Running Shoe" },
      });
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: price } });
      attachImage(container);
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);

      expect(await screen.findByText("Please enter a valid price")).toBeInTheDocument();
      expect(uploadProductImageMock).not.toHaveBeenCalled();
      expect(createProductMock).not.toHaveBeenCalled();
      expect(onProductAdded).not.toHaveBeenCalled();
    }
  );

  it("submits sanitized product values on the valid add-product path", async () => {
    const onProductAdded = vi.fn();
    const { container } = render(<AddProductForm onProductAdded={onProductAdded} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Running Shoe  " },
    });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12.5" } });
    const file = attachImage(container);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => {
      expect(createProductMock).toHaveBeenCalledWith({
        name: "Running Shoe",
        price: 12.5,
        img: "https://cdn.example.test/product.png",
      });
    });
    expect(uploadProductImageMock).toHaveBeenCalledWith(file);
    expect(onProductAdded).toHaveBeenCalledTimes(1);
  });

  it("rejects a negative edit-product price before replacement upload or persistence", async () => {
    const onProductUpdated = vi.fn();
    const { container } = render(
      <EditProductForm productId="product-1" onProductUpdated={onProductUpdated} />
    );

    await screen.findByDisplayValue("Existing Product");
    attachImage(container, "replacement.png");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-5" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(await screen.findByText("Price cannot be negative")).toBeInTheDocument();
    expect(uploadProductImageMock).not.toHaveBeenCalled();
    expect(updateProductMock).not.toHaveBeenCalled();
    expect(onProductUpdated).not.toHaveBeenCalled();
  });
});
