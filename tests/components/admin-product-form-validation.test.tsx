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
